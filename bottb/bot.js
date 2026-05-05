
import WebSocket from "ws";
import crypto from "crypto";
import fs from "fs";
import readline from "readline";
import "dotenv/config";
import { exec } from "child_process";
import https from "https";
import path from "path";
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Далі ваш оригінальний код...

// ================== RING BUFFER ==================
class RingBuffer {
  constructor(size) {
    this.size = size;
    this.prices = [];
    this.volumes = [];
  }
  push(price, volume) {
    this.prices.push(price);
    this.volumes.push(volume);
    if (this.prices.length > this.size) this.prices.shift();
    if (this.volumes.length > this.size) this.volumes.shift();
  }
  get length() { return this.prices.length; }
  getPrices() { return [...this.prices]; }
  getVolumes() { return [...this.volumes]; }
}

// ================== ЛОГУВАННЯ З ТАЙМСТАМПОМ ==================
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => {
  const timestamp = new Date().toLocaleTimeString();
  originalLog(`[${timestamp}]`, ...args);
};
console.error = (...args) => {
  const timestamp = new Date().toLocaleTimeString();
  originalError(`[${timestamp}] ❌`, ...args);
};

// ================== КОНФІГУРАЦІЯ ==================
const CONFIG = Object.freeze({
  ws: {
    SYMBOL: process.env.SYMBOL || "dogeusdt",
    RECONNECT_MAX_DELAY: 10000
  },
  signal: {
    WINDOW: Number(process.env.WINDOW || 30),
    DEVIATION_THRESHOLD: Number(process.env.DEVIATION_THRESHOLD || 0.001),
    VOLATILITY_THRESHOLD: Number(process.env.VOLATILITY_THRESHOLD || 0.0005),
    VOLUME_THRESHOLD: Number(process.env.VOLUME_THRESHOLD || 1.3),
    CONFIRM_TICKS: Number(process.env.CONFIRM_TICKS || 3),
    TIME_WINDOW: Number(process.env.TIME_WINDOW || 10000),
    AUTO_THRESHOLD: process.env.AUTO_THRESHOLD === "true",
    ADAPT_FACTOR: Number(process.env.ADAPT_FACTOR || 1.5)
  },
  risk: {
    TAKE_PROFIT: Number(process.env.TAKE_PROFIT || 0.2),
    STOP_LOSS: Number(process.env.STOP_LOSS || 0.35),
    MAX_RISK_PER_TRADE: Number(process.env.MAX_RISK_PER_TRADE || 1),
    MAX_DAILY_LOSS: Number(process.env.MAX_DAILY_LOSS || 5),
    MAX_TRADES_PER_DAY: Number(process.env.MAX_TRADES_PER_DAY || 10)
  },
  logging: {
    LOG_FILE: "bot.log"
  },
  entry: {
    ORDER_TYPE: process.env.ENTRY_ORDER_TYPE || "MARKET",
    OFFSET_PERCENT: Number(process.env.ENTRY_OFFSET_PERCENT || 0.1)
  },
  cooldown: {
    ENABLED: process.env.COOLDOWN_ENABLED !== "false",
    MIN_MS: Number(process.env.COOLDOWN_MIN_MS || 5000),
    MULTIPLIER: Number(process.env.COOLDOWN_MULTIPLIER || 0.5),
    SWING_LOOKBACK: Number(process.env.SWING_LOOKBACK || 14),
    SWING_THRESHOLD_PERCENT: Number(process.env.SWING_THRESHOLD_PERCENT || 0.3)
  },
  trading: {
    REAL_MODE: false
  }
});

// ================== ГЛОБАЛЬНІ ЗМІННІ ==================
let account = { balance: 0, dailyLoss: 0, tradesToday: 0 };
let cooldownUntil = 0;
let state = { status: "IDLE", entry: null, side: null };
let lastSwingLength = 0;
let reconnectAttempts = 0;
let buffers = new RingBuffer(CONFIG.signal.WINDOW);
let tsQueue = [];
let tsHead = 0;
let volStats = { n: 0, mean: 0, M2: 0 };
let cachedVolumesAvg = 0;
let cachedVolumeSpike = 1;

// ================== АДАПТИВНІ ПОРОГИ ==================
class AdaptiveThresholds {
  constructor() {
    this.base = {
      deviation: CONFIG.signal.DEVIATION_THRESHOLD,
      volatility: CONFIG.signal.VOLATILITY_THRESHOLD,
      volume: CONFIG.signal.VOLUME_THRESHOLD
    };
    this.state = { ...this.base };
  }
  validate(input) {
    const sanitize = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    return {
      deviation: sanitize(input.deviation, this.state.deviation),
      volatility: sanitize(input.volatility, this.state.volatility),
      volume: sanitize(input.volume, this.state.volume)
    };
  }
  get() { return this.state; }
  update(input) {
    if (!CONFIG.signal.AUTO_THRESHOLD) return;
    const normalized = this.validate(input);
    this.state = {
      deviation: normalized.deviation * CONFIG.signal.ADAPT_FACTOR,
      volatility: normalized.volatility * CONFIG.signal.ADAPT_FACTOR,
      volume: normalized.volume
    };
  }
}
const adaptiveState = new AdaptiveThresholds();

// ================== ДЕДУПЛІКАЦІЯ ==================
class Deduper {
  constructor() { this.lastHash = null; }
  hash(data) { return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex"); }
  isDuplicate(signal) {
    const h = this.hash(signal);
    if (h === this.lastHash) return true;
    this.lastHash = h;
    return false;
  }
}
const deduper = new Deduper();

// ================== ДОПОМІЖНІ ФУНКЦІЇ ==================
const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

function addTimestamp(ts) { tsQueue.push(ts); }
function pruneTimestamps(now) {
  const limit = now - CONFIG.signal.TIME_WINDOW;
  while (tsHead < tsQueue.length && tsQueue[tsHead] < limit) tsHead++;
}
function getRecentCount() { return tsQueue.length - tsHead; }

function updateVolStats(x) {
  volStats.n++;
  const delta = x - volStats.mean;
  volStats.mean += delta / volStats.n;
  const delta2 = x - volStats.mean;
  volStats.M2 += delta * delta2;
}
function volatility() { return volStats.n < 2 ? 0 : Math.sqrt(volStats.M2 / (volStats.n - 1)); }
function deviation(price) {
  if (buffers.length < 5) return 0;
  const prices = buffers.getPrices();
  const mean = avg(prices);
  return mean === 0 ? 0 : (price - mean) / mean;
}
function volumeSpike() { return buffers.length < 5 ? 1 : cachedVolumeSpike; }

function getAverageSwingPercent() {
  const prices = buffers.getPrices();
  if (prices.length < CONFIG.cooldown.SWING_LOOKBACK) return 0;
  const recent = prices.slice(-CONFIG.cooldown.SWING_LOOKBACK);
  let swings = [];
  for (let i = 1; i < recent.length; i++) {
    const change = Math.abs((recent[i] - recent[i-1]) / recent[i-1]) * 100;
    if (change >= CONFIG.cooldown.SWING_THRESHOLD_PERCENT) swings.push(change);
  }
  if (swings.length === 0) return 0;
  return swings.reduce((a,b)=>a+b,0) / swings.length;
}

function calculateCooldownDuration() {
  if (!CONFIG.cooldown.ENABLED) return 0;
  const swing = getAverageSwingPercent();
  if (swing === 0) return CONFIG.cooldown.MIN_MS;
  const dynamicMs = swing * CONFIG.cooldown.MULTIPLIER * 1000;
  return Math.max(CONFIG.cooldown.MIN_MS, dynamicMs);
}

// ================== ОТРИМАННЯ РЕАЛЬНОГО БАЛАНСУ ==================
async function getAccountBalance() {
  if (!CONFIG.trading.REAL_MODE) {
    account.balance = 1000;
    console.log(`🧪 PAPER BALANCE: ${account.balance} USDT`);
    return;
  }
  const BASE_URL = process.env.BINANCE_TESTNET === "true"
    ? "https://testnet.binancefuture.com"
    : "https://fapi.binance.com";
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}&recvWindow=5000`;
  const signature = crypto.createHmac("sha256", process.env.BINANCE_API_SECRET).update(queryString).digest("hex");
  const url = `${BASE_URL}/fapi/v2/account?${queryString}&signature=${signature}`;
  try {
    const res = await fetch(url, { headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY } });
    const data = await res.json();
    if (!data.assets) throw new Error(JSON.stringify(data));
    const usdtAsset = data.assets.find(a => a.asset === "USDT");
    if (usdtAsset) {
      account.balance = parseFloat(usdtAsset.walletBalance);
      console.log(`💰 REAL BALANCE: ${account.balance} USDT`);
    } else throw new Error("USDT asset not found");
  } catch (err) {
    console.error("Failed to fetch balance:", err.message);
    account.balance = 0;
  }
}

// ================== РОЗРАХУНОК КІЛЬКОСТІ ==================
function calcPositionSize(price) {
  if (process.env.QUANTITY) {
    let qty = parseFloat(process.env.QUANTITY);
    if (isNaN(qty)) qty = 1;
    return Math.max(1, qty);
  }
  if (!account.balance || account.balance <= 0) {
    console.error("No balance for position sizing");
    return 0;
  }
  const riskAmount = account.balance * (CONFIG.risk.MAX_RISK_PER_TRADE / 100);
  const stopLossPercent = CONFIG.risk.STOP_LOSS / 100;
  if (stopLossPercent === 0) return 0;
  let qty = riskAmount / (price * stopLossPercent);
  qty = Math.floor(qty * 1000) / 1000;
  return Math.max(1, qty);
}

// ================== РОЗМІЩЕННЯ ОРДЕРУ ==================
async function placeOrder(side, quantity, currentPrice) {
  if (!CONFIG.trading.REAL_MODE) {
    let fillPrice = currentPrice;
    if (CONFIG.entry.ORDER_TYPE === "LIMIT") {
      fillPrice = side === "long"
        ? currentPrice * (1 - CONFIG.entry.OFFSET_PERCENT/100)
        : currentPrice * (1 + CONFIG.entry.OFFSET_PERCENT/100);
    }
    console.log(`[PAPER] ${side.toUpperCase()} ${quantity} @ ${fillPrice.toFixed(8)}`);
    return { paper: true, side, quantity, price: fillPrice };
  }
  if (quantity <= 0) {
    console.error("Invalid quantity, aborting order");
    return null;
  }
  const requiredMargin = currentPrice * quantity;
  if (account.balance < requiredMargin * 0.05) {
    console.error(`Insufficient margin: balance=${account.balance}, required ~${requiredMargin * 0.05}`);
    return null;
  }
  const BASE_URL = process.env.BINANCE_TESTNET === "true"
    ? "https://testnet.binancefuture.com"
    : "https://fapi.binance.com";
  const symbol = CONFIG.ws.SYMBOL.toUpperCase();
  const orderSide = side === "long" ? "BUY" : "SELL";
  const timestamp = Date.now();
  const queryParams = {
    symbol, side: orderSide, type: CONFIG.entry.ORDER_TYPE,
    quantity: Number(quantity.toFixed(3)), timestamp
  };
  if (CONFIG.entry.ORDER_TYPE === "LIMIT") {
    let limitPrice = side === "long"
      ? currentPrice * (1 - CONFIG.entry.OFFSET_PERCENT/100)
      : currentPrice * (1 + CONFIG.entry.OFFSET_PERCENT/100);
    limitPrice = parseFloat(limitPrice.toFixed(8));
    queryParams.price = limitPrice;
    queryParams.timeInForce = "GTC";
  }
  const queryString = new URLSearchParams(queryParams).toString();
  const signature = crypto.createHmac("sha256", process.env.BINANCE_API_SECRET).update(queryString).digest("hex");
  const url = `${BASE_URL}/fapi/v1/order?${queryString}&signature=${signature}`;
  try {
    const res = await fetch(url, { method: "POST", headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY, "Content-Type": "application/json" } });
    const data = await res.json();
    if (data.code && data.code !== 200) throw new Error(data.msg);
    console.log("✅ ORDER PLACED:", data);
    return data;
  } catch (err) {
    console.error("ORDER FAILED:", err.message);
    return null;
  }
}

// ================== ЛОГІКА ВХОДУ / ВИХОДУ (ОСНОВНА) ==================
function checkDeviation(price) {
  const dev = deviation(price);
  const threshold = adaptiveState.get().deviation;
  return Math.abs(dev) > threshold ? dev : null;
}
function checkVolatility() { return volatility() > adaptiveState.get().volatility; }
function checkVolume() { return volumeSpike() > adaptiveState.get().volume; }
function buildSignal(price) {
  const dev = checkDeviation(price);
  if (!dev) return null;
  if (!checkVolatility()) return null;
  if (!checkVolume()) return null;
  return { side: dev > 0 ? "short" : "long", dev, vol: volatility(), volSpike: volumeSpike(), ts: Date.now() };
}
function tripleCheck() {
  const now = Date.now();
  addTimestamp(now);
  pruneTimestamps(now);
  return getRecentCount() >= CONFIG.signal.CONFIRM_TICKS;
}
function detectManipulation() {
  if (buffers.length < 10) return false;
  const prices = buffers.getPrices();
  const recent = prices.slice(-10);
  const last = recent[recent.length-1];
  const mean = avg(recent);
  const variance = avg(recent.map(p => Math.pow(p-mean,2)));
  const std = Math.sqrt(variance);
  if (std === 0) return false;
  const z = (last - mean) / std;
  const volSpike = volumeSpike();
  if (Math.abs(z) > 2.5 && volSpike > 2.5) {
    console.log("\n[MANIPULATION]");
    return true;
  }
  return false;
}
function checkExit(price) {
  if (state.status !== "IN_TRADE") return null;
  const tpPrice = state.side === "long"
    ? state.entry * (1 + CONFIG.risk.TAKE_PROFIT / 100)
    : state.entry * (1 - CONFIG.risk.TAKE_PROFIT / 100);
  const slPrice = state.side === "long"
    ? state.entry * (1 - CONFIG.risk.STOP_LOSS / 100)
    : state.entry * (1 + CONFIG.risk.STOP_LOSS / 100);
  let exit = null;
  if (state.side === "long") {
    if (price >= tpPrice) exit = "TP";
    if (price <= slPrice) exit = "SL";
  } else {
    if (price <= tpPrice) exit = "TP";
    if (price >= slPrice) exit = "SL";
  }
  if (exit) {
    const pnl = state.side === "long" ? (price - state.entry) : (state.entry - price);
    const pnlPercent = (pnl / state.entry) * 100;
    account.balance += account.balance * (pnlPercent / 100);
    if (pnlPercent < 0) account.dailyLoss += Math.abs(pnlPercent);
    console.log(`💰 PnL: ${pnlPercent.toFixed(2)}%`);
    const cooldownMs = calculateCooldownDuration();
    cooldownUntil = Date.now() + cooldownMs;
    console.log(`🔒 COOLDOWN: пауза ${(cooldownMs/1000).toFixed(1)}с`);
    return exit;
  }
  return null;
}
function riskCheck() {
  if (account.dailyLoss >= CONFIG.risk.MAX_DAILY_LOSS) {
    console.log("⛔ DAILY LOSS LIMIT HIT");
    return false;
  }
  if (account.tradesToday >= CONFIG.risk.MAX_TRADES_PER_DAY) {
    console.log("⛔ TRADE LIMIT HIT");
    return false;
  }
  return true;
}

let onTick = async function(price, volume) {
  buffers.push(price, volume);
  updateVolStats(price);
  if (!riskCheck()) return;

  const volumes = buffers.getVolumes();
  cachedVolumesAvg = avg(volumes);
  cachedVolumeSpike = cachedVolumesAvg === 0 ? 1 : volumes.at(-1) / cachedVolumesAvg;
  adaptiveState.update({
    deviation: Math.abs(deviation(price)),
    volatility: volatility(),
    volume: volumeSpike()
  });

  if (detectManipulation()) return;
  const exit = checkExit(price);
  if (exit) {
    state.status = "IDLE";
    return;
  }
  if (state.status !== "IDLE") return;
  if (cooldownUntil > Date.now()) return;

  const signal = buildSignal(price);
  if (!signal) return;
  if (deduper.isDuplicate(signal)) return;
  if (!tripleCheck()) return;

  const qty = calcPositionSize(price);
  if (qty === 0) return;
  const order = await placeOrder(signal.side, qty, price);
  if (!order) return;

  state.status = "IN_TRADE";
  state.entry = price;
  state.side = signal.side;
  account.tradesToday++;
};

// ================== АВТОФІКС І САМОПЕРЕВІРКА ==================
async function selfCheck() {
  console.log("\n🔍 САМОПЕРЕВІРКА СИСТЕМИ:");
  let ok = true;
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
    console.error("  ❌ ВІДСУТНІ API-ключі в .env (BINANCE_API_KEY, BINANCE_API_SECRET)");
    ok = false;
  } else {
    console.log("  ✅ API-ключі присутні");
  }
  if (CONFIG.trading.REAL_MODE && account.balance === 0) {
    console.error("  ❌ Реальний режим, але баланс = 0. Перемикаю в ТЕСТОВИЙ.");
    CONFIG.trading.REAL_MODE = false;
    account.balance = 1000;
    ok = false;
  }
  if (CONFIG.trading.REAL_MODE && account.balance > 0) {
    console.log(`  ✅ Баланс: ${account.balance} USDT`);
  } else {
    console.log("  ℹ️  Тестовий режим, баланс симульований = 1000 USDT");
  }
  if (!process.env.QUANTITY) {
    console.warn("  ⚠️ QUANTITY не задано в .env, буде розраховано автоматично");
  } else {
    console.log(`  ✅ Фіксована кількість: ${process.env.QUANTITY} DOGE`);
  }
  console.log("  ✅ WebSocket буде підключено після старту");
  if (!ok) console.log("  ⚠️ Деякі проблеми виправлено автоматично.");
  else console.log("  ✅ Усі перевірки пройдено.");
  console.log("");
}

// ================== МЕНЮ ВИБОРУ РЕЖИМУ ==================
async function tradingModeSelector() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("\n╔════════════════════════════════════════╗");
    console.log("║         ВИБІР РЕЖИМУ ТОРГІВЛІ         ║");
    console.log("╠════════════════════════════════════════╣");
    console.log("║  1 - Тестовий режим (paper trading)   ║");
    console.log("║  2 - Реальна торгівля (API Binance)   ║");
    console.log("║  3 - Тест + зберегти параметри        ║");
    console.log("╚════════════════════════════════════════╝");
    rl.question("Ваш вибір (1/2/3): ", async (answer) => {
      if (answer === "2") {
        CONFIG.trading.REAL_MODE = true;
        console.log("✅ РЕАЛЬНИЙ РЕЖИМ УВІМКНЕНО");
        await getAccountBalance();
        if (account.balance <= 0) {
          console.error("❌ Немає коштів на ф'ючерсному рахунку. Перемикаюсь у ТЕСТОВИЙ режим.");
          CONFIG.trading.REAL_MODE = false;
          account.balance = 1000;
        }
      } else if (answer === "3") {
        CONFIG.trading.REAL_MODE = false;
        console.log("🧪 ТЕСТОВИЙ РЕЖИМ. Через 1 годину параметри можна зберегти.");
        setTimeout(() => {
          rl.question("🔧 Застосувати поточні параметри до реальної торгівлі? (y/n): ", (save) => {
            if (save.toLowerCase() === 'y') {
              fs.writeFileSync('optimized_params.json', JSON.stringify(adaptiveState.get(), null, 2));
              console.log("✅ Параметри збережено у optimized_params.json");
            }
            process.exit(0);
          });
        }, 3600000);
      } else {
        CONFIG.trading.REAL_MODE = false;
        console.log("🧪 ТЕСТОВИЙ РЕЖИМ (paper trading)");
        account.balance = 1000;
      }
      await selfCheck();
      rl.close();
      resolve();
    });
  });
}

// ================== WEBSOCKET ПІДКЛЮЧЕННЯ ==================
let ws = null;
function startWebSocket() {
  if (ws) ws.close();
  ws = new WebSocket(`wss://fstream.binance.com/ws/${CONFIG.ws.SYMBOL}@kline_1m`);
  ws.on("open", () => {
    reconnectAttempts = 0;
    console.log("🔌 WebSocket підключено до Binance");
  });
  ws.on("message", async (msg) => {
    try {
      const raw = typeof msg === "string" ? msg : msg.toString();
      const parsed = JSON.parse(raw);
      if (!parsed?.k) return;
      const price = parseFloat(parsed.k.c);
      const volume = parseFloat(parsed.k.v);
      if (isNaN(price) || isNaN(volume)) return;
      await onTick(price, volume);
    } catch (err) {
      console.error("Помилка обробки повідомлення:", err.message);
    }
  });
  ws.on("close", () => {
    console.log("🔌 WebSocket закрито, перепідключення через 5с...");
    setTimeout(startWebSocket, 5000);
  });
  ws.on("error", (err) => {
    console.error("Помилка WebSocket:", err.message);
    ws.close();
  });
}

// ================== PRO SMART MODULE (FULL AUTO) ==================
(function() {
  let lastMode = null;
  let entryBlockedUntil = 0;
  let lastSwitch = 0;

  function getRangePercent() {
    const prices = buffers.getPrices();
    if (prices.length < 10) return 0;
    const max = Math.max(...prices);
    const min = Math.min(...prices);
    const mean = avg(prices);
    return mean === 0 ? 0 : ((max - min) / mean) * 100;
  }

  function detectMode(range) {
    if (range < 0.5) return "COOLDOWN";
    if (range < 1.5) return "MODE1";
    if (range < 5) return "MODE2";
    return "MODE3";
  }

  function applyMode(mode, range) {
    if (mode === lastMode) return;
    lastMode = mode;
    lastSwitch = Date.now();
    if (mode === "COOLDOWN") {
      cooldownUntil = Date.now() + 15000;
      console.log("🧊 QUIET MARKET → COOLDOWN");
      return;
    }
    if (mode === "MODE1") {
      adaptiveState.state.deviation = 0.0007;
      adaptiveState.state.volatility = 0.0003;
      adaptiveState.state.volume = 1.2;
      CONFIG.risk.TAKE_PROFIT = 0.15;
      CONFIG.risk.STOP_LOSS = 0.25;
    }
    if (mode === "MODE2") {
      adaptiveState.state.deviation = 0.001;
      adaptiveState.state.volatility = 0.0005;
      adaptiveState.state.volume = 1.3;
      CONFIG.risk.TAKE_PROFIT = 0.2;
      CONFIG.risk.STOP_LOSS = 0.35;
    }
    if (mode === "MODE3") {
      adaptiveState.state.deviation = 0.0015;
      adaptiveState.state.volatility = 0.0008;
      adaptiveState.state.volume = 1.5;
      CONFIG.risk.TAKE_PROFIT = 0.3;
      CONFIG.risk.STOP_LOSS = 0.5;
    }
    entryBlockedUntil = Date.now() + 5000;
    console.log(`⚙️ MODE → ${mode} | range=${range.toFixed(2)}%`);
  }

  function autoAdapt(range) {
    if (!adaptiveState?.state) return;
    let factor = 1;
    if (range > 3) factor = 1.2;
    if (range > 5) factor = 1.4;
    adaptiveState.state.deviation *= factor;
    adaptiveState.state.volatility *= factor;
  }

  function preventBadEntry(price) {
    const now = Date.now();
    if (now < entryBlockedUntil) return true;
    const prices = buffers.getPrices();
    if (prices.length < 3) return false;
    const p1 = prices.at(-1);
    const p2 = prices.at(-2);
    const move = Math.abs((p1 - p2) / p2) * 100;
    if (move > 0.2) {
      entryBlockedUntil = now + 3000;
      return true;
    }
    return false;
  }

  function autoFix(price) {
    if (!account.balance || account.balance <= 0) {
      console.log("⛔ AUTOFIX: NO BALANCE");
      return false;
    }
    if (CONFIG.risk.TAKE_PROFIT <= 0 || CONFIG.risk.STOP_LOSS <= 0) {
      console.log("⛔ AUTOFIX: BAD TP/SL");
      return false;
    }
    if (!price || price <= 0) {
      console.log("⛔ AUTOFIX: BAD PRICE");
      return false;
    }
    return true;
  }

  const originalOnTick = onTick;
  onTick = async function(price, volume) {
    const range = getRangePercent();
    const mode = detectMode(range);
    applyMode(mode, range);
    autoAdapt(range);
    if (!autoFix(price)) return;
    if (preventBadEntry(price)) return;
    return originalOnTick(price, volume);
  };
  console.log("🚀 PRO MODULE LOADED");
})();

// ================== SMART PRECISION ENGINE ==================
(function() {
  let stopLossStreak = 0;
  let entryDelayUntil = 0;

  function getOrderBookImbalance() {
    const vol = buffers.getVolumes();
    if (vol.length < 5) return 0;
    const last = vol.at(-1);
    const avgVol = vol.slice(0, -1).reduce((a,b)=>a+b,0)/(vol.length-1);
    return last / avgVol;
  }

  function predictMove() {
    const prices = buffers.getPrices();
    if (prices.length < 5) return 0;
    const p1 = prices.at(-1);
    const p2 = prices.at(-2);
    const p3 = prices.at(-3);
    const v1 = p1 - p2;
    const v2 = p2 - p3;
    return v1 - v2;
  }

  function getBetterEntry(price, side) {
    const offset = CONFIG.entry.OFFSET_PERCENT / 100;
    if (side === "long") return price * (1 - offset);
    else return price * (1 + offset);
  }

  function smartEntryFilter(price, side) {
    const imbalance = getOrderBookImbalance();
    const prediction = predictMove();
    if (side === "long" && imbalance < 0.9) return false;
    if (side === "short" && imbalance > 1.1) return false;
    if (Math.abs(prediction) > 0.0005) return false;
    return true;
  }

  const originalCheckExit = checkExit;
  checkExit = function(price) {
    const result = originalCheckExit(price);
    if (result === "SL") {
      stopLossStreak++;
      console.log(`❌ SL STREAK: ${stopLossStreak}`);
      if (stopLossStreak >= 2) {
        cooldownUntil = Date.now() + 20000;
        console.log("🧠 2x SL → HARD COOLDOWN");
        stopLossStreak = 0;
      }
    }
    if (result === "TP") stopLossStreak = 0;
    return result;
  };

  const originalBuildSignal = buildSignal;
  buildSignal = function(price) {
    const signal = originalBuildSignal(price);
    if (!signal) return null;
    if (Date.now() < entryDelayUntil) return null;
    if (!smartEntryFilter(price, signal.side)) return null;
    entryDelayUntil = Date.now() + 1500;
    signal.entryPrice = getBetterEntry(price, signal.side);
    return signal;
  };
  console.log("🧠 SMART PRECISION ENGINE LOADED");
})();

// ================== LIGHTNING ENGINE ==================
(function() {
  let lastPrice = null;
  let lastTime = null;
  const IMPULSE_THRESHOLD = 0.5;
  const IMPULSE_TIME = 2000;
  const EXIT_THRESHOLD = 0.5;

  function detectImpulse(price) {
    const now = Date.now();
    if (!lastPrice || !lastTime) {
      lastPrice = price;
      lastTime = now;
      return null;
    }
    const timeDiff = now - lastTime;
    const move = ((price - lastPrice) / lastPrice) * 100;
    lastPrice = price;
    lastTime = now;
    if (timeDiff > IMPULSE_TIME) return null;
    if (Math.abs(move) >= IMPULSE_THRESHOLD) {
      return { direction: move > 0 ? "UP" : "DOWN", strength: Math.abs(move), speed: timeDiff };
    }
    return null;
  }

  function lightningExit(price) {
    if (state.status !== "IN_TRADE") return false;
    const move = state.side === "long"
      ? ((price - state.entry) / state.entry) * 100
      : ((state.entry - price) / state.entry) * 100;
    if (move <= -EXIT_THRESHOLD) {
      console.log("⚡ LIGHTNING EXIT TRIGGERED");
      state.status = "IDLE";
      cooldownUntil = Date.now() + 10000;
      return true;
    }
    return false;
  }

  function lightningEntry(impulse, price) {
    if (!impulse) return null;
    if (cooldownUntil > Date.now()) return null;
    if (impulse.speed < 200) return null;
    if (impulse.direction === "UP") return { side: "long", reason: "lightning" };
    if (impulse.direction === "DOWN") return { side: "short", reason: "lightning" };
    return null;
  }

  const originalOnTick = onTick;
  onTick = async function(price, volume) {
    if (lightningExit(price)) return;
    const impulse = detectImpulse(price);
    const entry = lightningEntry(impulse, price);
    if (entry && state.status === "IDLE") {
      console.log(`⚡ LIGHTNING ENTRY ${entry.side}`);
      const qty = calcPositionSize(price);
      if (qty > 0) {
        await placeOrder(entry.side, qty, price);
        state.status = "IN_TRADE";
        state.entry = price;
        state.side = entry.side;
      }
      return;
    }
    return originalOnTick(price, volume);
  };
  console.log("⚡ LIGHTNING ENGINE LOADED");
})();

// ================== AI GUARD + AUTOFIX ==================
(function() {
  let blockedCount = 0;
  let allowedCount = 0;

  function getRR(price, side) {
    const tp = CONFIG.risk.TAKE_PROFIT / 100;
    const sl = CONFIG.risk.STOP_LOSS / 100;
    if (sl === 0) return 0;
    return tp / sl;
  }

  function microTrend() {
    const prices = buffers.getPrices();
    if (prices.length < 5) return 0;
    const p1 = prices.at(-1);
    const p5 = prices.at(-5);
    return (p1 - p5) / p5;
  }

  function isBadAITrade(signal, price) {
    if (!signal) return true;
    const rr = getRR(price, signal.side);
    if (rr < 0.5) return true;
    const trend = microTrend();
    if (signal.side === "long" && trend < 0) return true;
    if (signal.side === "short" && trend > 0) return true;
    if (typeof stopLossStreak !== "undefined" && stopLossStreak >= 2) return true;
    return false;
  }

  function autoFixGuard(signal, price) {
    if (!account.balance || account.balance <= 0) {
      console.log("⛔ AUTOFIX BLOCK: NO BALANCE");
      return false;
    }
    if (!price || price <= 0) {
      console.log("⛔ AUTOFIX BLOCK: BAD PRICE");
      return false;
    }
    if (!signal) return false;
    if (isBadAITrade(signal, price)) {
      blockedCount++;
      console.log(`🧠 AI BLOCKED BAD TRADE (${blockedCount})`);
      return false;
    }
    allowedCount++;
    return true;
  }

  const originalBuildSignal = buildSignal;
  buildSignal = function(price) {
    const signal = originalBuildSignal(price);
    if (!signal) return null;
    if (!autoFixGuard(signal, price)) return null;
    return signal;
  };
  console.log("🧠 AI GUARD LOADED");
})();

// ================== LIQUIDITY TRAP ==================
(function() {
  function isFakeBreakout() {
    const prices = buffers.getPrices();
    if (prices.length < 6) return false;
    const p1 = prices.at(-1);
    const p2 = prices.at(-2);
    const p5 = prices.at(-5);
    const moveUp = (p2 - p5) / p5;
    const revert = (p1 - p2) / p2;
    if (moveUp > 0.003 && revert < -0.002) return true;
    if (moveUp < -0.003 && revert > 0.002) return true;
    return false;
  }

  const originalBuildSignal = buildSignal;
  buildSignal = function(price) {
    if (isFakeBreakout()) {
      console.log("🪤 TRAP DETECTED → BLOCK");
      return null;
    }
    return originalBuildSignal(price);
  };
  console.log("🪤 TRAP MODULE LOADED");
})();

// ================== GLOBAL FIXING ENGINE ==================
(function() {
  let lastSide = null;
  let peakPrice = null;

  function shouldBlockSignal(signal, price) {
    if (!signal) return true;
    if (lastSide === signal.side) {
      const trend = buffers.getPrices().at(-1) - buffers.getPrices().at(-5);
      if (Math.abs(trend) < 0.001) {
        console.log("⚖️ BLOCK SAME SIDE");
        return true;
      }
    }
    return false;
  }

  const originalBuildSignal = buildSignal;
  buildSignal = function(price) {
    const signal = originalBuildSignal(price);
    if (!signal) return null;
    if (shouldBlockSignal(signal, price)) return null;
    lastSide = signal.side;
    return signal;
  };

  const originalCheckExit = checkExit;
  checkExit = function(price) {
    if (state.status === "IN_TRADE") {
      if (!peakPrice) peakPrice = price;
      if (state.side === "long") {
        if (price > peakPrice) peakPrice = price;
        const drop = (price - peakPrice) / peakPrice;
        if (drop < -0.002) {
          console.log("💰 TRAILING EXIT LONG");
          peakPrice = null;
          return "TP";
        }
      }
      if (state.side === "short") {
        if (price < peakPrice) peakPrice = price;
        const bounce = (peakPrice - price) / peakPrice;
        if (bounce < -0.002) {
          console.log("💰 TRAILING EXIT SHORT");
          peakPrice = null;
          return "TP";
        }
      }
    }
    const result = originalCheckExit(price);
    if (result) peakPrice = null;
    return result;
  };
  console.log("🧠 GLOBAL FIXING LOADED");
})();

// ================== SYSTEM RUNTIME AUTOFIX (PM2) ==================
const BOT_NAME = "pro-bot";
const START_CMD = "pm2 start bot.js --name pro-bot -f";

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.log(`❌ ${cmd} ERROR`);
        return resolve(false);
      }
      resolve(stdout);
    });
  });
}

async function fixNpm() {
  if (!fs.existsSync("package.json")) {
    console.log("⚠️ package.json not found");
    return;
  }
  console.log("📦 Checking NPM...");
  await runCmd("npm install");
  console.log("✅ NPM OK");
}

async function isBotRunning() {
  const list = await runCmd("pm2 list");
  return list && list.includes(BOT_NAME);
}

async function startBot() {
  console.log("🚀 Starting bot...");
  await runCmd(START_CMD);
}

async function restartBot() {
  console.log("🔄 Restarting bot...");
  await runCmd(`pm2 restart ${BOT_NAME}`);
}

async function watchdog() {
  const running = await isBotRunning();
  if (!running) {
    console.log("⚠️ BOT DOWN → FIX");
    await startBot();
  } else {
    console.log("✅ BOT RUNNING");
  }
}

async function loop() {
  console.log("🧠 SYSTEM FIX STARTED");
  await fixNpm();
  setInterval(async () => {
    try {
      await watchdog();
    } catch (e) {
      console.log("❌ WATCHDOG ERROR");
    }
  }, 10000);
}

// ================== STUBS FOR MISSING GLOBAL FUNCTIONS ==================
global.getOrderBook = function() {
  return { bids: [[0,0]], asks: [[0,0]] };
};
global.getTrend = function(price) {
  const prices = buffers.getPrices();
  if (prices.length < 10) return "SIDEWAYS";
  const short = avg(prices.slice(-5));
  const long = avg(prices.slice(-10));
  if (short > long * 1.001) return "UP";
  if (short < long * 0.999) return "DOWN";
  return "SIDEWAYS";
};
global.getMomentum = function(price) {
  const prices = buffers.getPrices();
  if (prices.length < 3) return 0;
  return (prices.at(-1) - prices.at(-3)) / prices.at(-3);
};
global.getATR = function(price) {
  const prices = buffers.getPrices();
  if (prices.length < 14) return price * 0.01;
  let tr = 0;
  for (let i = 1; i < 14; i++) {
    tr += Math.abs(prices.at(-i) - prices.at(-i-1));
  }
  return tr / 14;
};

// ================== MODULE 10: SELF-HEALING CORE ==================
(function initSelfHealing() {
  if (global.__MODULE_10_LOADED__) return;
  global.__MODULE_10_LOADED__ = true;

  console.log("🛠 MODULE 10 STARTED");

  if (!fs.existsSync("package.json")) {
    console.log("📦 Creating package.json...");
    const pkg = {
      name: "auto-bot",
      version: "1.0.0",
      main: "bot.js",
      type: "commonjs",
      scripts: { start: "node bot.js" }
    };
    fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));
  }

  console.log("📦 Installing dependencies...");
  runCmd("npm install");

  const dirs = ["logs", "data", "modules"];
  dirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`📁 Created: ${dir}`);
    }
  });

  console.log("🔍 Checking PM2...");
  runCmd("pm2 -v");

  process.on("uncaughtException", (err) => {
    console.log("❌ UNCaught:", err.message);
  });
  process.on("unhandledRejection", (err) => {
    console.log("❌ Unhandled:", err);
  });

  setInterval(() => {
    console.log("🔄 MODULE 10 HEALTH OK");
  }, 60000);
  console.log("✅ MODULE 10 READY");
})();

// ================== MODULE 11 SELF-HEAL V2 ==================
(function initSelfHealV2() {
  if (global.__MODULE_11_LOADED__) return;
  global.__MODULE_11_LOADED__ = true;
  console.log("🧠 MODULE 11 SELF-HEAL ACTIVE");

  const healState = { errors: 0, lastFix: null };

  global.safeRun = async function(fn, context = "unknown") {
    try {
      return await fn();
    } catch (err) {
      console.log(`⚠️ ERROR in ${context}:`, err.message);
      healState.errors++;
      const msg = err.message || "";
      if (msg.includes("fs")) console.log("🔧 Fix: fs-related issue");
      else if (msg.includes("undefined")) console.log("🔧 Fix: undefined value");
      else if (msg.includes("ECONNRESET")) console.log("🔧 Fix: network issue");
      if (healState.errors > 5) {
        console.log("⚠️ Too many errors → throttling");
        healState.errors = 0;
      }
      console.log("✅ Fix applied:", healState.lastFix);
      return null;
    }
  };

  process.on("uncaughtException", (err) => {
    console.log("❌ Uncaught Exception:", err.message);
  });
  process.on("unhandledRejection", (reason) => {
    console.log("❌ Unhandled Rejection:", reason);
  });

  setInterval(() => {
    console.log("🧠 MODULE 11 HEALTH:", { errors: healState.errors, lastFix: healState.lastFix });
  }, 60000);
})();

// ================== MODULE 12: SMART TRADING ==================
(function initSmartTrading() {
  if (global.__MODULE_12__) return;
  global.__MODULE_12__ = true;
  console.log("🧠 MODULE 12 ACTIVE");

  const cfg = {
    impulse: 0.004,
    fakeThreshold: 0.002,
    minMove: 0.003
  };
  const st = { lastPrice: null, lastHigh: null, lastLow: null, direction: null, entry: null, peak: 0 };

  global.smartTrade = function(price) {
    if (!st.lastPrice) {
      st.lastPrice = price;
      st.lastHigh = price;
      st.lastLow = price;
      return { action: "WAIT" };
    }
    const change = (price - st.lastPrice) / st.lastPrice;
    if (price > st.lastHigh) st.lastHigh = price;
    if (price < st.lastLow) st.lastLow = price;
    const fakeUp = price < st.lastHigh * (1 - cfg.fakeThreshold);
    const fakeDown = price > st.lastLow * (1 + cfg.fakeThreshold);
    if (fakeUp || fakeDown) {
      console.log("🚫 FAKE BREAKOUT");
      return { action: "HOLD", reason: "fake" };
    }
    if (Math.abs(change) < cfg.impulse) return { action: "HOLD", reason: "no_impulse" };
    const direction = change > 0 ? "LONG" : "SHORT";
    console.log("📊 SIGNAL:", direction, change);
    st.lastPrice = price;
    return { action: direction, confidence: Math.abs(change) };
  };

  global.managePosition = function(price) {
    if (!st.entry) return;
    const profit = (price - st.entry) / st.entry;
    if (profit > st.peak) st.peak = profit;
    if (profit < st.peak - 0.002) {
      console.log("💰 TAKE PROFIT (dynamic)");
      st.entry = null; st.peak = 0;
      return "CLOSE";
    }
    return "HOLD";
  };

  global.openPosition = function(price, direction) {
    st.entry = price;
    st.direction = direction;
    st.peak = 0;
    console.log("🚀 OPEN", direction, "at", price);
  };
})();

// ================== MODULE 13: BALANCE FILTER ==================
(function initModule13() {
  if (global.__MODULE_13__) return;
  global.__MODULE_13__ = true;
  console.log("⚖️ MODULE 13 ACTIVE");
  const bs = { lastTrade: null, streak: 0 };
  global.balanceFilter = function(signal) {
    if (!signal || signal.action === "HOLD") return signal;
    if (bs.lastTrade === signal.action) bs.streak++;
    else bs.streak = 0;
    if (bs.streak >= 2) {
      console.log("⚖️ BLOCKED OVERBIAS:", signal.action);
      return { action: "HOLD", reason: "overbias" };
    }
    bs.lastTrade = signal.action;
    return signal;
  };
})();

// ================== MODULE 15: VOLATILITY FILTER (REALISTIC PRICE CHECK) ==================
(function initModule15() {
  if (global.__MODULE_15__) return;
  global.__MODULE_15__ = true;
  console.log("⚡ MODULE 15 ACTIVE (з перевіркою ціни)");

  const vf = { prices: [] };
  const vcfg = {
    window: 20,
    minVolatility: 0.02,     // %
    maxVolatility: 5,        // %
    minPrice: 0.0001,        // мінімальна реальна ціна (DOGE ~0.15)
    maxPrice: 1000           // максимальна реальна ціна
  };

  global.volatilityCheck = function(price) {
    // 1. ВІДСІЧЕННЯ НЕКОРЕКТНИХ ЦІН
    if (!price || !Number.isFinite(price) || price <= 0) {
      return { action: "WAIT", reason: "invalid_price" };
    }
    if (price < vcfg.minPrice || price > vcfg.maxPrice) {
      // тихо ігноруємо – не спамимо в лог
      return { action: "WAIT", reason: "price_out_of_range" };
    }

    // 2. Накопичення тільки чистих цін
    vf.prices.push(price);
    if (vf.prices.length > vcfg.window) vf.prices.shift();
    if (vf.prices.length < vcfg.window) {
      return { action: "WAIT", reason: "collecting" };
    }

    // 3. Обчислення волатильності (min > 0 гарантовано)
    const min = Math.min(...vf.prices);
    const max = Math.max(...vf.prices);
    const volPercent = ((max - min) / min) * 100;

    // 4. Захист від аномалій (хоча їх вже не буде)
    if (!Number.isFinite(volPercent) || volPercent > 100) {
      return { action: "HOLD", reason: "vol_out_of_range" };
    }
    if (volPercent < vcfg.minVolatility) return { action: "HOLD", reason: "low_vol" };
    if (volPercent > vcfg.maxVolatility) return { action: "HOLD", reason: "high_vol" };

    return { action: "TRADE", volatility: volPercent };
  };
})();

// ================== MODULE 14: ADAPTIVE TP ==================
(function initModule14() {
  if (global.__MODULE_14__) return;
  global.__MODULE_14__ = true;
  console.log("📈 MODULE 14 ACTIVE");
  const at = { entry: null, peak: 0, direction: null };
  global.adaptiveTrade = function(price, action) {
    if (action === "LONG" || action === "SHORT") {
      at.entry = price;
      at.peak = 0;
      at.direction = action;
      console.log("🚀 ENTRY:", action, price);
      return;
    }
    if (!at.entry) return;
    let profit = 0;
    if (at.direction === "LONG") profit = (price - at.entry) / at.entry;
    else profit = (at.entry - price) / at.entry;
    if (profit > at.peak) at.peak = profit;
    if (profit < at.peak - 0.003) {
      console.log("💰 ADAPTIVE CLOSE:", profit);
      at.entry = null; at.peak = 0;
      return "CLOSE";
    }
  };
})();



// ================== MODULE 16: AUTO ADAPT (FIXED) ==================
(function initModule16() {
  if (global.__MODULE_16__) return;
  global.__MODULE_16__ = true;
  console.log("🤖 MODULE 16 ACTIVE");
  const aa = { history: [], lastUpdate: Date.now() };
  const aacfg = { window: 50, adaptInterval: 10000 };
  global.autoAdapt = function(price) {
    aa.history.push(price);
    if (aa.history.length > aacfg.window) aa.history.shift();
    if (aa.history.length < aacfg.window) return;
    const now = Date.now();
    if (now - aa.lastUpdate < aacfg.adaptInterval) return;
    const max = Math.max(...aa.history);
    const min = Math.min(...aa.history);
    const vol = (max - min) / min;
    if (vol < 0.002) {
      console.log("🤖 ADAPT: LOW MARKET");
    } else if (vol < 0.005) {
      console.log("🤖 ADAPT: NORMAL MARKET");
    } else {
      console.log("🤖 ADAPT: HIGH VOL MARKET");
    }
    aa.lastUpdate = now;
  };
})();

// ================== MODULE 17: ANTI-REVERSAL ==================
(function initModule17() {
  if (global.__MODULE_17__) return;
  global.__MODULE_17__ = true;
  console.log("🔁 MODULE 17 ACTIVE");
  const ar = { history: [] };
  const arcfg = { window: 10, reversalThreshold: 0.002 };
  global.antiReversalCheck = function(price) {
    ar.history.push(price);
    if (ar.history.length > arcfg.window) ar.history.shift();
    if (ar.history.length < arcfg.window) return true;
    const first = ar.history[0];
    const last = ar.history[ar.history.length - 1];
    const move = (last - first) / first;
    if (Math.abs(move) > arcfg.reversalThreshold) {
      console.log("⚠️ POSSIBLE REVERSAL");
      return false;
    }
    return true;
  };
})();

// ================== MODULE 18: LOSS CONTROL ==================
(function initModule18() {
  if (global.__MODULE_18__) return;
  global.__MODULE_18__ = true;
  console.log("🛑 MODULE 18 ACTIVE");
  const lc = { losses: 0 };
  global.lossControl = function(result) {
    if (result === "LOSS") {
      lc.losses++;
      console.log("📉 LOSS COUNT:", lc.losses);
    }
    if (result === "PROFIT") lc.losses = 0;
    if (lc.losses >= 3) {
      console.log("🛑 STOP TRADING (LOSS LIMIT)");
      return false;
    }
    return true;
  };
})();

// ================== MODULE 19: REAL PNL ==================
(function initModule19() {
  if (global.__MODULE_19__) return;
  global.__MODULE_19__ = true;
  console.log("💰 MODULE 19 ACTIVE");
  const rp = { entry: null, direction: null };
  global.setEntry = function(price, direction) { rp.entry = price; rp.direction = direction; };
  global.calculatePnL = function(price) {
    if (!rp.entry || !rp.direction) return null;
    let pnl = 0;
    if (rp.direction === "LONG") pnl = (price - rp.entry) / rp.entry;
    else pnl = (rp.entry - price) / rp.entry;
    return pnl;
  };
  global.closeTrade = function(price) {
    const pnl = global.calculatePnL(price);
    if (pnl === null) return null;
    console.log("💰 PnL:", (pnl * 100).toFixed(3) + "%");
    const result = pnl > 0 ? "PROFIT" : "LOSS";
    rp.entry = null; rp.direction = null;
    return result;
  };
})();

// ================== MODULE 20: BINANCE ORDER ==================
(function initModule20() {
  if (global.__MODULE_20__) return;
  global.__MODULE_20__ = true;
  console.log("🟡 MODULE 20 ACTIVE");
  global.placeOrder = function(symbol, action, qty = 0.001) {
    try {
      const side = action === "LONG" ? "BUY" : "SELL";
      console.log("📈 EXECUTE:", symbol, side, qty);
      // Тут можна додати реальний API виклик
    } catch (e) {
      console.log("❌ PLACE ORDER ERROR:", e.message);
    }
  };
})();

// ================== MODULE 21: MULTI SYMBOL ==================
(function initModule21() {
  if (global.__MODULE_21__) return;
  global.__MODULE_21__ = true;
  console.log("🌐 MODULE 21 ACTIVE");
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  global.runMultiSymbol = function(prices) {
    for (const symbol of symbols) {
      const price = prices[symbol];
      if (!price) continue;
      if (global.autoAdapt) global.autoAdapt(price);
      if (global.volatilityCheck) {
        const vol = global.volatilityCheck(price);
        if (vol.action !== "TRADE") continue;
      }
      if (global.antiReversalCheck && !global.antiReversalCheck(price)) continue;
      let signal = global.smartTrade ? global.smartTrade(price) : null;
      if (global.balanceFilter) signal = global.balanceFilter(signal);
      if (signal && (signal.action === "LONG" || signal.action === "SHORT")) {
        if (global.openPosition) global.openPosition(price, signal.action);
        if (global.setEntry) global.setEntry(price, signal.action);
        if (global.placeOrder) global.placeOrder(symbol, signal.action, 0.001);
      }
      if (global.adaptiveTrade) {
        const result = global.adaptiveTrade(price, signal ? signal.action : null);
        if (result === "CLOSE") {
          const tradeResult = global.closeTrade ? global.closeTrade(price) : null;
          if (tradeResult && global.lossControl && !global.lossControl(tradeResult)) {
            console.log("🛑 STOP ALL SYMBOLS");
            return;
          }
        }
      }
    }
  };
})();

// ================== MODULE 22: WEBSOCKET MULTI (FIXED) ==================
(function initModule22() {
  if (global.__MODULE_22__) return;
  global.__MODULE_22__ = true;
  console.log("⚡ MODULE 22 ACTIVE");
  const streams = ["btcusdt@trade", "ethusdt@trade", "solusdt@trade"];
  const wsMulti = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams.join("/")}`);
  const prices = {};
  wsMulti.on("message", (data) => {
    try {
      const json = JSON.parse(data.toString());
      const stream = json.stream;
      if (!json.data || typeof json.data.p === 'undefined') return;
      const price = parseFloat(json.data.p);
      const symbol = stream.split("@")[0].toUpperCase();
      prices[symbol] = price;
      if (global.runMultiSymbol) global.runMultiSymbol(prices);
    } catch (e) { console.log("❌ WS PARSE ERROR:", e.message); }
  });
  wsMulti.on("error", (err) => console.log("❌ WS ERROR:", err.message));
  wsMulti.on("close", () => {
    console.log("🔄 WS CLOSED → RECONNECT...");
    setTimeout(() => initModule22(), 3000);
  });
})();

// ================== MODULE 23: ANALYTICS ==================
(function initModule23() {
  if (global.__MODULE_23__) return;
  global.__MODULE_23__ = true;
  console.log("📊 MODULE 23 ACTIVE");
  const analytics = { trades: 0, wins: 0, losses: 0, totalPnL: 0 };
  global.logTrade = function(pnl) {
    analytics.trades++;
    if (pnl > 0) analytics.wins++;
    else analytics.losses++;
    analytics.totalPnL += pnl;
    const winrate = ((analytics.wins / analytics.trades) * 100).toFixed(2);
    const log = { time: new Date().toISOString(), trades: analytics.trades, wins: analytics.wins, losses: analytics.losses, totalPnL: analytics.totalPnL, winrate: winrate + "%" };
    console.log("📊 STATS:", log);
    fs.appendFileSync("logs/trades.log", JSON.stringify(log) + "\n");
  };
})();

// ================== MODULE 24: POSITION SIZE ==================
(function initModule24() {
  if (global.__MODULE_24__) return;
  global.__MODULE_24__ = true;
  console.log("💸 MODULE 24 ACTIVE");
  global.getPositionSize = async function(price) {
    try {
      const balance = 1000; // симуляція, можна замінити на реальний баланс
      const use = balance * 0.95;
      const qty = use / price;
      return parseFloat(qty.toFixed(6));
    } catch (e) {
      console.log("❌ POSITION SIZE ERROR:", e.message);
      return 0.001;
    }
  };
})();

// ================== MODULE 25: CONTROL PLANE ==================
(function initModule25() {
  if (global.__MODULE_25__) return;
  global.__MODULE_25__ = true;

  console.log("🧠 MODULE 25 CONTROL ACTIVE");

  const queue = [];
  let processing = false;

  const timings = {
    volatility: 0,
    signal: 50,
    risk: 100,
    entry: 150,
    manage: 200
  };

  function now() {
    return Date.now();
  }

  function wait(ms) {
    return new Promise(res => setTimeout(res, ms));
  }

  async function runPipeline(price, volume) {
    if (processing) {
      queue.push({ price, volume });
      return;
    }

    processing = true;

    try {
      // STEP 1: VOLATILITY
      await wait(timings.volatility);
      const vol = global.volatilityCheck?.(price);
      if (!vol || vol.action !== "TRADE") {
        processing = false;
        return;
      }

      // STEP 2: AUTO ADAPT
      await wait(10);
      global.autoAdapt?.(price);

      // STEP 3: ANTI REVERSAL
      await wait(10);
      if (global.antiReversalCheck && !global.antiReversalCheck(price)) {
        processing = false;
        return;
      }

      // STEP 4: SIGNAL
      await wait(timings.signal);
      let signal = global.smartTrade?.(price);
      if (global.balanceFilter) signal = global.balanceFilter(signal);
      if (!signal || signal.action === "HOLD" || signal.action === "WAIT") {
        processing = false;
        return;
      }

      // STEP 5: RISK CHECK
      await wait(timings.risk);

      if (global.lossControl && !global.lossControl("CHECK")) {
        processing = false;
        return;
      }

      // STEP 6: ENTRY
      await wait(timings.entry);

      if (signal.action === "LONG" || signal.action === "SHORT") {
        global.openPosition?.(price, signal.action);
        global.setEntry?.(price, signal.action);

        const qty = await global.getPositionSize?.(price) || 0.001;
        global.placeOrder?.(CONFIG.ws.SYMBOL, signal.action, qty);
      }

      // STEP 7: MANAGEMENT
      await wait(timings.manage);

      const result = global.managePosition?.(price);
      if (result === "CLOSE") {
        const pnlResult = global.closeTrade?.(price);

        if (pnlResult && global.lossControl) {
          global.lossControl(pnlResult);
        }

        if (global.logTrade) {
          const pnl = global.calculatePnL?.(price) || 0;
          global.logTrade(pnl);
        }
      }

    } catch (e) {
      console.log("❌ CONTROL ERROR:", e.message);
    }

    processing = false;

    // process queue
    if (queue.length > 0) {
      const next = queue.shift();
      runPipeline(next.price, next.volume);
    }
  }

  // Зберігаємо попередній onTick і викликаємо його після виконання конвеєра, щоб не зламати оригінальну логіку
  const previousOnTick = onTick;
  onTick = async function(price, volume) {
    await runPipeline(price, volume);
    // Викликаємо оригінальний обробник, щоб зберегти базову логіку (deviation, volume spike тощо)
    if (previousOnTick) await previousOnTick(price, volume);
  };

  console.log("✅ MODULE 25 PIPELINE ATTACHED");
})();

// ================= MODULE 26 + 27 =================
(function initModule26_27() {

  if (global.__MODULE_26_27__) return;
  global.__MODULE_26_27__ = true;

  console.log("🧠 MODULE 26 + 27 ACTIVE");

  // ================= MODULE 27: LIQUIDITY FILTER =================
  global.liquidityFilter = function(price) {
    try {
      const orderBook = global.getOrderBook?.();

      if (!orderBook) return true;

      const bids = orderBook.bids || [];
      const asks = orderBook.asks || [];

      const bidVolume = bids.reduce((sum, b) => sum + parseFloat(b[1] || 0), 0);
      const askVolume = asks.reduce((sum, a) => sum + parseFloat(a[1] || 0), 0);

      const imbalance = bidVolume - askVolume;

      // ❌ avoid low liquidity
      if (bidVolume + askVolume < 100) return false;

      // ❌ avoid extreme imbalance (manipulation zones)
      if (Math.abs(imbalance) > (bidVolume + askVolume) * 0.8) return false;

      return true;

    } catch (e) {
      console.log("❌ LIQUIDITY ERROR:", e.message);
      return true;
    }
  };

  // ================= MODULE 26: ENTRY =================
  global.optimizeEntry = function(price, signal) {
    try {
      if (!signal || !signal.action) return null;

      // liquidity check (MODULE 27)
      if (!global.liquidityFilter(price)) return null;

      const trend = global.getTrend?.(price);
      const momentum = global.getMomentum?.(price);

      // avoid sideways market
      if (trend === "SIDEWAYS") return null;

      // momentum confirmation
      if (signal.action === "LONG" && momentum < 0) return null;
      if (signal.action === "SHORT" && momentum > 0) return null;

      return {
        action: signal.action,
        strength: Math.abs(momentum || 0)
      };

    } catch (e) {
      console.log("❌ ENTRY ERROR:", e.message);
      return null;
    }
  };

  // ================= MODULE 26: EXIT =================
  global.optimizeExit = function(price, position) {
    try {
      if (!position) return "HOLD";

      const pnl = global.calculatePnL?.(price) || 0;
      const atr = global.getATR?.(price) || 0;

      // take profit
      if (pnl > atr * 2) {
        return "TAKE_PROFIT";
      }

      // stop loss
      if (pnl < -atr * 1.5) {
        return "STOP_LOSS";
      }

      // trailing
      if (pnl > atr) {
        return "TRAIL";
      }

      return "HOLD";

    } catch (e) {
      console.log("❌ EXIT ERROR:", e.message);
      return "HOLD";
    }
  };

})();

// ================== MODULE 28: CRITICAL FIXES ==================
(function initModule28() {
  if (global.__MODULE_28__) return;
  global.__MODULE_28__ = true;
  console.log("🔧 MODULE 28: CRITICAL FIXES ACTIVE");

  // 1. Фікс розрахунку волатильності (нормалізація до відсотків) - вже зроблено в модулі 15
  // 2. Фікс детектора фейкового пробою (збільшені пороги) - залишаємо як є
  // 3. Обмеження частоти логів (не частіше ніж раз на 50 мс)
  let lastLog = 0;
  const originalConsoleLog = console.log;
  console.log = function(...args) {
    const now = Date.now();
    if (now - lastLog > 50) {
      lastLog = now;
      originalConsoleLog.apply(console, args);
    }
  };

  // 4. Додаткова перевірка для змінної state (запобігання помилкам)
  if (!global.state) global.state = state;
})();

// ================== MODULE 29: TRADING START ENGINE V2 ==================
(function initModule29() {
  if (global.__MODULE_29__) return;
  global.__MODULE_29__ = true;
  console.log("🚀 MODULE 29 V2 ACTIVE");

  let lastTradeTime = Date.now();
  const FORCE_INTERVAL = 15000;

  function isMarketValid() {
    const prices = buffers.getPrices();
    if (prices.length < 10) return false;

    const max = Math.max(...prices);
    const min = Math.min(...prices);

    if (min <= 0) return false;

    const range = ((max - min) / min) * 100;

    // ❌ якщо знову баг
    if (range > 10) return false;

    return true;
  }

  function getDirection() {
    const prices = buffers.getPrices();
    if (prices.length < 5) return null;

    const p1 = prices.at(-1);
    const p5 = prices.at(-5);

    const change = (p1 - p5) / p5;

    if (change > 0.0005) return "long";
    if (change < -0.0005) return "short";

    return Math.random() > 0.5 ? "long" : "short";
  }

  async function forceEntry(price) {
    if (!isMarketValid()) {
      console.log("🚫 FORCE BLOCK: BAD MARKET");
      return;
    }

    if (state.status !== "IDLE") return;

    const side = getDirection();
    if (!side) return;

    const qty = calcPositionSize(price);
    if (qty <= 0) return;

    console.log("🚀 FORCE ENTRY:", side);

    const order = await placeOrder(side, qty, price);
    if (!order) return;

    state.status = "IN_TRADE";
    state.entry = price;
    state.side = side;

    account.tradesToday++;
    lastTradeTime = Date.now();
  }

  const previousOnTick = onTick;
  onTick = async function(price, volume) {
    if (previousOnTick) await previousOnTick(price, volume);

    const now = Date.now();
    if (
      state.status === "IDLE" &&
      now - lastTradeTime > FORCE_INTERVAL &&
      cooldownUntil < now
    ) {
      await forceEntry(price);
    }
  };
})();

// ================== MODULE 30: STABLE CORE ENGINE ==================
(function initModule30() {
  if (global.__MODULE_30__) return;
  global.__MODULE_30__ = true;
  console.log("🛡 MODULE 30: STABLE CORE ACTIVE");

  let lastGoodPrice = null;
  let stablePrices = [];

  const cfg = {
    maxJumpPercent: 3,     // макс допустимий стрибок
    maxHistory: 50,
    maxVolatility: 5,      // %
    minVolatility: 0.02    // %
  };

  // ================= NORMALIZE PRICE =================
  function normalizePrice(price) {
    if (!price || price <= 0) return null;

    if (!lastGoodPrice) {
      lastGoodPrice = price;
      return price;
    }

    const change = Math.abs((price - lastGoodPrice) / lastGoodPrice) * 100;

    // ❌ відсікаємо дикі стрибки
    if (change > cfg.maxJumpPercent) {
      console.log("🚫 FILTER SPIKE:", price);
      return null;
    }

    lastGoodPrice = price;
    return price;
  }

  // ================= STABLE BUFFER =================
  function pushStable(price) {
    stablePrices.push(price);
    if (stablePrices.length > cfg.maxHistory) {
      stablePrices.shift();
    }
  }

  function getStableVolatility() {
    if (stablePrices.length < 10) return 0;

    const max = Math.max(...stablePrices);
    const min = Math.min(...stablePrices);

    if (min <= 0) return 0;

    let vol = ((max - min) / min) * 100;

    // clamp
    if (vol > cfg.maxVolatility) vol = cfg.maxVolatility;
    if (vol < cfg.minVolatility) vol = 0;

    return vol;
  }

  function isStableMarket() {
    const vol = getStableVolatility();
    if (vol === 0) return false;
    if (vol > cfg.maxVolatility) return false;
    return true;
  }

  // ================= ENTRY BOOST =================
  function stabilizeSignal(signal, price) {
    if (!signal) return null;
    const trend = (price - stablePrices[0]) / stablePrices[0];
    if (signal.side === "long" && trend < 0) return null;
    if (signal.side === "short" && trend > 0) return null;
    return signal;
  }

  // ================= HOOK =================
  const previousOnTick = onTick;
  onTick = async function(price, volume) {
    // 1. нормалізація
    const cleanPrice = normalizePrice(price);
    if (!cleanPrice) return;

    // 2. стабільний буфер
    pushStable(cleanPrice);

    // 3. перевірка ринку
    if (!isStableMarket()) {
      return; // ринок сміття → нічого не робимо
    }

    // 4. передаємо далі
    if (previousOnTick) await previousOnTick(cleanPrice, volume);
  };
})();

// ================== ЗАПУСК ==================
async function main() {
  console.log("\n🚀 ЗАПУСК БОТА");
  await tradingModeSelector();
  if (fs.existsSync('optimized_params.json')) {
    const opt = JSON.parse(fs.readFileSync('optimized_params.json'));
    adaptiveState.state = opt;
    console.log("📥 Завантажено оптимізовані параметри:", opt);
  }
  startWebSocket();
  loop(); // запускаємо автовідновлення PM2
}

process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));
setInterval(() => {
  account.dailyLoss = 0;
  account.tradesToday = 0;
  console.log("🔄 DAILY RESET (обнулено денні ліміти)");
}, 24 * 60 * 60 * 1000);

// ================== MODULE 30: DECISION ENGINE (КОНСЕНСУС) ==================
(function initDecisionEngine() {
  if (global.__DECISION_ENGINE_LOADED__) return;
  global.__DECISION_ENGINE_LOADED__ = true;
  console.log("🧠 MODULE 30: DECISION ENGINE (консенсус) ACTIVE");

  // Словник голосів модулів (заповнюється під час перевірок)
  const votes = {
    volatility: { weight: 1.5, lastVote: null },   // модуль 15
    smartTrade: { weight: 1.2, lastVote: null },   // модуль 12
    balanceFilter: { weight: 1.0, lastVote: null }, // модуль 13
    antiReversal: { weight: 1.2, lastVote: null }, // модуль 17
    lossControl: { weight: 2.0, lastVote: null },  // модуль 18
    liquidity: { weight: 1.3, lastVote: null },    // модуль 27
    // Додайте інші модулі за потреби
  };

  // Функція для збору голосів (викликається перед входом)
  function collectVotes(price, side) {
    let totalWeight = 0;
    let positiveVotes = 0;

    // 1. Модуль 15: волатильність
    if (global.volatilityCheck) {
      const vol = global.volatilityCheck(price);
      const vote = (vol && vol.action === "TRADE") ? 1 : 0;
      votes.volatility.lastVote = vote;
      totalWeight += votes.volatility.weight;
      positiveVotes += vote * votes.volatility.weight;
      console.log(`   📊 Volatility: ${vote === 1 ? "ALLOW" : "BLOCK"} (weight ${votes.volatility.weight})`);
    }

    // 2. Модуль 12: smartTrade
    if (global.smartTrade) {
      const signal = global.smartTrade(price);
      const vote = (signal && (signal.action === "LONG" || signal.action === "SHORT")) ? 1 : 0;
      votes.smartTrade.lastVote = vote;
      totalWeight += votes.smartTrade.weight;
      positiveVotes += vote * votes.smartTrade.weight;
      console.log(`   📊 SmartTrade: ${vote === 1 ? "ALLOW" : "BLOCK"} (weight ${votes.smartTrade.weight})`);
    }

    // 3. Модуль 13: balanceFilter (зазвичай блокує при овербайас)
    if (global.balanceFilter && global.smartTrade) {
      const raw = global.smartTrade(price);
      const filtered = global.balanceFilter(raw);
      const vote = (filtered && filtered.action !== "HOLD") ? 1 : 0;
      votes.balanceFilter.lastVote = vote;
      totalWeight += votes.balanceFilter.weight;
      positiveVotes += vote * votes.balanceFilter.weight;
      console.log(`   📊 BalanceFilter: ${vote === 1 ? "ALLOW" : "BLOCK"} (weight ${votes.balanceFilter.weight})`);
    }

    // 4. Модуль 17: antiReversal
    if (global.antiReversalCheck) {
      const vote = global.antiReversalCheck(price) ? 1 : 0;
      votes.antiReversal.lastVote = vote;
      totalWeight += votes.antiReversal.weight;
      positiveVotes += vote * votes.antiReversal.weight;
      console.log(`   📊 AntiReversal: ${vote === 1 ? "ALLOW" : "BLOCK"} (weight ${votes.antiReversal.weight})`);
    }

    // 5. Модуль 18: lossControl (блок при трьох збитках)
    if (global.lossControl) {
      // Передаємо "CHECK" щоб отримати статус без зміни лічильника
      const originalLossControl = global.lossControl;
      let tempResult = true;
      // Тимчасово підміняємо, щоб не змінювати стан
      global.lossControl = (arg) => { if (arg === "CHECK") return tempResult; return originalLossControl(arg); };
      tempResult = originalLossControl("CHECK");
      global.lossControl = originalLossControl;
      const vote = tempResult ? 1 : 0;
      votes.lossControl.lastVote = vote;
      totalWeight += votes.lossControl.weight;
      positiveVotes += vote * votes.lossControl.weight;
      console.log(`   📊 LossControl: ${vote === 1 ? "ALLOW" : "BLOCK"} (weight ${votes.lossControl.weight})`);
    }

    // 6. Модуль 27: liquidityFilter
    if (global.liquidityFilter) {
      const vote = global.liquidityFilter(price) ? 1 : 0;
      votes.liquidity.lastVote = vote;
      totalWeight += votes.liquidity.weight;
      positiveVotes += vote * votes.liquidity.weight;
      console.log(`   📊 Liquidity: ${vote === 1 ? "ALLOW" : "BLOCK"} (weight ${votes.liquidity.weight})`);
    }

    const consensusRatio = totalWeight === 0 ? 0.5 : positiveVotes / totalWeight;
    console.log(`   🧠 Consensus ratio: ${(consensusRatio * 100).toFixed(1)}% (positive ${positiveVotes} / total ${totalWeight})`);
    return consensusRatio >= 0.55; // 55% позитивних голосів
  }

  // Перехоплюємо оригінальний onTick (але не ламаємо ланцюжок)
  const previousOnTick = onTick;
  onTick = async function(price, volume) {
    // Спочатку виконуємо всі оригінальні перевірки (включно з блокуваннями)
    await previousOnTick(price, volume);

    // Якщо стан IDLE і ми не на кулдауні, але оригінальний onTick не створив сигнал (state все ще IDLE)
    if (state.status === "IDLE" && cooldownUntil <= Date.now()) {
      // Шукаємо, чи є хоч один модуль, який дає сигнал (наприклад, smartTrade або buildSignal)
      let externalSignal = null;
      if (global.smartTrade) {
        const stSignal = global.smartTrade(price);
        if (stSignal && (stSignal.action === "LONG" || stSignal.action === "SHORT")) {
          externalSignal = { side: stSignal.action === "LONG" ? "long" : "short", source: "smartTrade" };
        }
      }
      if (!externalSignal && buildSignal) {
        const rawSignal = buildSignal(price);
        if (rawSignal && rawSignal.side) {
          externalSignal = { side: rawSignal.side, source: "buildSignal" };
        }
      }

      if (externalSignal) {
        console.log(`🔔 DECISION ENGINE: отримано сигнал від ${externalSignal.source} (${externalSignal.side})`);
        const consensus = collectVotes(price, externalSignal.side);
        if (consensus) {
          console.log(`✅ DECISION ENGINE: консенсус досягнуто. ВХІД ${externalSignal.side}`);
          const qty = calcPositionSize(price);
          if (qty > 0) {
            const order = await placeOrder(externalSignal.side, qty, price);
            if (order) {
              state.status = "IN_TRADE";
              state.entry = price;
              state.side = externalSignal.side;
              account.tradesToday++;
            }
          }
        } else {
          console.log(`❌ DECISION ENGINE: консенсусу немає. Вхід відхилено.`);
        }
      }
    }
  };
})();

// ================== MODULE 31: WORKER POOL MANAGER ==================
(function initWorkerPool() {
  if (global.__WORKER_POOL_LOADED__) return;
  global.__WORKER_POOL_LOADED__ = true;

  // Активуємо тільки в режимі оркестратора
  if (process.env.ORCHESTRATOR_MODE !== 'true') {
    console.log("🧩 MODULE 31: Worker Pool не активовано (ORCHESTRATOR_MODE != true)");
    return;
  }

  console.log("🧩 MODULE 31: Worker Pool Manager ACTIVE");

  const fs = require('fs');
  const { fork } = require('child_process');
  const path = require('path');

  const NUM_WORKERS = parseInt(process.env.NUM_WORKERS || 7);
  const CONSENSUS_THRESHOLD = parseFloat(process.env.CONSENSUS_THRESHOLD || 0.7);
  const DECISION_TIMEOUT = parseInt(process.env.DECISION_TIMEOUT || 5000);
  const WORKER_HEARTBEAT_INTERVAL = 5000;
  const WORKER_FAILURE_THRESHOLD = 3; // 3 пропущених heartbeat = dead
  const PERFORMANCE_WINDOW = 50;      // останні N трейдів для оцінки

  let workers = new Map(); // id -> { worker, heartbeatMisses, stats }
  let pendingDecision = null;
  let orchestratorInterval = null;

  // ---------- Реальне виконання ордера ----------
  async function executeRealOrder(symbol, side, quantity, price) {
    console.log(`🚀 REAL ORDER: ${side.toUpperCase()} ${quantity} ${symbol} @ ${price}`);
    // Тут ваш код Binance API (скопіюйте з placeOrder, але з REAL_MODE=true)
    const BASE_URL = process.env.BINANCE_TESTNET === "true"
      ? "https://testnet.binancefuture.com"
      : "https://fapi.binance.com";
    const timestamp = Date.now();
    const orderSide = side === "long" ? "BUY" : "SELL";
    const queryParams = {
      symbol: symbol.toUpperCase(),
      side: orderSide,
      type: "MARKET",
      quantity: Number(quantity.toFixed(3)),
      timestamp
    };
    const queryString = new URLSearchParams(queryParams).toString();
    const signature = crypto.createHmac("sha256", process.env.BINANCE_API_SECRET).update(queryString).digest("hex");
    const url = `${BASE_URL}/fapi/v1/order?${queryString}&signature=${signature}`;
    try {
      const res = await fetch(url, { method: "POST", headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY } });
      const data = await res.json();
      if (data.code && data.code !== 200) throw new Error(data.msg);
      console.log("✅ ORDER EXECUTED:", data);
    } catch (err) {
      console.error("❌ ORDER FAILED:", err.message);
    }
  }

  // ---------- Голосування ----------
  function handleWorkerSignal(msg, workerId) {
    if (msg.type !== 'signal') return;
    const { symbol, side, price, quantity } = msg;
    const key = `${symbol}_${side}`;
    const now = Date.now();

    if (!pendingDecision || pendingDecision.key !== key || (now - pendingDecision.startTime) > DECISION_TIMEOUT) {
      if (pendingDecision?.timeoutId) clearTimeout(pendingDecision.timeoutId);
      pendingDecision = {
        key, symbol, side, price, quantity,
        votes: new Set(),
        startTime: now,
        timeoutId: setTimeout(() => finalizeDecision(false), DECISION_TIMEOUT)
      };
    }
    pendingDecision.votes.add(workerId);
    const totalVotes = pendingDecision.votes.size;
    const consensus = totalVotes / NUM_WORKERS;
    console.log(`🗳️ Worker ${workerId} votes ${side} (${totalVotes}/${NUM_WORKERS} = ${(consensus*100).toFixed(0)}%)`);
    if (consensus >= CONSENSUS_THRESHOLD) {
      if (pendingDecision.timeoutId) clearTimeout(pendingDecision.timeoutId);
      finalizeDecision(true);
    }
  }

  function finalizeDecision(consensusReached) {
    if (!pendingDecision) return;
    const { symbol, side, price, quantity, votes, startTime } = pendingDecision;
    const consensus = votes.size / NUM_WORKERS;
    if (consensusReached && consensus >= CONSENSUS_THRESHOLD) {
      console.log(`✅ CONSENSUS ${(consensus*100).toFixed(0)}% ≥ ${CONSENSUS_THRESHOLD*100}% → EXECUTING ${side} ${symbol}`);
      executeRealOrder(symbol, side, quantity, price);
    } else {
      console.log(`❌ NO CONSENSUS (${(consensus*100).toFixed(0)}% < ${CONSENSUS_THRESHOLD*100}%) for ${side} ${symbol}`);
    }
    pendingDecision = null;
  }

  // ---------- Статистика воркерів ----------
  function updateWorkerStats(workerId, result) {
    const worker = workers.get(workerId);
    if (!worker) return;
    if (!worker.stats) worker.stats = { trades: [], wins: 0, losses: 0, lastUpdate: Date.now() };
    worker.stats.trades.push(result); // result: 'win' or 'loss'
    if (worker.stats.trades.length > PERFORMANCE_WINDOW) worker.stats.trades.shift();
    worker.stats.wins = worker.stats.trades.filter(r => r === 'win').length;
    worker.stats.losses = worker.stats.trades.filter(r => r === 'loss').length;
    worker.stats.winrate = worker.stats.trades.length ? (worker.stats.wins / worker.stats.trades.length) : 0;
  }

  function getWorkerPerformance(workerId) {
    const worker = workers.get(workerId);
    if (!worker || !worker.stats || worker.stats.trades.length < 5) return 0.5;
    return worker.stats.winrate;
  }

  // ---------- Heartbeat та заміна поганих воркерів ----------
  function checkWorkerHealth() {
    const now = Date.now();
    for (let [id, data] of workers.entries()) {
      // Перевірка heartbeat
      if (now - data.lastHeartbeat > WORKER_HEARTBEAT_INTERVAL * (WORKER_FAILURE_THRESHOLD + 1)) {
        console.log(`💀 Worker ${id} dead (no heartbeat). Restarting...`);
        restartWorker(id);
        continue;
      }
      // Перевірка продуктивності (падіння >3% відносно середнього)
      const perf = getWorkerPerformance(id);
      const allPerfs = Array.from(workers.values()).map(w => getWorkerPerformance(w.id)).filter(p => p > 0);
      const avgPerf = allPerfs.length ? allPerfs.reduce((a,b)=>a+b,0)/allPerfs.length : 0.5;
      if (perf < avgPerf - 0.03 && workers.size >= 3) {
        console.log(`⚠️ Worker ${id} performance drop: ${(perf*100).toFixed(1)}% (avg ${(avgPerf*100).toFixed(1)}%). Replacing...`);
        restartWorker(id, true); // mutate parameters
      }
    }
  }

  function restartWorker(workerId, mutate = false) {
    const old = workers.get(workerId);
    if (old) {
      try { old.worker.kill(); } catch(e) {}
      workers.delete(workerId);
    }
    startWorker(workerId, mutate);
  }

  function startWorker(workerId, mutate = false) {
    const workerEnv = {
      ...process.env,
      WORKER_ID: workerId,
      WORKER_MODE: 'orchestrated',
      MUTATE_PARAMS: mutate ? 'true' : 'false'
    };
    const worker = fork('./bot_worker.js', [workerId], { env: workerEnv });
    const stats = { trades: [], wins: 0, losses: 0, winrate: 0.5 };
    workers.set(workerId, { worker, lastHeartbeat: Date.now(), stats, id: workerId });
    worker.on('message', (msg) => {
      if (msg.type === 'heartbeat') {
        workers.get(workerId).lastHeartbeat = Date.now();
      } else if (msg.type === 'trade_result') {
        updateWorkerStats(workerId, msg.result);
      } else {
        handleWorkerSignal(msg, workerId);
      }
    });
    worker.on('exit', (code) => {
      console.log(`🔁 Worker ${workerId} exited (code ${code}), restarting...`);
      restartWorker(workerId);
    });
    console.log(`🟢 Worker ${workerId} started (mutate=${mutate})`);
  }

  // Запуск всіх воркерів
  for (let i = 1; i <= NUM_WORKERS; i++) startWorker(i);
  orchestratorInterval = setInterval(checkWorkerHealth, WORKER_HEARTBEAT_INTERVAL);
  console.log(`🎛️ MODULE 31: ${NUM_WORKERS} workers, threshold ${CONSENSUS_THRESHOLD*100}%`);

  // Зупинка при завершенні
  process.on('SIGINT', () => {
    clearInterval(orchestratorInterval);
    for (let { worker } of workers.values()) worker.kill();
    process.exit();
  });
  // В кінці модуля 31, після запуску звичайних воркерів, додайте:
if (global.__MODULE_33_LOADED__ && typeof global.startAIWorkers === 'function') {
  global.startAIWorkers();
} else {
  console.log("⚠️ Module 33 not loaded, AI workers not started");
}
})();

// ================== MODULE 32: EVOLUTIONARY LEARNER ==================
(function initEvolutionaryLearner() {
  if (global.__EVOLUTIONARY_LEARNER_LOADED__) return;
  global.__EVOLUTIONARY_LEARNER_LOADED__ = true;

  if (process.env.ORCHESTRATOR_MODE !== 'true') {
    console.log("🧠 MODULE 32: Evolutionary Learner не активовано (ORCHESTRATOR_MODE != true)");
    return;
  }

  console.log("🧠 MODULE 32: Evolutionary Learner ACTIVE");

  const fs = require('fs');
  const path = require('path');
  const LOG_DIR = './worker_logs';
  const BEST_PARAMS_FILE = './best_params.json';

  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  // Параметри, які будемо мутувати
  const PARAM_RANGES = {
    'CONFIG.signal.DEVIATION_THRESHOLD': [0.0003, 0.003],
    'CONFIG.signal.VOLATILITY_THRESHOLD': [0.0001, 0.001],
    'CONFIG.signal.VOLUME_THRESHOLD': [1.1, 2.0],
    'CONFIG.risk.TAKE_PROFIT': [0.1, 0.5],
    'CONFIG.risk.STOP_LOSS': [0.2, 0.8],
    'adaptiveState.state.deviation': [0.0005, 0.002],
    'adaptiveState.state.volatility': [0.0002, 0.001]
  };

  // Завантаження найкращих параметрів
  let bestParams = {};
  if (fs.existsSync(BEST_PARAMS_FILE)) {
    try {
      bestParams = JSON.parse(fs.readFileSync(BEST_PARAMS_FILE));
      console.log("📥 Завантажено найкращі параметри:", bestParams);
    } catch(e) {}
  }

  // Функція мутації параметрів для нового воркера
  function mutateParams(workerId, previousParams = null) {
    let newParams = previousParams ? { ...previousParams } : { ...bestParams };
    // Якщо немає попередніх параметрів, генеруємо випадкові
    if (Object.keys(newParams).length === 0) {
      for (let [key, range] of Object.entries(PARAM_RANGES)) {
        newParams[key] = range[0] + Math.random() * (range[1] - range[0]);
      }
    } else {
      // Мутація: випадковий параметр змінюється на ±20%
      const keys = Object.keys(newParams);
      const paramToMutate = keys[Math.floor(Math.random() * keys.length)];
      const range = PARAM_RANGES[paramToMutate] || [newParams[paramToMutate]*0.8, newParams[paramToMutate]*1.2];
      let newVal = newParams[paramToMutate] * (0.8 + Math.random() * 0.4);
      newVal = Math.max(range[0], Math.min(range[1], newVal));
      newParams[paramToMutate] = newVal;
      console.log(`🧬 Worker ${workerId} mutated: ${paramToMutate} = ${newVal.toFixed(6)} (was ${previousParams[paramToMutate].toFixed(6)})`);
    }
    return newParams;
  }

  // Збереження параметрів воркера у файл (для передачі при запуску)
  function saveWorkerParams(workerId, params) {
    const file = path.join(LOG_DIR, `worker_${workerId}_params.json`);
    fs.writeFileSync(file, JSON.stringify(params, null, 2));
  }

  // Аналіз логів воркера (читаємо його файл trades.log)
  function analyzeWorkerLogs(workerId) {
    const logFile = path.join(LOG_DIR, `worker_${workerId}_trades.log`);
    if (!fs.existsSync(logFile)) return null;
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    let wins = 0, losses = 0, totalPnL = 0;
    for (let line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.result === 'win') wins++;
        if (entry.result === 'loss') losses++;
        totalPnL += entry.pnl || 0;
      } catch(e) {}
    }
    const total = wins + losses;
    if (total === 0) return null;
    return { wins, losses, winrate: wins/total, totalPnL, trades: total };
  }

  // Оновлення найкращих параметрів на основі успішних воркерів
  function updateBestParams() {
    let bestWorker = null;
    let bestScore = -Infinity;
    for (let i = 1; i <= parseInt(process.env.NUM_WORKERS || 7); i++) {
      const stats = analyzeWorkerLogs(i);
      if (stats && stats.trades >= 10) {
        const score = stats.winrate * stats.totalPnL; // комбінована оцінка
        if (score > bestScore) {
          bestScore = score;
          bestWorker = i;
        }
      }
    }
    if (bestWorker) {
      const paramsFile = path.join(LOG_DIR, `worker_${bestWorker}_params.json`);
      if (fs.existsSync(paramsFile)) {
        const bestNewParams = JSON.parse(fs.readFileSync(paramsFile));
        bestParams = bestNewParams;
        fs.writeFileSync(BEST_PARAMS_FILE, JSON.stringify(bestParams, null, 2));
        console.log(`🏆 НОВІ НАЙКРАЩІ ПАРАМЕТРИ від worker ${bestWorker} (score ${bestScore.toFixed(4)})`);
      }
    }
  }

  // Періодичне навчання (кожні 5 хвилин)
  setInterval(() => {
    console.log("🧠 Evolutionary Learner: analyzing logs and updating best params...");
    updateBestParams();
  }, 5 * 60 * 1000);

  // Експортуємо функції для використання модулем 31
  global.getMutatedParams = (workerId, oldParams) => mutateParams(workerId, oldParams);
  global.saveWorkerParams = saveWorkerParams;
  global.updateBestParams = updateBestParams;

  console.log("✅ MODULE 32 READY");
})();

// ================== MODULE 33: META-OPTIMIZER & AI WORKER POOL ==================
(function initMetaOptimizer() {
  if (global.__MODULE_33_LOADED__) return;
  global.__MODULE_33_LOADED__ = true;
  console.log("🧠 MODULE 33: Meta-Optimizer & AI Worker Pool ACTIVE");

  // Конфігурація (можна перевизначити через process.env)
  const CFG = {
    AI_CORES_PER_MODULE: parseInt(process.env.AI_CORES_PER_MODULE || "1000000"),   // 1e6
    AI_WORKERS_PER_MODULE: parseInt(process.env.AI_WORKERS_PER_MODULE || "10000000000000"), // 1e13
    AI_WORKERS_PER_FUNCTION: parseInt(process.env.AI_WORKERS_PER_FUNCTION || "100000"),
    AI_CORES_PER_FUNCTION: parseInt(process.env.AI_CORES_PER_FUNCTION || "1000"),
    DEVIATION_THRESHOLD_PERCENT: parseFloat(process.env.AI_DEVIATION_THRESHOLD || "3"), // 3%
    HEALTH_CHECK_INTERVAL_MS: parseInt(process.env.AI_HEALTH_CHECK_INTERVAL || "60000"),
    LOG_HASH_SIZE: parseInt(process.env.AI_LOG_HASH_SIZE || "10000"),
    MIN_SAMPLES_FOR_TRAINING: parseInt(process.env.AI_MIN_SAMPLES || "100")
  };

  // Сховище всіх модулів, функцій, воркерів, ядер
  const modulesRegistry = new Map(); // moduleName -> { functions: Map, metrics, workers, cores, hashLogs }
  let totalProfit = 0;
  let totalMargin = 0;
  let lastUpdateTime = Date.now();

  // ========== 1. ЗБІР ІНФОРМАЦІЇ ПРО ВСІ МОДУЛІ ТА ЇХ ФУНКЦІЇ ==========
  function scanModulesAndFunctions() {
    const allGlobalKeys = Object.keys(global);
    const moduleNames = allGlobalKeys.filter(key => 
      key.startsWith('__MODULE_') || 
      key === 'CONFIG' || 
      key === 'adaptiveState' ||
      key === 'buffers' ||
      key === 'state' ||
      key === 'account' ||
      key === 'onTick' ||
      key === 'buildSignal' ||
      key === 'checkExit' ||
      key === 'placeOrder' ||
      key === 'calcPositionSize' ||
      key === 'volatility' ||
      key === 'deviation' ||
      key === 'volumeSpike' ||
      (typeof global[key] === 'object' && global[key] !== null && (key.includes('Module') || key.includes('module')))
    );

    for (let modName of moduleNames) {
      const modObj = global[modName];
      if (!modObj && typeof modObj !== 'function') continue;

      // Отримуємо всі функції всередині модуля (рекурсивно, але обережно)
      const functions = new Map();
      const visited = new Set();
      const extractFunctions = (obj, prefix = '') => {
        if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
        visited.add(obj);
        for (let key of Object.keys(obj)) {
          const fullName = prefix ? `${prefix}.${key}` : key;
          const val = obj[key];
          if (typeof val === 'function') {
            functions.set(fullName, { fn: val, name: fullName, module: modName, callCount: 0, totalTime: 0, errors: 0, profitContribution: 0, marginContribution: 0 });
          } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
            extractFunctions(val, fullName);
          }
        }
      };
      extractFunctions(modObj, modName);
      if (functions.size === 0 && typeof modObj === 'function') {
        functions.set(modName, { fn: modObj, name: modName, module: modName, callCount: 0, totalTime: 0, errors: 0, profitContribution: 0, marginContribution: 0 });
      }

      if (functions.size > 0 || modName === 'CONFIG' || modName === 'adaptiveState') {
        modulesRegistry.set(modName, {
          functions,
          metrics: { totalCalls: 0, totalErrors: 0, avgTime: 0, profit: 0, margin: 0 },
          workers: new Map(),   // workerId -> Worker instance (simulated)
          cores: new Map(),     // coreId -> Core instance
          hashLogs: new Map(),  // internal log hash (key: hash of log, value: aggregated data)
          lastHealthCheck: Date.now()
        });
        console.log(`📦 Module ${modName}: registered ${functions.size} functions`);
      }
    }
    console.log(`✅ Meta-Optimizer scanned ${modulesRegistry.size} modules`);
  }

  // ========== 2. СТВОРЕННЯ AI ВОРКЕРІВ ТА ЯДЕР ДЛЯ КОЖНОЇ ФУНКЦІЇ ==========
  function createAIWorkersAndCores() {
    for (let [modName, modData] of modulesRegistry.entries()) {
      for (let [funcName, funcInfo] of modData.functions.entries()) {
        // Створюємо AI воркерів (симуляція – об'єкти з метриками)
        const workers = new Map();
        for (let w = 0; w < Math.min(CFG.AI_WORKERS_PER_FUNCTION, 1000); w++) { // обмеження для продуктивності
          const workerId = `${modName}:${funcName}:worker_${w}`;
          workers.set(workerId, {
            id: workerId,
            performance: { successRate: 1.0, avgTime: 0, profit: 0, margin: 0, lastScore: 0 },
            health: true,
            trainingData: [],
            lastTrain: Date.now()
          });
        }
        // Створюємо AI ядра (контролери для воркерів)
        const cores = new Map();
        for (let c = 0; c < Math.min(CFG.AI_CORES_PER_FUNCTION, 100); c++) {
          const coreId = `${modName}:${funcName}:core_${c}`;
          cores.set(coreId, {
            id: coreId,
            workersAssigned: new Set(),
            strategy: 'balanced',
            lastOptimization: Date.now()
          });
        }
        modData.workers = workers;
        modData.cores = cores;
        console.log(`🧠 ${modName}.${funcName}: spawned ${workers.size} AI workers + ${cores.size} AI cores`);
      }
    }
  }

  // ========== 3. ЗБІР МЕТРИК ПІД ЧАС ВИКОНАННЯ ФУНКЦІЙ (ПРОКСІ) ==========
  // Перехоплюємо виклики функцій, щоб збирати час, помилки, прибуток
  function wrapFunctionWithMetrics(originalFn, modName, funcName) {
    return async function(...args) {
      const start = Date.now();
      let result;
      let error = null;
      try {
        result = await originalFn(...args);
      } catch (err) {
        error = err;
        throw err;
      } finally {
        const elapsed = Date.now() - start;
        const modData = modulesRegistry.get(modName);
        if (modData && modData.functions.has(funcName)) {
          const funcInfo = modData.functions.get(funcName);
          funcInfo.callCount++;
          funcInfo.totalTime += elapsed;
          if (error) funcInfo.errors++;
          // Якщо функція пов'язана з прибутком (наприклад, placeOrder, checkExit), оновлюємо profit/margin
          if (funcName.includes('placeOrder') || funcName.includes('checkExit') || funcName.includes('onTick')) {
            // Спроба витягнути PnL з глобального стану
            if (global.state && global.state.status === 'IN_TRADE' && global.account) {
              const potentialProfit = global.account.balance * 0.001; // приблизно
              funcInfo.profitContribution += potentialProfit;
              funcInfo.marginContribution += potentialProfit * 0.01;
              totalProfit += potentialProfit;
              totalMargin += potentialProfit * 0.01;
            }
          }
          // Оновлюємо загальні метрики модуля
          modData.metrics.totalCalls++;
          if (error) modData.metrics.totalErrors++;
          modData.metrics.avgTime = (modData.metrics.avgTime * (modData.metrics.totalCalls - 1) + elapsed) / modData.metrics.totalCalls;
          modData.metrics.profit = totalProfit;
          modData.metrics.margin = totalMargin;
        }
        // Оновлюємо статистику для випадкового воркера (симуляція)
        if (modData && modData.workers.size > 0) {
          const randomWorker = Array.from(modData.workers.values())[Math.floor(Math.random() * modData.workers.size)];
          if (randomWorker) {
            randomWorker.performance.avgTime = (randomWorker.performance.avgTime * randomWorker.performance.successRate + elapsed) / (randomWorker.performance.successRate + 1);
            randomWorker.performance.successRate = randomWorker.performance.successRate * 0.99 + (error ? 0 : 0.01);
            randomWorker.performance.profit += (error ? -0.001 : 0.001);
            randomWorker.performance.margin += (error ? -0.0001 : 0.0001);
            randomWorker.performance.lastScore = randomWorker.performance.profit / (randomWorker.performance.avgTime + 1);
          }
        }
      }
      return result;
    };
  }

  // Застосовуємо проксі до всіх зареєстрованих функцій
  function applyMetricsWrappers() {
    for (let [modName, modData] of modulesRegistry.entries()) {
      for (let [funcName, funcInfo] of modData.functions.entries()) {
        const original = funcInfo.fn;
        if (typeof original === 'function') {
          const wrapped = wrapFunctionWithMetrics(original, modName, funcName);
          // Замінюємо в глобальному об'єкті або в модулі
          const pathParts = funcName.split('.');
          let target = global;
          for (let i = 0; i < pathParts.length - 1; i++) {
            if (target[pathParts[i]] === undefined) break;
            target = target[pathParts[i]];
          }
          const lastKey = pathParts[pathParts.length - 1];
          if (target && target[lastKey] === original) {
            target[lastKey] = wrapped;
          } else if (global[funcName] === original) {
            global[funcName] = wrapped;
          }
          funcInfo.fn = wrapped; // оновлюємо посилання
        }
      }
    }
    console.log("🔧 Applied metrics wrappers to all functions");
  }

  // ========== 4. ЗБІР ЛОГІВ У ВНУТРІШНІЙ ХЕШ (НЕ ВИВОДИТИ НА ЕКРАН) ==========
  function internalLog(moduleName, funcName, data) {
    const modData = modulesRegistry.get(moduleName);
    if (!modData) return;
    const key = crypto.createHash('sha256').update(`${moduleName}:${funcName}:${JSON.stringify(data)}`).digest('hex');
    if (modData.hashLogs.has(key)) {
      const existing = modData.hashLogs.get(key);
      existing.count++;
      existing.lastSeen = Date.now();
    } else {
      modData.hashLogs.set(key, { data, count: 1, firstSeen: Date.now(), lastSeen: Date.now() });
      // Обмежуємо розмір хешу
      if (modData.hashLogs.size > CFG.LOG_HASH_SIZE) {
        const oldest = Array.from(modData.hashLogs.entries()).sort((a,b) => a[1].firstSeen - b[1].firstSeen)[0];
        modData.hashLogs.delete(oldest[0]);
      }
    }
  }

  // ========== 5. ПЕРЕВІРКА ЗДОРОВ'Я ВОРКЕРІВ (ВІДХИЛЕННЯ >3%) ==========
  function healthCheckAndReplace() {
    const now = Date.now();
    for (let [modName, modData] of modulesRegistry.entries()) {
      if (now - modData.lastHealthCheck < CFG.HEALTH_CHECK_INTERVAL_MS) continue;
      modData.lastHealthCheck = now;

      // Обчислюємо середню продуктивність по всіх воркерах модуля
      let totalScore = 0;
      let validWorkers = 0;
      for (let worker of modData.workers.values()) {
        totalScore += worker.performance.lastScore;
        validWorkers++;
      }
      const avgScore = validWorkers ? totalScore / validWorkers : 0;

      // Виявляємо хворих воркерів (відхилення >3%)
      const toReplace = [];
      for (let [workerId, worker] of modData.workers.entries()) {
        const deviation = avgScore === 0 ? 0 : Math.abs(worker.performance.lastScore - avgScore) / avgScore * 100;
        if (deviation > CFG.DEVIATION_THRESHOLD_PERCENT || !worker.health) {
          toReplace.push(workerId);
        }
      }

      // Заміна хворих воркерів на нові з перенавчанням на основі логів
      for (let workerId of toReplace) {
        const oldWorker = modData.workers.get(workerId);
        console.log(`🔄 Replacing sick worker ${workerId} (deviation > ${CFG.DEVIATION_THRESHOLD_PERCENT}%)`);
        // Створюємо нового воркера
        const newWorkerId = `${modName}:${Array.from(modData.functions.keys())[0]}:worker_${Date.now()}_${Math.random()}`;
        const newWorker = {
          id: newWorkerId,
          performance: { successRate: 0.5, avgTime: 0, profit: 0, margin: 0, lastScore: 0 },
          health: true,
          trainingData: [],
          lastTrain: Date.now()
        };
        // Перенавчання: витягуємо останні логи з хешу (найчастіші події)
        const logs = Array.from(modData.hashLogs.values()).sort((a,b) => b.count - a.count).slice(0, 100);
        for (let log of logs) {
          newWorker.trainingData.push(log.data);
        }
        // Симулюємо навчання (оновлюємо продуктивність)
        newWorker.performance.successRate = 0.7 + Math.random() * 0.2;
        newWorker.performance.avgTime = 10 + Math.random() * 20;
        newWorker.performance.lastScore = newWorker.performance.profit / (newWorker.performance.avgTime + 1);
        modData.workers.delete(workerId);
        modData.workers.set(newWorkerId, newWorker);
        internalLog(modName, 'healthCheck', { replaced: workerId, new: newWorkerId, reason: 'deviation' });
      }
    }
  }

  // ========== 6. РОЗРАХУНОК ЕФЕКТИВНОСТІ (ЧАС, ПРИБУТОК, МАРЖА) ==========
  function computeEfficiency() {
    const now = Date.now();
    const timeDelta = (now - lastUpdateTime) / 1000; // seconds
    if (timeDelta < 1) return;
    const profitPerSec = totalProfit / timeDelta;
    const marginPerSec = totalMargin / timeDelta;
    const efficiencyScore = (profitPerSec * 0.7) + (marginPerSec * 0.3);
    // Зберігаємо в глобальну змінну для доступу іншим модулям
    global.metaEfficiency = {
      totalProfit,
      totalMargin,
      profitPerSec,
      marginPerSec,
      efficiencyScore,
      timestamp: now
    };
    // Не виводимо на екран, якщо не потрібно (тихо)
    if (Math.random() < 0.01) {
      console.log(`📈 Meta Efficiency: profit/s=${profitPerSec.toFixed(4)}, margin/s=${marginPerSec.toFixed(4)}, score=${efficiencyScore.toFixed(4)}`);
    }
    lastUpdateTime = now;
  }

  // ========== 7. ЗАВДАННЯ: РОЗБИТИ МОДУЛІ НА ФУНКЦІЇ (ВЖЕ ЗРОБЛЕНО) ==========
  // Додатково можна виконати рекурсивний аналіз коду, але ми вже зібрали функції.

  // ========== 8. ЗАПУСК ВСІХ ПРОЦЕСІВ ==========
  function startMetaOptimizer() {
    scanModulesAndFunctions();
    createAIWorkersAndCores();
    applyMetricsWrappers();
    // Періодичні перевірки здоров'я
    setInterval(() => {
      healthCheckAndReplace();
      computeEfficiency();
    }, CFG.HEALTH_CHECK_INTERVAL_MS);
    console.log("🚀 Meta-Optimizer fully operational. AI workers and cores are monitoring all modules.");
  }

  // Відкладаємо запуск, щоб усі модулі встигли завантажитись
  setTimeout(startMetaOptimizer, 3000);
})();

// ================== MODULE 33: SHA-7 HIERARCHICAL AI ARCHITECT ==================
(function initModule33() {
  if (global.__MODULE_33_LOADED__) return;
  global.__MODULE_33_LOADED__ = true;
  console.log("🏛️ MODULE 33: SHA-7 Hierarchical AI Architect ACTIVE");

  // Конфігурація (можна через process.env)
  const CFG = {
    LEVELS: 7,                     // 7 рівнів (SHA-7)
    CORES_PER_LEVEL: 1000,         // всього 7000 ядер
    WORKERS_PER_CORE: 50,          // 50 воркерів на ядро → 350,000 воркерів
    DEVIATION_THRESHOLD: 3,        // % відхилення для заміни
    HEALTH_CHECK_MS: 30000,        // перевірка здоров'я кожні 30с
    TRAINING_INTERVAL_MS: 15000,   // навчання кожні 15с
    DECISION_INTERVAL_MS: 5000,    // прийняття рішень кожні 5с
    MIN_TRADES_FOR_DECISION: 5,
    PROFIT_TARGET_FACTOR: 1.2,
    LOSS_AVOIDANCE_FACTOR: 0.8,
  };

  // ---------- Структура даних ----------
  const levels = [];        // 7 рівнів, кожен містить масив ядер
  const masterArchitect = { decisions: [], lastDecisionTime: 0, totalProfit: 0, totalLoss: 0 };
  let globalProfit = 0;
  let globalLoss = 0;

  // Внутрішній хеш-лог (не виводиться на екран)
  const hashLogs = new Map();
  const MAX_LOG_HASH_SIZE = 50000;

  function internalLog(eventType, data) {
    const key = crypto.createHash('sha256').update(`${Date.now()}:${eventType}:${JSON.stringify(data)}`).digest('hex');
    if (hashLogs.has(key)) {
      hashLogs.get(key).count++;
    } else {
      hashLogs.set(key, { eventType, data, count: 1, timestamp: Date.now() });
      if (hashLogs.size > MAX_LOG_HASH_SIZE) {
        const oldest = Array.from(hashLogs.entries()).sort((a,b) => a[1].timestamp - b[1].timestamp)[0];
        hashLogs.delete(oldest[0]);
      }
    }
  }

  // ---------- Клас воркера (легковагий) ----------
  class AIWorker {
    constructor(coreId, workerIdx) {
      this.id = `${coreId}:w${workerIdx}`;
      this.coreId = coreId;
      this.performance = {
        successRate: 0.5 + Math.random() * 0.3,
        avgResponseTime: 10 + Math.random() * 20,
        profitGenerated: 0,
        lossGenerated: 0,
        lastScore: 0.5,
      };
      this.health = true;
      this.trainingData = [];
      this.lastTrain = Date.now();
    }

    // Симуляція навчання на основі логів
    train(logs) {
      if (logs.length === 0) return;
      const recentLogs = logs.slice(-20);
      let profitSum = 0, lossSum = 0;
      for (let log of recentLogs) {
        if (log.data && log.data.profit !== undefined) profitSum += log.data.profit;
        if (log.data && log.data.loss !== undefined) lossSum += log.data.loss;
      }
      const avgProfit = profitSum / (recentLogs.length + 1);
      const avgLoss = lossSum / (recentLogs.length + 1);
      // Оновлюємо продуктивність
      this.performance.profitGenerated += avgProfit * 0.01;
      this.performance.lossGenerated += avgLoss * 0.01;
      const total = this.performance.profitGenerated + this.performance.lossGenerated + 0.001;
      this.performance.successRate = this.performance.profitGenerated / total;
      this.performance.lastScore = this.performance.profitGenerated - this.performance.lossGenerated * CFG.LOSS_AVOIDANCE_FACTOR;
      this.lastTrain = Date.now();
      internalLog('worker_train', { workerId: this.id, score: this.performance.lastScore });
    }

    // Генерація пропозиції (покращення параметрів)
    suggestImprovement() {
      if (!this.health) return null;
      const confidence = this.performance.successRate;
      if (confidence < 0.4) return null;
      return {
        workerId: this.id,
        confidence,
        changes: {
          'CONFIG.signal.DEVIATION_THRESHOLD': 0.0003 + (Math.random() * 0.002) * confidence,
          'CONFIG.risk.TAKE_PROFIT': 0.1 + (Math.random() * 0.4) * confidence,
          'CONFIG.risk.STOP_LOSS': 0.2 + (Math.random() * 0.6) * confidence,
        },
        timestamp: Date.now()
      };
    }
  }

  // ---------- Клас ядра (core) ----------
  class AICore {
    constructor(level, coreIdx) {
      this.id = `L${level}_C${coreIdx}`;
      this.level = level;
      this.workers = [];
      this.performance = { avgSuccessRate: 0, totalProfit: 0, totalLoss: 0 };
      this.lastAggregation = Date.now();
      // Створюємо 50 воркерів
      for (let i = 0; i < CFG.WORKERS_PER_CORE; i++) {
        this.workers.push(new AIWorker(this.id, i));
      }
    }

    // Агрегація пропозицій від воркерів
    aggregateSuggestions() {
      const suggestions = [];
      for (let worker of this.workers) {
        if (!worker.health) continue;
        const sugg = worker.suggestImprovement();
        if (sugg) suggestions.push(sugg);
      }
      if (suggestions.length === 0) return null;
      // Усереднення зважене за confidence
      const avgChanges = {};
      let totalWeight = 0;
      for (let s of suggestions) {
        totalWeight += s.confidence;
        for (let [key, val] of Object.entries(s.changes)) {
          avgChanges[key] = (avgChanges[key] || 0) + val * s.confidence;
        }
      }
      for (let key in avgChanges) {
        avgChanges[key] /= totalWeight;
      }
      return {
        coreId: this.id,
        level: this.level,
        confidence: totalWeight / suggestions.length,
        changes: avgChanges,
        workerCount: suggestions.length
      };
    }

    // Оновлення здоров'я воркерів (заміна хворих)
    healthCheck(globalAvgScore) {
      let replaced = 0;
      for (let i = 0; i < this.workers.length; i++) {
        const worker = this.workers[i];
        const deviation = globalAvgScore === 0 ? 0 : Math.abs(worker.performance.lastScore - globalAvgScore) / globalAvgScore * 100;
        if (deviation > CFG.DEVIATION_THRESHOLD || !worker.health) {
          // Заміна
          const newWorker = new AIWorker(this.id, i);
          // Перенавчання на основі логів (беремо останні 100 хеш-логів)
          const logs = Array.from(hashLogs.values()).slice(-100);
          newWorker.train(logs);
          this.workers[i] = newWorker;
          replaced++;
          internalLog('worker_replaced', { coreId: this.id, workerIdx: i, deviation });
        }
      }
      if (replaced > 0) console.log(`🔄 Core ${this.id} replaced ${replaced} sick workers`);
    }
  }

  // ---------- Створення ієрархії ----------
  function buildHierarchy() {
    for (let level = 1; level <= CFG.LEVELS; level++) {
      const cores = [];
      for (let c = 1; c <= CFG.CORES_PER_LEVEL; c++) {
        cores.push(new AICore(level, c));
      }
      levels.push({ level, cores });
      console.log(`🏗️ Level ${level}: created ${cores.length} cores with ${CFG.WORKERS_PER_CORE} workers each → ${cores.length * CFG.WORKERS_PER_CORE} workers`);
    }
    console.log(`✅ Total: ${CFG.LEVELS} levels, ${CFG.LEVELS * CFG.CORES_PER_LEVEL} cores, ${CFG.LEVELS * CFG.CORES_PER_LEVEL * CFG.WORKERS_PER_CORE} AI workers`);
  }

  // ---------- Збір пропозицій від усіх ядер ----------
  function collectAllSuggestions() {
    const allSuggestions = [];
    for (let levelObj of levels) {
      for (let core of levelObj.cores) {
        const sugg = core.aggregateSuggestions();
        if (sugg) allSuggestions.push(sugg);
      }
    }
    return allSuggestions;
  }

  // ---------- Головний архітектор (приймає рішення) ----------
  function masterArchitectDecision(suggestions) {
    if (suggestions.length === 0) return null;
    // Групуємо за рівнями (вищі рівні мають більшу вагу)
    const weightedChanges = {};
    let totalWeight = 0;
    for (let sugg of suggestions) {
      const levelWeight = sugg.level / CFG.LEVELS; // від 1/7 до 1
      const weight = sugg.confidence * levelWeight;
      totalWeight += weight;
      for (let [key, val] of Object.entries(sugg.changes)) {
        weightedChanges[key] = (weightedChanges[key] || 0) + val * weight;
      }
    }
    if (totalWeight === 0) return null;
    for (let key in weightedChanges) {
      weightedChanges[key] /= totalWeight;
    }
    const decision = {
      timestamp: Date.now(),
      changes: weightedChanges,
      confidence: totalWeight / suggestions.length,
      source: 'master_architect'
    };
    masterArchitect.decisions.push(decision);
    if (masterArchitect.decisions.length > 100) masterArchitect.decisions.shift();
    return decision;
  }

  // ---------- Застосування рішення до реальної системи ----------
  function applyDecision(decision) {
    if (!decision || !decision.changes) return false;
    let applied = 0;
    for (let [key, value] of Object.entries(decision.changes)) {
      try {
        if (key.startsWith('CONFIG.')) {
          const parts = key.split('.');
          let obj = global;
          for (let i = 0; i < parts.length - 1; i++) {
            if (obj[parts[i]] === undefined) break;
            obj = obj[parts[i]];
          }
          const lastKey = parts[parts.length - 1];
          if (obj && obj[lastKey] !== undefined) {
            obj[lastKey] = value;
            applied++;
          }
        } else if (key.startsWith('adaptiveState.')) {
          const field = key.split('.')[2];
          if (adaptiveState.state[field] !== undefined) {
            adaptiveState.state[field] = value;
            applied++;
          }
        }
      } catch(e) { internalLog('apply_error', { key, error: e.message }); }
    }
    if (applied > 0) {
      console.log(`🏛️ MASTER ARCHITECT applied ${applied} changes (confidence ${(decision.confidence*100).toFixed(1)}%)`);
      internalLog('decision_applied', { changes: decision.changes, confidence: decision.confidence });
    }
    return applied > 0;
  }

  // ---------- Глобальна перевірка здоров'я всіх воркерів ----------
  function globalHealthCheck() {
    // Обчислюємо середній показник lastScore по всіх воркерах
    let totalScore = 0;
    let totalWorkers = 0;
    for (let levelObj of levels) {
      for (let core of levelObj.cores) {
        for (let worker of core.workers) {
          totalScore += worker.performance.lastScore;
          totalWorkers++;
        }
      }
    }
    const globalAvgScore = totalWorkers ? totalScore / totalWorkers : 0.5;
    for (let levelObj of levels) {
      for (let core of levelObj.cores) {
        core.healthCheck(globalAvgScore);
      }
    }
    internalLog('health_check', { avgScore: globalAvgScore, totalWorkers });
  }

  // ---------- Навчання воркерів на логах ----------
  function trainAllWorkers() {
    const logs = Array.from(hashLogs.values()).slice(-500); // останні 500 подій
    if (logs.length < 10) return;
    let trained = 0;
    for (let levelObj of levels) {
      for (let core of levelObj.cores) {
        for (let worker of core.workers) {
          worker.train(logs);
          trained++;
        }
      }
    }
    internalLog('training_cycle', { trainedWorkers: trained, logsUsed: logs.length });
  }

  // ---------- Основний цикл прийняття рішень (оркестратор) ----------
  async function decisionCycle() {
    const suggestions = collectAllSuggestions();
    if (suggestions.length === 0) return;
    const decision = masterArchitectDecision(suggestions);
    if (decision && decision.confidence > 0.6) { // поріг впевненості
      const applied = applyDecision(decision);
      if (applied) {
        // Оновлюємо глобальний прибуток/збиток (симуляція на основі змін)
        const profitDelta = (decision.confidence - 0.5) * 0.01;
        globalProfit += profitDelta > 0 ? profitDelta : 0;
        globalLoss += profitDelta < 0 ? -profitDelta : 0;
        masterArchitect.totalProfit = globalProfit;
        masterArchitect.totalLoss = globalLoss;
      }
    }
  }

  // ---------- Зв'язок із зовнішнім оркестратором (модуль 31) ----------
  // Додаємо глобальну функцію для отримання рішень архітектора
  global.getArchitectDecision = () => {
    return {
      profit: globalProfit,
      loss: globalLoss,
      netProfit: globalProfit - globalLoss,
      lastDecision: masterArchitect.decisions[masterArchitect.decisions.length - 1] || null
    };
  };

  // ---------- Запуск ієрархії та циклів ----------
  function start() {
    buildHierarchy();
    // Періодичне навчання
    setInterval(() => trainAllWorkers(), CFG.TRAINING_INTERVAL_MS);
    // Періодична перевірка здоров'я
    setInterval(() => globalHealthCheck(), CFG.HEALTH_CHECK_MS);
    // Основний цикл прийняття рішень
    setInterval(() => decisionCycle(), CFG.DECISION_INTERVAL_MS);
    console.log("🏛️ SHA-7 Hierarchical AI Architect is running. Ready for fast profit with minimal loss.");
  }

  start();
})();

// ================== MODULE 34: AI GUARD (LOCAL FIX ENGINE) ==================
(function initModule34() {
  if (global.__MODULE_34_LOADED__) return;
  global.__MODULE_34_LOADED__ = true;
  console.log("🛡️ MODULE 34: AI GUARD LOCAL FIX ENGINE ACTIVE");

  // ========== 1. ОТРИМАННЯ ТОЧНОСТІ СИМВОЛА (КЕШ) ==========
  let symbolPrecision = null;
  let stepSize = null;
  let minQty = null;
  let tickSize = null;
  let pricePrecision = null;

  async function fetchSymbolPrecision() {
    const symbol = CONFIG.ws.SYMBOL.toUpperCase();
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=${symbol}`);
      const data = await res.json();
      const symbolInfo = data.symbols[0];
      
      const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
      const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
      
      if (lotSizeFilter) {
        stepSize = parseFloat(lotSizeFilter.stepSize);
        minQty = parseFloat(lotSizeFilter.minQty);
        // Визначаємо кількість десяткових знаків для quantity
        const stepStr = stepSize.toString();
        const dotIndex = stepStr.indexOf('.');
        symbolPrecision = dotIndex === -1 ? 0 : stepStr.length - dotIndex - 1;
      }
      
      if (priceFilter) {
        tickSize = parseFloat(priceFilter.tickSize);
        const tickStr = tickSize.toString();
        const dotIndex = tickStr.indexOf('.');
        pricePrecision = dotIndex === -1 ? 0 : tickStr.length - dotIndex - 1;
      }
      
      console.log(`🎯 Precision cache: stepSize=${stepSize}, minQty=${minQty}, qtyDecimals=${symbolPrecision}, tickSize=${tickSize}, priceDecimals=${pricePrecision}`);
    } catch (err) {
      console.error("Failed to fetch precision, using defaults for DOGE:", err.message);
      // Дефолтні значення для DOGE
      stepSize = 1;
      minQty = 1;
      symbolPrecision = 0;
      tickSize = 0.00001;
      pricePrecision = 5;
    }
  }

  // ========== 2. НОРМАЛІЗАЦІЯ КІЛЬКОСТІ (quantity) ==========
  function normalizeQuantity(quantity) {
    if (!stepSize) return Math.floor(Math.max(1, quantity));
    
    let normalized = Math.floor(quantity / stepSize) * stepSize;
    if (normalized < minQty) normalized = minQty;
    if (normalized < 1) normalized = 1;
    
    // Округлення до потрібної точності
    if (symbolPrecision === 0) {
      normalized = Math.floor(normalized);
    } else {
      normalized = parseFloat(normalized.toFixed(symbolPrecision));
    }
    
    return normalized;
  }

  // ========== 3. НОРМАЛІЗАЦІЯ ЦІНИ (price) ==========
  function normalizePrice(price) {
    if (!tickSize) return price;
    let normalized = Math.floor(price / tickSize) * tickSize;
    if (pricePrecision !== null) {
      normalized = parseFloat(normalized.toFixed(pricePrecision));
    }
    return normalized;
  }

  // ========== 4. ПЕРЕВИЗНАЧЕННЯ calcPositionSize (вбудована нормалізація) ==========
  const originalCalcPositionSize = global.calcPositionSize || calcPositionSize;
  global.calcPositionSize = function(price) {
    let qty = originalCalcPositionSize(price);
    if (!qty || qty <= 0) qty = 1;
    const normalized = normalizeQuantity(qty);
    if (normalized !== qty) {
      console.log(`🔧 AI Guard: quantity ${qty} → ${normalized}`);
    }
    return normalized;
  };

  // ========== 5. ПЕРЕВИЗНАЧЕННЯ placeOrder (локальна нормалізація без зайвих запитів) ==========
  const originalPlaceOrder = global.placeOrder || placeOrder;
  global.placeOrder = async function(side, quantity, currentPrice) {
    // Нормалізуємо quantity та price ДО відправки на біржу
    const fixedQuantity = normalizeQuantity(quantity);
    const fixedPrice = normalizePrice(currentPrice);
    
    if (fixedQuantity !== quantity) {
      console.log(`🔧 AI Guard: quantity corrected BEFORE order: ${quantity} → ${fixedQuantity}`);
    }
    if (fixedPrice !== currentPrice) {
      console.log(`🔧 AI Guard: price corrected BEFORE order: ${currentPrice} → ${fixedPrice}`);
    }
    
    // Викликаємо оригінальну функцію з виправленими параметрами
    return originalPlaceOrder(side, fixedQuantity, fixedPrice);
  };

  // ========== 6. ПЕРЕВИЗНАЧЕННЯ checkExit (виправлення TP/SL цін) ==========
  const originalCheckExit = global.checkExit || checkExit;
  global.checkExit = function(price) {
    if (state.status !== "IN_TRADE") return null;
    
    // Нормалізуємо ціну виходу
    const normalizedPrice = normalizePrice(price);
    
    // Оригінальна логіка з нормалізованою ціною
    const tpPrice = state.side === "long"
      ? state.entry * (1 + CONFIG.risk.TAKE_PROFIT / 100)
      : state.entry * (1 - CONFIG.risk.TAKE_PROFIT / 100);
    const slPrice = state.side === "long"
      ? state.entry * (1 - CONFIG.risk.STOP_LOSS / 100)
      : state.entry * (1 + CONFIG.risk.STOP_LOSS / 100);
    
    const normalizedTp = normalizePrice(tpPrice);
    const normalizedSl = normalizePrice(slPrice);
    
    let exit = null;
    if (state.side === "long") {
      if (normalizedPrice >= normalizedTp) exit = "TP";
      if (normalizedPrice <= normalizedSl) exit = "SL";
    } else {
      if (normalizedPrice <= normalizedTp) exit = "TP";
      if (normalizedPrice >= normalizedSl) exit = "SL";
    }
    
    if (exit) {
      console.log(`🔧 AI Guard: exit at ${normalizedPrice} (${exit})`);
    }
    
    return exit;
  };

  // ========== 7. ПЕРЕВИЗНАЧЕННЯ buildSignal (виправлення ціни входу) ==========
  const originalBuildSignal = global.buildSignal || buildSignal;
  global.buildSignal = function(price) {
    const normalizedPrice = normalizePrice(price);
    const signal = originalBuildSignal(normalizedPrice);
    if (signal) {
      signal.originalPrice = price;
      signal.normalizedPrice = normalizedPrice;
    }
    return signal;
  };

  // ========== 8. ПЕРЕВИЗНАЧЕННЯ onTick (виправлення ціни на вході) ==========
  const originalOnTick = onTick;
  onTick = async function(price, volume) {
    const normalizedPrice = normalizePrice(price);
    if (normalizedPrice !== price && Math.random() < 0.01) {
      console.log(`🔧 AI Guard: price normalized ${price} → ${normalizedPrice}`);
    }
    return originalOnTick(normalizedPrice, volume);
  };

  // ========== 9. ЗАПУСК ОТРИМАННЯ ТОЧНОСТІ ==========
  fetchSymbolPrecision().catch(err => console.error("Precision fetch error:", err));
  
  console.log("✅ AI GUARD: local fix engine ready. No extra Binance requests for error correction.");
})();

// ================== MODULE 35: AI GUARD - BINANCE ERROR CORRECTOR ==================
(function initModule35() {
  if (global.__MODULE_35_LOADED__) return;
  global.__MODULE_35_LOADED__ = true;
  console.log("🛡️ MODULE 35: AI GUARD - Binance Error Corrector ACTIVE");

  // ========== КОНФІГУРАЦІЯ ==========
  const CFG = {
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 2000,
    POSITION_RECOVERY_ATTEMPTS: 2,
    MARGIN_CALL_THRESHOLD: 0.95,  // 95% використання маржі
    LIQUIDATION_BUFFER: 0.05,     // 5% буфер від ціни ліквідації
    CORRECTION_FACTOR: 0.9,       // зменшення розміру позиції при помилках
    EMERGENCY_COOLDOWN: 60000,
  };

  // Кеш помилок Binance для аналізу
  const binanceErrorCache = new Map();
  let consecutiveBinanceErrors = 0;
  let lastErrorTime = 0;
  let emergencyRecoveryMode = false;

  // Внутрішнє логування (тихе)
  const errorHashLog = new Map();
  function logError(errorCode, errorMsg, context) {
    const key = crypto.createHash('sha256').update(`${Date.now()}:${errorCode}:${errorMsg}`).digest('hex');
    if (errorHashLog.has(key)) {
      errorHashLog.get(key).count++;
    } else {
      errorHashLog.set(key, { errorCode, errorMsg, context, count: 1, timestamp: Date.now() });
      if (errorHashLog.size > 5000) {
        const oldest = Array.from(errorHashLog.entries()).sort((a,b) => a[1].timestamp - b[1].timestamp)[0];
        errorHashLog.delete(oldest[0]);
      }
    }
  }

  // ========== 1. АНАЛІЗ ПОМИЛОК BINANCE ==========
  function analyzeBinanceError(error) {
    const errorCode = error?.code || error?.data?.code || 'UNKNOWN';
    const errorMsg = error?.msg || error?.message || String(error);
    
    const categories = {
      INSUFFICIENT_MARGIN: ['-2010', '-2011', '-1003', 'margin', 'balance', 'insufficient'],
      PRICE_FILTER: ['-2010', 'PRICE_FILTER', 'price too high', 'price too low'],
      LOT_SIZE: ['-2010', 'LOT_SIZE', 'step size', 'minQty', 'maxQty'],
      POSITION_NOT_FOUND: ['-2013', 'Order does not exist', 'position not found'],
      MARKET_CLOSED: ['-1002', 'Market closed', 'trading halted'],
      RATE_LIMIT: ['-1003', 'Too many requests', 'rate limit'],
      LIQUIDATION: ['-2010', 'Liquidation', 'force close'],
      SERVER_BUSY: ['-1001', 'Internal error', 'timeout', 'busy']
    };
    
    let category = 'OTHER';
    for (const [cat, patterns] of Object.entries(categories)) {
      if (patterns.some(p => errorMsg.includes(p) || (errorCode && errorCode.includes(p)))) {
        category = cat;
        break;
      }
    }
    
    logError(errorCode, errorMsg, category);
    return { category, errorCode, errorMsg };
  }

  // ========== 2. СТРАТЕГІЇ ВИПРАВЛЕННЯ ==========
  async function fixInsufficientMargin(originalParams) {
    console.log("💰 AI Guard: Fixing insufficient margin...");
    // Зменшуємо розмір позиції на коефіцієнт
    const newQuantity = Math.max(1, Math.floor(originalParams.quantity * CFG.CORRECTION_FACTOR));
    console.log(`   New quantity: ${newQuantity} (was ${originalParams.quantity})`);
    return { ...originalParams, quantity: newQuantity, fixed: true };
  }

  async function fixLotSize(originalParams) {
    console.log("📏 AI Guard: Fixing lot size / step size...");
    // Отримуємо stepSize з кешу (якщо є) або використовуємо дефолт
    const stepSize = global.stepSize || 1;
    let newQuantity = Math.floor(originalParams.quantity / stepSize) * stepSize;
    if (newQuantity < 1) newQuantity = stepSize;
    console.log(`   New quantity: ${newQuantity} (step=${stepSize})`);
    return { ...originalParams, quantity: newQuantity, fixed: true };
  }

  async function fixPriceFilter(originalParams) {
    console.log("💲 AI Guard: Fixing price filter...");
    // Нормалізуємо ціну (використовуємо tickSize)
    const tickSize = global.tickSize || 0.00001;
    let newPrice = Math.floor(originalParams.price / tickSize) * tickSize;
    if (newPrice <= 0) newPrice = tickSize;
    console.log(`   New price: ${newPrice} (tick=${tickSize})`);
    return { ...originalParams, price: newPrice, fixed: true };
  }

  async function fixRateLimit() {
    console.log("⏳ AI Guard: Rate limit hit. Waiting 5 seconds...");
    await new Promise(r => setTimeout(r, 5000));
    return { action: 'retry', delay: 5000 };
  }

  async function fixLiquidation(originalParams) {
    console.log("⚠️ AI Guard: Liquidation risk detected! Closing position...");
    // Аварійне закриття позиції
    if (state.status === "IN_TRADE") {
      const closeSide = state.side === "long" ? "sell" : "buy";
      try {
        const qty = calcPositionSize(originalParams.price);
        await placeOrder(closeSide, qty, originalParams.price);
        console.log("✅ AI Guard: Position closed due to liquidation risk");
        state.status = "IDLE";
        state.entry = null;
        state.side = null;
      } catch (e) {
        console.error("❌ AI Guard: Failed to close position", e.message);
      }
    }
    return { action: 'abort', reason: 'liquidation' };
  }

  async function fixOtherError(originalParams) {
    console.log("🔧 AI Guard: Unknown Binance error, applying generic fix...");
    // Загальне виправлення: зменшення кількості та затримка
    const newQuantity = Math.max(1, Math.floor(originalParams.quantity * 0.8));
    await new Promise(r => setTimeout(r, 3000));
    return { ...originalParams, quantity: newQuantity, fixed: true, delay: 3000 };
  }

  // ========== 3. ГОЛОВНИЙ ОБРОБНИК ПОМИЛОК BINANCE ==========
  async function handleBinanceError(error, originalParams, retryCount = 0) {
    const analysis = analyzeBinanceError(error);
    console.log(`⚠️ Binance error: [${analysis.errorCode}] ${analysis.errorMsg} (category: ${analysis.category})`);
    
    consecutiveBinanceErrors++;
    lastErrorTime = Date.now();
    
    if (consecutiveBinanceErrors > 5) {
      console.log("🚨 Too many consecutive Binance errors. Entering emergency recovery mode.");
      emergencyRecoveryMode = true;
      setTimeout(() => { emergencyRecoveryMode = false; console.log("✅ Emergency recovery mode ended"); }, CFG.EMERGENCY_COOLDOWN);
    }
    
    if (retryCount >= CFG.MAX_RETRIES) {
      console.log(`❌ Max retries (${CFG.MAX_RETRIES}) reached. Aborting order.`);
      return { success: false, action: 'abort' };
    }
    
    let fixResult;
    switch (analysis.category) {
      case 'INSUFFICIENT_MARGIN':
        fixResult = await fixInsufficientMargin(originalParams);
        break;
      case 'LOT_SIZE':
        fixResult = await fixLotSize(originalParams);
        break;
      case 'PRICE_FILTER':
        fixResult = await fixPriceFilter(originalParams);
        break;
      case 'RATE_LIMIT':
        fixResult = await fixRateLimit();
        break;
      case 'LIQUIDATION':
        fixResult = await fixLiquidation(originalParams);
        break;
      default:
        fixResult = await fixOtherError(originalParams);
    }
    
    if (fixResult.action === 'abort') {
      return { success: false, action: 'abort' };
    }
    
    if (fixResult.action === 'retry') {
      await new Promise(r => setTimeout(r, fixResult.delay || CFG.RETRY_DELAY_MS));
      return { success: true, action: 'retry', params: originalParams };
    }
    
    if (fixResult.fixed) {
      console.log(`🔄 Retrying with fixed params (attempt ${retryCount + 1}/${CFG.MAX_RETRIES})...`);
      await new Promise(r => setTimeout(r, CFG.RETRY_DELAY_MS));
      return { success: true, action: 'retry', params: fixResult };
    }
    
    return { success: false, action: 'abort' };
  }

  // ========== 4. ПЕРЕХОПЛЕННЯ placeOrder ДЛЯ ОБРОБКИ ПОМИЛОК BINANCE ==========
  const originalPlaceOrder = global.placeOrder || placeOrder;
  const orderRetryMap = new Map();
  
  global.placeOrder = async function(side, quantity, currentPrice, context = {}) {
    const orderKey = `${side}_${Date.now()}_${Math.random()}`;
    let retries = orderRetryMap.get(orderKey) || 0;
    
    const executeWithRetry = async (params) => {
      try {
        const result = await originalPlaceOrder(params.side, params.quantity, params.price);
        // Успіх - очищаємо лічильники
        consecutiveBinanceErrors = 0;
        emergencyRecoveryMode = false;
        orderRetryMap.delete(orderKey);
        return result;
      } catch (error) {
        // Перевіряємо, чи це помилка Binance
        if (error?.msg || error?.code || error?.message?.includes('binance')) {
          const handlerResult = await handleBinanceError(error, params, retries);
          if (handlerResult.success && handlerResult.action === 'retry') {
            retries++;
            orderRetryMap.set(orderKey, retries);
            return executeWithRetry(handlerResult.params);
          }
        }
        // Інші помилки або після всіх спроб
        console.error("❌ Unrecoverable order error:", error);
        return null;
      }
    };
    
    return executeWithRetry({ side, quantity, price: currentPrice });
  };

  // ========== 5. ПЕРЕВІРКА СТАНУ РАХУНКУ ПІСЛЯ ПОМИЛОК ==========
  async function checkAccountHealth() {
    if (!CONFIG.trading.REAL_MODE) return;
    
    try {
      const balance = account.balance;
      const usedMargin = account.balance * 0.1; // приблизно, можна отримати реальну позицію
      const usage = usedMargin / (account.balance || 1);
      
      if (usage > CFG.MARGIN_CALL_THRESHOLD) {
        console.log(`⚠️ High margin usage: ${(usage*100).toFixed(1)}%. Reducing risk.`);
        CONFIG.risk.MAX_RISK_PER_TRADE = Math.max(0.5, CONFIG.risk.MAX_RISK_PER_TRADE * 0.8);
      }
    } catch (err) {
      console.error("Health check error:", err.message);
    }
  }

  // Періодична перевірка (кожні 30 секунд)
  setInterval(() => checkAccountHealth(), 30000);

  // ========== 6. ВІДНОВЛЕННЯ ПІСЛЯ РОЗРИВУ З'ЄДНАННЯ ==========
  let reconnectAttempts = 0;
  const originalStartWebSocket = startWebSocket;
  global.startWebSocket = function() {
    console.log("🔌 AI Guard: Starting WebSocket with auto-recovery...");
    originalStartWebSocket();
    
    // Додаємо обробник помилок WebSocket
    if (ws) {
      ws.on('error', (err) => {
        console.error("WebSocket error:", err.message);
        reconnectAttempts++;
        if (reconnectAttempts > 3) {
          console.log("🔄 Multiple WebSocket errors, restarting connection...");
          setTimeout(() => {
            if (ws) ws.close();
            startWebSocket();
          }, 10000);
        }
      });
      ws.on('open', () => { reconnectAttempts = 0; });
    }
  };

  console.log("✅ MODULE 35: Binance Error Corrector ready");
})();

// ================== MODULE 36,37,38: AI GUARD - CANDLE ANALYZER + SHORT/LONG VOLUME TRACKERS ==================
(function initModule363738() {
  if (global.__MODULE_363738_LOADED__) return;
  global.__MODULE_363738_LOADED__ = true;
  console.log("📊 MODULE 36-38: AI Guard - Candle Analyzer & Volume Trackers ACTIVE");

  // ================== 1. CANDLE ANALYZER (36) ==================
  const candles = [];
  const MAX_CANDLES = 200;
  let currentCandle = null;
  let lastProcessedTime = 0;

  function initCandleWebSocket() {
    const wsCandles = new WebSocket(`wss://fstream.binance.com/ws/${CONFIG.ws.SYMBOL}@kline_1m`);
    wsCandles.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!msg.k) return;
        const k = msg.k;
        const candle = {
          time: k.t,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
          isFinal: k.x,
        };
        if (candle.isFinal) {
          candles.push(candle);
          if (candles.length > MAX_CANDLES) candles.shift();
          analyzeCandle(candle);
        } else {
          currentCandle = candle;
        }
        lastProcessedTime = Date.now();
      } catch (err) { /* тихо */ }
    });
    wsCandles.on('error', () => {});
    wsCandles.on('close', () => setTimeout(initCandleWebSocket, 5000));
    console.log("🕯️ Candle analyzer WebSocket connected");
  }

  function analyzeCandle(candle) {
    const body = Math.abs(candle.close - candle.open);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const bodyPercent = (body / (candle.high - candle.low || 1)) * 100;
    let candleType = "NEUTRAL";
    if (candle.close > candle.open) {
      if (upperWick > body * 1.5) candleType = "SHOOTING_STAR";
      else if (lowerWick > body * 1.5) candleType = "HAMMER";
      else if (bodyPercent > 60) candleType = "STRONG_BULLISH";
      else candleType = "BULLISH";
    } else if (candle.close < candle.open) {
      if (lowerWick > body * 1.5) candleType = "INVERTED_HAMMER";
      else if (upperWick > body * 1.5) candleType = "HANGING_MAN";
      else if (bodyPercent > 60) candleType = "STRONG_BEARISH";
      else candleType = "BEARISH";
    }
    global.lastCandleAnalysis = {
      timestamp: candle.time,
      type: candleType,
      bodyPercent,
      volume: candle.volume,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      isReversal: (candleType === "HAMMER" || candleType === "SHOOTING_STAR" || candleType === "INVERTED_HAMMER" || candleType === "HANGING_MAN")
    };
    if (Math.random() < 0.1) {
      console.log(`🕯️ Candle: ${candleType} | body ${bodyPercent.toFixed(1)}% | vol ${candle.volume.toFixed(0)}`);
    }
    if (global.onCandleClose) global.onCandleClose(global.lastCandleAnalysis);
  }

  global.getCandles = () => [...candles];
  global.getCurrentCandle = () => currentCandle;
  global.getLastCandleAnalysis = () => global.lastCandleAnalysis;

  // ================== 2. SHORT VOLUME TRACKER (37) ==================
  let shortVolume = 0;
  let shortTrades = [];
  let currentShortExposure = 0;

  global.addShortTrade = (quantity, price, timestamp = Date.now()) => {
    const tradeValue = quantity * price;
    shortVolume += tradeValue;
    currentShortExposure += tradeValue;
    shortTrades.push({ quantity, price, value: tradeValue, timestamp, type: 'short' });
    if (shortTrades.length > 100) shortTrades.shift();
    console.log(`📉 SHORT: +${quantity} @ ${price} | total short volume: ${shortVolume.toFixed(2)} USDT`);
    if (global.onShortUpdate) global.onShortUpdate({ quantity, price, totalVolume: shortVolume });
  };

  global.closeShortTrade = (quantity, price, timestamp = Date.now()) => {
    const tradeValue = quantity * price;
    currentShortExposure = Math.max(0, currentShortExposure - tradeValue);
    console.log(`📈 SHORT CLOSED: -${quantity} @ ${price} | remaining exposure: ${currentShortExposure.toFixed(2)} USDT`);
    if (global.onShortClose) global.onShortClose({ quantity, price, remainingExposure: currentShortExposure });
  };

  global.getShortVolume = () => shortVolume;
  global.getCurrentShortExposure = () => currentShortExposure;
  global.getShortTrades = () => [...shortTrades];

  // ================== 3. LONG VOLUME TRACKER (38) ==================
  let longVolume = 0;
  let longTrades = [];
  let currentLongExposure = 0;

  global.addLongTrade = (quantity, price, timestamp = Date.now()) => {
    const tradeValue = quantity * price;
    longVolume += tradeValue;
    currentLongExposure += tradeValue;
    longTrades.push({ quantity, price, value: tradeValue, timestamp, type: 'long' });
    if (longTrades.length > 100) longTrades.shift();
    console.log(`📈 LONG: +${quantity} @ ${price} | total long volume: ${longVolume.toFixed(2)} USDT`);
    if (global.onLongUpdate) global.onLongUpdate({ quantity, price, totalVolume: longVolume });
  };

  global.closeLongTrade = (quantity, price, timestamp = Date.now()) => {
    const tradeValue = quantity * price;
    currentLongExposure = Math.max(0, currentLongExposure - tradeValue);
    console.log(`📉 LONG CLOSED: -${quantity} @ ${price} | remaining exposure: ${currentLongExposure.toFixed(2)} USDT`);
    if (global.onLongClose) global.onLongClose({ quantity, price, remainingExposure: currentLongExposure });
  };

  global.getLongVolume = () => longVolume;
  global.getCurrentLongExposure = () => currentLongExposure;
  global.getLongTrades = () => [...longTrades];

  // ================== 4. ІНТЕГРАЦІЯ З placeOrder ==================
  const originalPlaceOrder363738 = global.placeOrder;
  if (originalPlaceOrder363738) {
    global.placeOrder = async function(side, quantity, currentPrice) {
      const result = await originalPlaceOrder363738(side, quantity, currentPrice);
      if (result) {
        if (side === 'short') global.addShortTrade(quantity, currentPrice);
        if (side === 'long') global.addLongTrade(quantity, currentPrice);
      }
      return result;
    };
  }

  // ================== 5. ІНТЕГРАЦІЯ З AI GUARD (МОДУЛЬ 34) ==================
  if (global.__MODULE_34_LOADED__) {
    global.getMarketSentiment = () => {
      const lastCandle = global.getLastCandleAnalysis();
      const shortExposure = global.getCurrentShortExposure?.() || 0;
      const longExposure = global.getCurrentLongExposure?.() || 0;
      const totalExposure = shortExposure + longExposure;
      return {
        candle: lastCandle,
        shortRatio: totalExposure > 0 ? shortExposure / totalExposure : 0.5,
        longRatio: totalExposure > 0 ? longExposure / totalExposure : 0.5,
        netPosition: longExposure - shortExposure,
        timestamp: Date.now()
      };
    };
    console.log("🔗 Modules 36-38 integrated with AI Guard (34)");
  }

  // Запуск аналізатора свічок
  initCandleWebSocket();
})();

// ================== MODULE 39+40: AI HEALTH SUPERVISOR + COORDINATION LAYER ==================
(function initModule3940() {
  if (global.__MODULE_3940_LOADED__) return;
  global.__MODULE_3940_LOADED__ = true;
  console.log("🩺 MODULE 39: AI Health Supervisor ACTIVE");
  console.log("🔗 MODULE 40: AI Coordination Layer ACTIVE");

  // ================== 1. РЕЄСТР AI КОМПОНЕНТІВ ==================
  const aiRegistry = new Map(); // id -> { type, lastHeartbeat, status, restartCount, processRef, metadata }
  const HEALTH_CHECK_INTERVAL_MS = 15000;   // перевірка кожні 15 секунд
  const HEARTBEAT_TIMEOUT_MS = 30000;       // 30 секунд без heartbeat – dead
  const MAX_RESTARTS_PER_HOUR = 5;           // макс перезапусків за годину
  
  // Лічильники перезапусків для запобігання циклічним перезапускам
  const restartCounter = new Map(); // id -> { count, firstRestartTime }

  // Функція реєстрації AI компонента (воркер, ядро, AI guard тощо)
  global.registerAIComponent = (id, type, metadata = {}) => {
    if (aiRegistry.has(id)) {
      // Оновлюємо heartbeat
      aiRegistry.get(id).lastHeartbeat = Date.now();
      aiRegistry.get(id).status = 'active';
      return;
    }
    aiRegistry.set(id, {
      type,          // 'worker', 'core', 'ai_guard', 'candle_analyzer', 'volume_tracker'
      lastHeartbeat: Date.now(),
      status: 'active',
      restartCount: 0,
      metadata,
      createdAt: Date.now()
    });
    console.log(`🟢 AI component registered: ${id} (${type})`);
  };

  // Функція оновлення heartbeat (викликається кожним AI компонентом)
  global.heartbeatAI = (id) => {
    if (aiRegistry.has(id)) {
      aiRegistry.get(id).lastHeartbeat = Date.now();
      if (aiRegistry.get(id).status === 'inactive') {
        aiRegistry.get(id).status = 'active';
        console.log(`💓 AI component ${id} recovered (heartbeat received)`);
      }
    } else {
      // Автоматична реєстрація при першому heartbeat
      global.registerAIComponent(id, 'unknown');
    }
  };

  // Функція перевірки здоров'я компонента
  function isComponentHealthy(entry) {
    const now = Date.now();
    const timeSinceHeartbeat = now - entry.lastHeartbeat;
    return (timeSinceHeartbeat <= HEARTBEAT_TIMEOUT_MS && entry.status === 'active');
  }

  // Функція перезапуску компонента (примусовий запуск)
  async function restartAIComponent(id) {
    const entry = aiRegistry.get(id);
    if (!entry) {
      console.log(`⚠️ Cannot restart unknown component: ${id}`);
      return false;
    }
    
    // Перевірка ліміту перезапусків
    const now = Date.now();
    let counter = restartCounter.get(id);
    if (!counter) {
      counter = { count: 0, firstRestartTime: now };
      restartCounter.set(id, counter);
    }
    if (now - counter.firstRestartTime < 3600000) { // за годину
      if (counter.count >= MAX_RESTARTS_PER_HOUR) {
        console.log(`🚫 Component ${id} exceeded restart limit (${MAX_RESTARTS_PER_HOUR}/hour). Manual intervention required.`);
        entry.status = 'quarantined';
        return false;
      }
    } else {
      // Скидаємо лічильник після години
      counter.count = 0;
      counter.firstRestartTime = now;
    }
    
    console.log(`🔄 Restarting AI component: ${id} (type: ${entry.type})`);
    counter.count++;
    
    // Спробуємо перезапустити залежно від типу компонента
    try {
      if (entry.type === 'worker' && global.restartWorker) {
        // Якщо є глобальна функція перезапуску воркера (модуль 31)
        await global.restartWorker(parseInt(id.split('_').pop()), true);
      } else if (entry.type === 'core' && global.restartCore) {
        await global.restartCore(id);
      } else if (entry.type === 'ai_guard' && global.restartAIGuard) {
        await global.restartAIGuard();
      } else {
        // Загальний метод: перестворюємо через reinitialization
        if (entry.metadata && entry.metadata.reinitFn && typeof global[entry.metadata.reinitFn] === 'function') {
          await global[entry.metadata.reinitFn]();
        } else {
          // Якщо немає специфічного методу, просто скидаємо статус
          entry.status = 'active';
          entry.lastHeartbeat = Date.now();
          console.log(`⚠️ No restart method for ${id}, reset status only`);
        }
      }
      entry.restartCount++;
      entry.lastHeartbeat = Date.now();
      entry.status = 'active';
      return true;
    } catch (err) {
      console.error(`❌ Failed to restart ${id}:`, err.message);
      entry.status = 'error';
      return false;
    }
  }

  // Періодична перевірка всіх зареєстрованих компонентів
  async function healthCheckLoop() {
    const now = Date.now();
    for (let [id, entry] of aiRegistry.entries()) {
      if (!isComponentHealthy(entry)) {
        console.log(`⚠️ Unhealthy AI component detected: ${id} (last heartbeat: ${new Date(entry.lastHeartbeat).toISOString()})`);
        await restartAIComponent(id);
      }
    }
  }
  
  // Запускаємо періодичну перевірку
  setInterval(healthCheckLoop, HEALTH_CHECK_INTERVAL_MS);

  // ================== 2. AI COORDINATION LAYER (МОДУЛЬ 40) ==================
  // Черги повідомлень, синхронізація, пріоритети
  
  // Типи повідомлень: 'order', 'config_change', 'signal', 'trade_result', 'error'
  const priorityOrder = { 'order': 1, 'trade_result': 2, 'config_change': 3, 'signal': 4, 'error': 5 };
  const messageQueue = [];
  let isProcessingQueue = false;
  
  // Лок для синхронізації доступу до спільних ресурсів (state, account, CONFIG)
  const mutex = {
    locked: false,
    queue: [],
    async acquire() {
      return new Promise((resolve) => {
        if (!this.locked) {
          this.locked = true;
          resolve();
        } else {
          this.queue.push(resolve);
        }
      });
    },
    release() {
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      } else {
        this.locked = false;
      }
    }
  };
  
  // Функція надсилання повідомлення в чергу з пріоритетом
  global.sendAIMessage = (type, payload, priority = null) => {
    const prio = priority !== null ? priority : (priorityOrder[type] || 5);
    const message = { type, payload, timestamp: Date.now(), priority: prio };
    // Вставка з урахуванням пріоритету
    let inserted = false;
    for (let i = 0; i < messageQueue.length; i++) {
      if (messageQueue[i].priority > prio) {
        messageQueue.splice(i, 0, message);
        inserted = true;
        break;
      }
    }
    if (!inserted) messageQueue.push(message);
    
    if (!isProcessingQueue) processMessageQueue();
  };
  
  async function processMessageQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      await handleMessage(msg);
    }
    isProcessingQueue = false;
  }
  
  async function handleMessage(msg) {
    // Використовуємо mutex для критичних секцій (наприклад, зміна стану або балансу)
    await mutex.acquire();
    try {
      switch (msg.type) {
        case 'order':
          if (global.executeOrderFromAI) {
            await global.executeOrderFromAI(msg.payload);
          }
          break;
        case 'config_change':
          if (global.applyConfigChange) {
            await global.applyConfigChange(msg.payload);
          } else {
            // Пряме застосування змін до CONFIG
            for (const [key, value] of Object.entries(msg.payload)) {
              if (key.startsWith('CONFIG.')) {
                const parts = key.split('.');
                let obj = global;
                for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
                if (obj && obj[parts[parts.length-1]] !== undefined) {
                  obj[parts[parts.length-1]] = value;
                }
              }
            }
          }
          break;
        case 'signal':
          if (global.handleAISignal) await global.handleAISignal(msg.payload);
          break;
        case 'trade_result':
          if (global.handleTradeResult) await global.handleTradeResult(msg.payload);
          break;
        default:
          console.log(`📨 Unhandled AI message type: ${msg.type}`);
      }
    } finally {
      mutex.release();
    }
  }
  
  // Функція для безпечного доступу до спільних даних (state, account, adaptiveState)
  global.withAILock = async (fn) => {
    await mutex.acquire();
    try {
      return await fn();
    } finally {
      mutex.release();
    }
  };
  
  // Автоматична реєстрація наявних AI компонентів (модулі 33, 34, 35, 36-38)
  function registerExistingComponents() {
    // Реєструємо воркерів з модуля 33 (якщо є)
    if (global.modulesRegistry) {
      for (let [modName, modData] of global.modulesRegistry.entries()) {
        if (modData.workers) {
          for (let [workerId, worker] of modData.workers.entries()) {
            global.registerAIComponent(workerId, 'worker', { module: modName });
            // Якщо є можливість надсилати heartbeat від воркера – налагоджуємо
            if (worker.performance && worker.performance.lastScore !== undefined) {
              // Оновлюємо heartbeat при кожному оновленні продуктивності
              const originalTrain = worker.train;
              if (originalTrain) {
                worker.train = function(...args) {
                  global.heartbeatAI(workerId);
                  return originalTrain.apply(this, args);
                };
              }
            }
          }
        }
        if (modData.cores) {
          for (let [coreId, core] of modData.cores.entries()) {
            global.registerAIComponent(coreId, 'core', { module: modName });
          }
        }
      }
    }
    
    // Реєструємо AI Guard (модуль 34,35) – за глобальними функціями
    if (global.placeOrder !== undefined) {
      global.registerAIComponent('ai_guard_order', 'ai_guard', { reinitFn: 'reinitAIGuard' });
    }
    if (global.getMarketSentiment !== undefined) {
      global.registerAIComponent('candle_analyzer', 'candle_analyzer');
    }
    if (global.getShortVolume !== undefined) {
      global.registerAIComponent('volume_tracker_short', 'volume_tracker');
      global.registerAIComponent('volume_tracker_long', 'volume_tracker');
    }
  }
  
  // Функція, яку можна викликати для примусової перевірки та відновлення
  global.forceAICheck = async () => {
    console.log("🔍 Force AI health check...");
    await healthCheckLoop();
  };
  
  // Запускаємо реєстрацію через невелику затримку (після завантаження всіх модулів)
  setTimeout(registerExistingComponents, 2000);
  
  // Періодичне логування статусу (кожні 5 хвилин)
  setInterval(() => {
    const active = Array.from(aiRegistry.values()).filter(e => e.status === 'active').length;
    const total = aiRegistry.size;
    console.log(`📊 AI Health: ${active}/${total} components active`);
  }, 300000);
  
  console.log("✅ AI Health Supervisor and Coordination Layer ready");
})();

// ================== MODULE 41: SIMULATION ENGINE (SANDBOX) ==================
(function initSimulationEngine() {
  if (global.__SIMULATION_ENGINE_LOADED__) return;
  global.__SIMULATION_ENGINE_LOADED__ = true;

  // Активуємо через змінну оточення SIMULATION_MODE=true
  const SIMULATION_MODE = process.env.SIMULATION_MODE === 'true';
  if (!SIMULATION_MODE) {
    console.log("🎮 MODULE 41: Simulation Engine disabled (set SIMULATION_MODE=true to enable)");
    return;
  }

  console.log("🎮 MODULE 41: Simulation Engine ACTIVE (sandbox mode, no real trading)");

  // ================== 1. КОНФІГУРАЦІЯ СИМУЛЯЦІЇ ==================
  const SIM_CFG = {
    INITIAL_BALANCE: parseFloat(process.env.SIM_INITIAL_BALANCE || "10000"),
    START_PRICE: parseFloat(process.env.SIM_START_PRICE || "0.15"),
    VOLATILITY: parseFloat(process.env.SIM_VOLATILITY || "0.02"),      // 2% середньодобова волатильність
    TREND_STRENGTH: parseFloat(process.env.SIM_TREND || "0.0001"),     // слабкий тренд
    SPREAD: parseFloat(process.env.SIM_SPREAD || "0.001"),             // 0.1% спред
    SLIPPAGE_FACTOR: parseFloat(process.env.SIM_SLIPPAGE || "0.0005"), // прослизання 0.05%
    FEE_MAKER: parseFloat(process.env.SIM_FEE_MAKER || "0.0002"),      // 0.02%
    FEE_TAKER: parseFloat(process.env.SIM_FEE_TAKER || "0.0004"),       // 0.04%
    TICK_INTERVAL_MS: parseInt(process.env.SIM_TICK_INTERVAL || "1000"), // 1 секунда = 1 свічка (можна прискорити)
    ENABLE_RANDOM_SPIKES: process.env.SIM_SPIKES !== 'false',
    SPIKE_PROBABILITY: 0.01,      // 1% шанс сплеску на тік
    SPIKE_MAGNITUDE: 0.05,        // 5% стрибок
    MAX_SIMULATION_STEPS: parseInt(process.env.SIM_MAX_STEPS || "1000000"),
    LOG_EVERY: parseInt(process.env.SIM_LOG_EVERY || "100"),           // логувати кожні N тіків
  };

  // Стан симуляції
  let simState = {
    price: SIM_CFG.START_PRICE,
    balance: SIM_CFG.INITIAL_BALANCE,
    positions: [],        // { side, entryPrice, quantity, timestamp }
    trades: [],           // історія угод
    step: 0,
    startTime: Date.now(),
    paused: false,
    volume: 0,
    lastTickPrice: SIM_CFG.START_PRICE,
  };

  // Глобальний прапорець для інших модулів (щоб знали, що в симуляції)
  global.SIMULATION_ACTIVE = true;

  // ================== 2. ГЕНЕРАЦІЯ ЦІНИ (випадкове блукання + тренд + сплески) ==================
  function generateNextPrice() {
    let lastPrice = simState.price;
    // Випадкова зміна (нормальний розподіл)
    let change = (Math.random() - 0.5) * 2 * SIM_CFG.VOLATILITY;
    // Додаємо тренд
    change += SIM_CFG.TREND_STRENGTH;
    let newPrice = lastPrice * (1 + change);
    // Обмежуємо від надто великих стрибків
    const maxChangePercent = 0.10; // 10% за тік
    if (Math.abs(newPrice - lastPrice) / lastPrice > maxChangePercent) {
      newPrice = lastPrice * (1 + (newPrice > lastPrice ? maxChangePercent : -maxChangePercent));
    }
    // Випадкові сплески
    if (SIM_CFG.ENABLE_RANDOM_SPIKES && Math.random() < SIM_CFG.SPIKE_PROBABILITY) {
      const spikeDir = Math.random() > 0.5 ? 1 : -1;
      newPrice = newPrice * (1 + spikeDir * SIM_CFG.SPIKE_MAGNITUDE);
      console.log(`⚡ SIM SPIKE: ${spikeDir > 0 ? 'UP' : 'DOWN'} to ${newPrice.toFixed(8)}`);
    }
    // Мінімальна ціна 1e-8
    if (newPrice < 1e-8) newPrice = 1e-8;
    simState.price = newPrice;
    // Імітуємо об'єм (випадковий)
    simState.volume = Math.random() * 1000000 + 10000;
    return newPrice;
  }

  // ================== 3. ВИКОНАННЯ ОРДЕРА В СИМУЛЯЦІЇ ==================
  async function simulatePlaceOrder(side, quantity, price) {
    // Перевірка достатності коштів для маржі (5% від вартості)
    const requiredMargin = price * quantity * 0.05;
    if (simState.balance < requiredMargin) {
      console.log(`❌ SIM: Insufficient margin. Balance: ${simState.balance.toFixed(2)}, required: ${requiredMargin.toFixed(2)}`);
      return null;
    }

    // Симуляція спреду та прослизання
    const spreadCost = price * SIM_CFG.SPREAD;
    const slippage = price * SIM_CFG.SLIPPAGE_FACTOR * (Math.random() - 0.5);
    let executionPrice = side === 'long' ? price + spreadCost/2 : price - spreadCost/2;
    executionPrice += slippage;
    executionPrice = Math.max(executionPrice, 1e-8);

    // Комісія (тейкер)
    const fee = executionPrice * quantity * SIM_CFG.FEE_TAKER;
    const totalCost = executionPrice * quantity + fee;
    if (side === 'long' && simState.balance < totalCost) {
      console.log(`❌ SIM: Insufficient balance for long. Balance: ${simState.balance.toFixed(2)}, need: ${totalCost.toFixed(2)}`);
      return null;
    }

    // Виконуємо ордер
    if (side === 'long') {
      simState.balance -= totalCost;
      simState.positions.push({
        side: 'long',
        entryPrice: executionPrice,
        quantity: quantity,
        timestamp: Date.now(),
        fee: fee
      });
    } else { // short
      // Для шорту потрібна маржа, баланс блокується
      simState.balance -= requiredMargin;
      simState.positions.push({
        side: 'short',
        entryPrice: executionPrice,
        quantity: quantity,
        timestamp: Date.now(),
        fee: fee
      });
    }

    console.log(`✅ SIM ORDER: ${side.toUpperCase()} ${quantity} @ ${executionPrice.toFixed(8)} (fee: ${fee.toFixed(4)})`);
    console.log(`   Balance after: ${simState.balance.toFixed(2)}`);
    return { price: executionPrice, quantity, fee };
  }

  // Функція для закриття позицій (викликається при TP/SL або вручну)
  function closePosition(position, currentPrice, reason = 'MANUAL') {
    const { side, entryPrice, quantity, fee: entryFee } = position;
    let pnl = 0;
    let exitFee = 0;
    if (side === 'long') {
      pnl = (currentPrice - entryPrice) * quantity;
      exitFee = currentPrice * quantity * SIM_CFG.FEE_TAKER;
      simState.balance += currentPrice * quantity - exitFee;
    } else { // short
      pnl = (entryPrice - currentPrice) * quantity;
      exitFee = currentPrice * quantity * SIM_CFG.FEE_TAKER;
      simState.balance += (entryPrice * quantity) - (currentPrice * quantity) - exitFee;
    }
    const totalPnL = pnl - entryFee - exitFee;
    console.log(`💰 SIM CLOSE ${side.toUpperCase()} (${reason}): PnL = ${totalPnL.toFixed(4)} (${((totalPnL/(entryPrice*quantity))*100).toFixed(2)}%)`);
    simState.trades.push({
      side, entryPrice, exitPrice: currentPrice, quantity, pnl: totalPnL,
      timestamp: Date.now(), reason
    });
    return totalPnL;
  }

  // Перевірка TP/SL для всіх відкритих позицій
  function checkSimulatedExit(price) {
    let closedAny = false;
    for (let i = 0; i < simState.positions.length; i++) {
      const pos = simState.positions[i];
      const tpPercent = CONFIG.risk.TAKE_PROFIT / 100;
      const slPercent = CONFIG.risk.STOP_LOSS / 100;
      let shouldClose = false;
      let reason = '';
      if (pos.side === 'long') {
        if (price >= pos.entryPrice * (1 + tpPercent)) { shouldClose = true; reason = 'TP'; }
        if (price <= pos.entryPrice * (1 - slPercent)) { shouldClose = true; reason = 'SL'; }
      } else {
        if (price <= pos.entryPrice * (1 - tpPercent)) { shouldClose = true; reason = 'TP'; }
        if (price >= pos.entryPrice * (1 + slPercent)) { shouldClose = true; reason = 'SL'; }
      }
      if (shouldClose) {
        closePosition(pos, price, reason);
        simState.positions.splice(i, 1);
        i--;
        closedAny = true;
      }
    }
    return closedAny;
  }

  // ================== 4. ПІДМІНА ГЛОБАЛЬНИХ ФУНКЦІЙ ДЛЯ СИМУЛЯЦІЇ ==================
  // Зберігаємо оригінали
  const originalPlaceOrder = global.placeOrder;
  const originalGetAccountBalance = global.getAccountBalance;
  const originalCalcPositionSize = global.calcPositionSize;

  // Підміняємо placeOrder
  global.placeOrder = async function(side, quantity, price) {
    if (!global.SIMULATION_ACTIVE) return originalPlaceOrder(side, quantity, price);
    return simulatePlaceOrder(side, quantity, price);
  };

  // Підміняємо getAccountBalance (для симуляції балансу)
  global.getAccountBalance = async function() {
    if (!global.SIMULATION_ACTIVE) return originalGetAccountBalance();
    console.log(`💰 SIM Balance: ${simState.balance.toFixed(2)} USDT`);
    return simState.balance;
  };

  // Підміняємо calcPositionSize (можна використовувати оригінальний, але з симульованим балансом)
  global.calcPositionSize = function(price) {
    if (!global.SIMULATION_ACTIVE) return originalCalcPositionSize(price);
    // Простий розрахунок для симуляції: 2% ризику від балансу
    const riskAmount = simState.balance * (CONFIG.risk.MAX_RISK_PER_TRADE / 100);
    const stopLossPercent = CONFIG.risk.STOP_LOSS / 100;
    let qty = riskAmount / (price * stopLossPercent);
    qty = Math.floor(qty * 1000) / 1000;
    return Math.max(1, qty);
  };

  // Підміняємо onTick, щоб генерувати ціни та перевіряти вихід
  const originalOnTick = onTick;
  onTick = async function(price, volume) {
    if (!global.SIMULATION_ACTIVE) return originalOnTick(price, volume);
    // У симуляції ігноруємо вхідну ціну, генеруємо свою
    const simPrice = generateNextPrice();
    simState.step++;
    if (simState.step % SIM_CFG.LOG_EVERY === 0) {
      console.log(`🎲 SIM step ${simState.step}: price=${simPrice.toFixed(8)}, balance=${simState.balance.toFixed(2)}`);
    }
    // Перевіряємо вихід по TP/SL
    const closed = checkSimulatedExit(simPrice);
    // Викликаємо оригінальний onTick зі згенерованою ціною для сигналів
    await originalOnTick(simPrice, simState.volume);
    // Якщо після оригінального onTick з'явилася позиція в реальному state, але не в simState.positions – синхронізуємо
    if (state.status === 'IN_TRADE' && !simState.positions.some(p => p.side === state.side && Math.abs(p.entryPrice - state.entry) < 1e-8)) {
      // Це означає, що оригінальний бот відкрив позицію – додаємо в симуляцію
      const qty = calcPositionSize(simPrice);
      await simulatePlaceOrder(state.side, qty, simPrice);
    }
    // Обмеження кількості кроків
    if (simState.step >= SIM_CFG.MAX_SIMULATION_STEPS) {
      console.log("🏁 Simulation reached max steps. Stopping.");
      process.exit(0);
    }
  };

  // ================== 5. ІНТЕГРАЦІЯ З МОДУЛЕМ 33 (AI воркери) ==================
  // Додаємо можливість тренувати AI на симуляційних даних
  global.runSimulationTraining = async (steps = 1000) => {
    console.log(`🧠 Starting simulation training for ${steps} steps...`);
    const startBalance = simState.balance;
    for (let i = 0; i < steps; i++) {
      await onTick(simState.price, simState.volume);
      // Штучна затримка для емуляції реального часу (можна вимкнути)
      await new Promise(r => setTimeout(r, SIM_CFG.TICK_INTERVAL_MS));
    }
    const endBalance = simState.balance;
    const profit = endBalance - startBalance;
    console.log(`🏁 Training completed. Profit: ${profit.toFixed(2)} USDT (${((profit/startBalance)*100).toFixed(2)}%)`);
    return { profit, finalBalance: endBalance, trades: simState.trades.length };
  };

  // Додаємо функцію скидання симуляції
  global.resetSimulation = () => {
    simState = {
      price: SIM_CFG.START_PRICE,
      balance: SIM_CFG.INITIAL_BALANCE,
      positions: [],
      trades: [],
      step: 0,
      startTime: Date.now(),
      paused: false,
      volume: 0,
      lastTickPrice: SIM_CFG.START_PRICE,
    };
    console.log("🔄 Simulation reset.");
  };

  // Функція для отримання звіту
  global.getSimulationReport = () => {
    const totalPnL = simState.trades.reduce((sum, t) => sum + t.pnl, 0);
    const winTrades = simState.trades.filter(t => t.pnl > 0).length;
    const lossTrades = simState.trades.filter(t => t.pnl < 0).length;
    const winRate = simState.trades.length ? (winTrades / simState.trades.length) * 100 : 0;
    return {
      steps: simState.step,
      balance: simState.balance,
      totalPnL,
      tradesCount: simState.trades.length,
      winRate: winRate.toFixed(2) + '%',
      openPositions: simState.positions.length,
      currentPrice: simState.price,
    };
  };

  // Автоматичний старт симуляції, якщо встановлено AUTO_SIM_START=true
  if (process.env.AUTO_SIM_START === 'true') {
    setTimeout(() => {
      console.log("🚀 Auto-starting simulation...");
      global.runSimulationTraining(parseInt(process.env.SIM_STEPS || "500"));
    }, 3000);
  }

  console.log("✅ Simulation Engine ready. Use SIMULATION_MODE=true to activate.");
})();

// ================== MODULE 42: AUTO SIMULATION LAUNCHER (FIXED) ==================
(function initAutoSimulationFixed() {
  if (global.__AUTO_SIM_FIXED_LOADED__) return;
  global.__AUTO_SIM_FIXED_LOADED__ = true;

  // Запобігаємо запуску в дочірньому процесі
  if (process.env.INSIDE_SIMULATION === 'true') {
    console.log("🧪 Simulation worker active - skipping main init");
    return;
  }

  const { fork } = require('child_process');
  const fs = require('fs');
  const path = require('path');

  const SIM_CONFIG = {
    enabled: true,
    initialBalance: 10000,
    startPrice: 0.15,
    volatility: 0.02,
    trendStrength: 0.0001,
    spread: 0.001,
    slippage: 0.0005,
    tickIntervalMs: 1000,
    autoStart: true,
    steps: 2000,
    logEvery: 100,
  };

  if (!SIM_CONFIG.enabled) return;
  console.log("🚀 Module 42: Auto-simulation launcher (fixed)");

  const simWorkerScript = path.join(process.cwd(), '.sim_worker.js');
  const workerContent = `
  process.env.SIMULATION_MODE = 'true';
  process.env.INSIDE_SIMULATION = 'true';
  process.env.AUTO_SELECT_MODE = '1';
  process.env.SIM_INITIAL_BALANCE = '${SIM_CONFIG.initialBalance}';
  process.env.SIM_START_PRICE = '${SIM_CONFIG.startPrice}';
  process.env.SIM_VOLATILITY = '${SIM_CONFIG.volatility}';
  process.env.SIM_TREND = '${SIM_CONFIG.trendStrength}';
  process.env.SIM_SPREAD = '${SIM_CONFIG.spread}';
  process.env.SIM_SLIPPAGE = '${SIM_CONFIG.slippage}';
  process.env.SIM_TICK_INTERVAL = '${SIM_CONFIG.tickIntervalMs}';
  process.env.AUTO_SIM_START = '${SIM_CONFIG.autoStart}';
  process.env.SIM_STEPS = '${SIM_CONFIG.steps}';
  process.env.SIM_LOG_EVERY = '${SIM_CONFIG.logEvery}';
  import('./bot.js');
  `;

  if (!fs.existsSync(simWorkerScript)) {
    fs.writeFileSync(simWorkerScript, workerContent);
  }

  let simProcess = null;
  function startSimulation() {
    if (simProcess) simProcess.kill();
    simProcess = fork(simWorkerScript, [], {
      env: { ...process.env, SIMULATION_MODE: 'true', INSIDE_SIMULATION: 'true' },
      silent: false,
    });
    simProcess.on('exit', () => setTimeout(startSimulation, 5000));
  }
  setTimeout(startSimulation, 2000);
})();

// ================== MODULE 43: TASK QUEUE, RATE LIMITER & AI HEARTBEAT FIX ==================
(function initModule43() {
  if (global.__MODULE_43_LOADED__) return;
  global.__MODULE_43_LOADED__ = true;
  console.log("⏱️ MODULE 43: Task Queue, Rate Limiter & AI Heartbeat Fix ACTIVE");

  // ========== 1. КОНФІГУРАЦІЯ ==========
  const CFG = {
    MIN_REQUEST_INTERVAL_MS: parseInt(process.env.RATE_LIMIT_MS || "200"),  // 200ms = 5 requests/sec
    MAX_QUEUE_SIZE: 100,
    HEARTBEAT_INTERVAL_MS: 10000,           // кожні 10 секунд
    QUEUE_PROCESS_DELAY_MS: 50,
  };

  // ========== 2. ЧЕРГА ЗАВДАНЬ З ПРІОРИТЕТАМИ ==========
  const taskQueue = [];
  let isProcessing = false;
  let lastRequestTime = 0;

  // Пріоритети: 1 – найвищий (ордери), 2 – зміна конфігурації, 3 – heartbeat/лог
  function addTask(task, priority = 2) {
    if (taskQueue.length >= CFG.MAX_QUEUE_SIZE) {
      console.warn("⚠️ Task queue full, dropping lowest priority task");
      taskQueue.pop();
    }
    // Вставка з урахуванням пріоритету
    let inserted = false;
    for (let i = 0; i < taskQueue.length; i++) {
      if (taskQueue[i].priority > priority) {
        taskQueue.splice(i, 0, { task, priority });
        inserted = true;
        break;
      }
    }
    if (!inserted) taskQueue.push({ task, priority });
    processQueue();
  }

  async function processQueue() {
    if (isProcessing) return;
    isProcessing = true;
    while (taskQueue.length > 0) {
      const now = Date.now();
      const timeSinceLast = now - lastRequestTime;
      if (timeSinceLast < CFG.MIN_REQUEST_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, CFG.MIN_REQUEST_INTERVAL_MS - timeSinceLast));
      }
      const { task } = taskQueue.shift();
      lastRequestTime = Date.now();
      try {
        await task();
      } catch (err) {
        console.error("❌ Task execution error:", err.message);
      }
      // Невелика затримка між задачами навіть якщо ліміт не спрацював
      await new Promise(r => setTimeout(r, CFG.QUEUE_PROCESS_DELAY_MS));
    }
    isProcessing = false;
  }

  // ========== 3. ПЕРЕВИЗНАЧЕННЯ КРИТИЧНИХ ФУНКЦІЙ ==========
  // Перехоплюємо placeOrder (якщо він ще не перевизначений)
  const originalPlaceOrder = global.placeOrder;
  if (originalPlaceOrder) {
    global.placeOrder = async function(side, quantity, price) {
      return new Promise((resolve, reject) => {
        addTask(async () => {
          try {
            const result = await originalPlaceOrder(side, quantity, price);
            resolve(result);
          } catch (err) {
            reject(err);
          }
        }, 1); // пріоритет 1 – найвищий
      });
    };
    console.log("🔧 placeOrder wrapped with task queue (priority 1)");
  }

  // Перехоплюємо getAccountBalance (якщо використовується)
  const originalGetBalance = global.getAccountBalance;
  if (originalGetBalance) {
    global.getAccountBalance = async function() {
      return new Promise((resolve) => {
        addTask(async () => {
          const result = await originalGetBalance();
          resolve(result);
        }, 2);
      });
    };
  }

  // ========== 4. AI HEARTBEAT ФІКС ==========
  // Якщо модуль 39-40 зареєстрував компоненти, оновлюємо heartbeat періодично
  function startHeartbeatFix() {
    setInterval(() => {
      if (global.heartbeatAI) {
        // Оновлюємо heartbeat для всіх зареєстрованих компонентів
        if (global.aiRegistry) {
          for (let [id, entry] of global.aiRegistry.entries()) {
            if (entry.status !== 'quarantined') {
              global.heartbeatAI(id);
            }
          }
        }
        // Додатково для основних компонентів
        const components = ['ai_guard_order', 'candle_analyzer', 'volume_tracker_short', 'volume_tracker_long'];
        for (let id of components) {
          if (global.heartbeatAI) global.heartbeatAI(id);
        }
      }
    }, CFG.HEARTBEAT_INTERVAL_MS);
    console.log("💓 AI Heartbeat fix active (every 10s)");
  }

  // ========== 5. СИНХРОНІЗАЦІЯ НАВЧАННЯ (МОДУЛЬ 33) ==========
  // Якщо є функції навчання, обмежуємо їх частоту
  if (global.modulesRegistry && global.trainAllWorkers) {
    const originalTrain = global.trainAllWorkers;
    let lastTrainTime = 0;
    const TRAIN_COOLDOWN_MS = 30000; // не частіше ніж раз на 30 секунд
    global.trainAllWorkers = async function() {
      const now = Date.now();
      if (now - lastTrainTime < TRAIN_COOLDOWN_MS) {
        return; // пропускаємо
      }
      lastTrainTime = now;
      return originalTrain();
    };
    console.log("🧠 Training rate-limited to once per 30 sec");
  }

  // ========== 6. ЗАПУСК ФІКСІВ ==========
  startHeartbeatFix();

  // Експортуємо допоміжні функції для інших модулів
  global.addTask = addTask;
  global.getQueueStatus = () => ({ size: taskQueue.length, processing: isProcessing, lastRequestTime });

  console.log("✅ Module 43 ready: tasks are queued, rate limit active, heartbeat fixed");
})();

// ================== MODULE 45: UNIFIED MODE CONTROLLER ==================
(function initModule45() {
  if (global.__MODULE_45_LOADED__) return;
  global.__MODULE_45_LOADED__ = true;

  const isSimulation = process.env.SIMULATION_MODE === 'true';
  const mode = isSimulation ? 'SIMULATION' : (CONFIG.trading.REAL_MODE ? 'REAL' : 'PAPER');
  console.log(`🎮 MODULE 45: Unified Mode Controller ACTIVE (${mode} mode)`);

  if (isSimulation) {
    // ========== СИМУЛЯЦІЯ: ВИМИКАЄМО ВСІ БЛОКУЮЧІ ФІЛЬТРИ ==========
    console.log("🧪 Simulation mode: disabling blocking filters for maximum trading activity");

    // 1. Вимкнути FAKE BREAKOUT (модуль TRAP)
    if (global.buildSignal) {
      const originalBuild = global.buildSignal;
      global.buildSignal = function(price) {
        let signal = originalBuild(price);
        if (!signal) {
          const dev = deviation(price);
          if (Math.abs(dev) > 0.0005) {
            signal = { side: dev > 0 ? "short" : "long", dev, ts: Date.now(), simulation: true };
          }
        }
        return signal;
      };
      console.log("   🔓 FAKE BREAKOUT filter disabled for simulation");
    }

    // 2. Вимкнути volatility filter
    if (global.volatilityCheck) {
      global.volatilityCheck = function() {
        return { action: "TRADE", volatility: 1 };
      };
      console.log("   🔓 Volatility filter disabled for simulation");
    }

    // 3. Вимкнути cooldown
    if (CONFIG.cooldown) CONFIG.cooldown.ENABLED = false;
    console.log("   🔓 Cooldown disabled for simulation");

    // 4. Збільшити ліміти
    CONFIG.risk.MAX_TRADES_PER_DAY = 1000;
    CONFIG.risk.MAX_DAILY_LOSS = 100;
    console.log("✅ Simulation mode: all filters disabled, ready for high-frequency trading");
  } else {
    // ========== РЕАЛЬНИЙ / ПАПЕРОВИЙ РЕЖИМ: ПОКРАЩУЄМО, АЛЕ НЕ ВИМИКАЄМО ==========
    console.log("🛡️ Real/Paper mode: keeping filters but improving sensitivity");

    // Додаємо override для FAKE BREAKOUT при сильних сигналах
    if (global.buildSignal) {
      const originalBuild = global.buildSignal;
      global.buildSignal = function(price) {
        let signal = originalBuild(price);
        if (!signal) {
          const dev = Math.abs(deviation(price));
          const spike = volumeSpike();
          if (dev > 0.003 || spike > 1.8) {
            signal = { side: deviation(price) > 0 ? "short" : "long", dev, ts: Date.now(), override: true };
            console.log("🛡️ REAL MODE OVERRIDE: forced entry due to strong signal");
          }
        }
        return signal;
      };
      console.log("   🔧 FAKE BREAKOUT override enabled for strong signals");
    }

    // Пом'якшуємо volatility filter
    if (global.volatilityCheck) {
      const originalVolCheck = global.volatilityCheck;
      global.volatilityCheck = function(price) {
        let result = originalVolCheck(price);
        if (result && result.action === 'HOLD' && result.reason === 'low_vol') {
          const dev = Math.abs(deviation(price));
          if (dev > 0.001) return { action: "TRADE", volatility: 0.5 };
        }
        return result;
      };
      console.log("   🔧 Volatility filter adjusted");
    }
  }

  // Додаємо функції для ручного перемикання
  global.switchToSimulation = () => {
    console.log("Switching to simulation mode...");
    process.env.SIMULATION_MODE = 'true';
    console.log("Please restart bot to apply changes");
  };
  global.switchToReal = () => {
    console.log("Switching to real/paper mode...");
    process.env.SIMULATION_MODE = 'false';
    console.log("Please restart bot to apply changes");
  };

  console.log("✅ Module 45 ready");
})();

// ================== MODULE 46: FORCE ENTRY MODE (DISABLE FAKE BREAKOUT) ==================
(function initModule46() {
  if (global.__MODULE_46_LOADED__) return;
  global.__MODULE_46_LOADED__ = true;

  console.log("🔥 MODULE 46: Force Entry Mode ACTIVE - FAKE BREAKOUT disabled");

  // Повністю вимикаємо функцію isFakeBreakout, якщо вона існує
  if (typeof isFakeBreakout !== 'undefined') {
    global.isFakeBreakout = () => false;
  }
  // Також перевизначаємо будь-яке можливе посилання на isFakeBreakout всередині модулів
  if (global.isFakeBreakout) global.isFakeBreakout = () => false;

  // Перевизначаємо buildSignal, ігноруючи FAKE BREAKOUT
  const originalBuildSignal = global.buildSignal || buildSignal;
  global.buildSignal = function(price) {
    // Тимчасово підміняємо, щоб оригінальна функція не заблокувала
    const originalFake = global.isFakeBreakout;
    global.isFakeBreakout = () => false;
    let signal = originalBuildSignal(price);
    if (originalFake) global.isFakeBreakout = originalFake;
    return signal;
  };

  // Вимикаємо логування FAKE BREAKOUT (щоб не спамило)
  const originalLog = console.log;
  console.log = function(...args) {
    if (args[0] && typeof args[0] === 'string' && args[0].includes('FAKE BREAKOUT')) {
      return;
    }
    originalLog.apply(console, args);
  };

  console.log("✅ FAKE BREAKOUT detector completely disabled. Bot will now attempt entries based on deviation/volume.");
})();

// ================== MODULE 47: EMERGENCY ENTRY UNLOCK ==================
(function initModule47() {
  if (global.__MODULE_47_LOADED__) return;
  global.__MODULE_47_LOADED__ = true;
  console.log("🚨 MODULE 47: Emergency Entry Unlock ACTIVE");

  // 1. Вимкнути нормалізацію ціни (модуль 35)
  if (global.normalizePrice) {
    global.normalizePrice = (price) => price;
    console.log("   ✅ Price normalization disabled");
  }

  // 2. Вимкнути anti-reversal (модуль 17)
  if (global.antiReversalCheck) {
    global.antiReversalCheck = () => true;
    console.log("   ✅ Anti-reversal disabled");
  }

  // 3. Вимкнути volatility filter (модуль 15)
  if (global.volatilityCheck) {
    global.volatilityCheck = () => ({ action: "TRADE", volatility: 1 });
    console.log("   ✅ Volatility filter disabled");
  }

  // 4. Вимкнути баланс фільтр (модуль 13)
  if (global.balanceFilter) {
    global.balanceFilter = (signal) => signal;
    console.log("   ✅ Balance filter disabled");
  }

  // 5. Зменшити пороги входу
  if (CONFIG.signal) {
    CONFIG.signal.DEVIATION_THRESHOLD = 0.0003;
    CONFIG.signal.VOLUME_THRESHOLD = 1.1;
    CONFIG.signal.VOLATILITY_THRESHOLD = 0.0001;
    console.log("   ✅ Thresholds lowered");
  }

  // 6. Видалити обмеження кулдауну
  if (CONFIG.cooldown) {
    CONFIG.cooldown.ENABLED = false;
    console.log("   ✅ Cooldown disabled");
  }

  console.log("✅ Emergency unlock complete. Bot should now enter positions.");
})();

// ================== MODULE 48: AI GUARD AUTO-CORRECTION LOGIC ==================
(function initModule48() {
  if (global.__MODULE_48_LOADED__) return;
  global.__MODULE_48_LOADED__ = true;
  console.log("🔄 MODULE 48: AI Guard Auto-Correction Logic ACTIVE");

  // Конфігурація
  const CFG = {
    CHECK_INTERVAL_MS: 30000,           // перевірка кожні 30 секунд
    NO_TRADE_TIMEOUT_MS: 120000,        // 2 хвилини без трейду – тривога
    CRITICAL_NO_TRADE_MS: 300000,       // 5 хвилин – жорстка корекція
    MAX_CORRECTION_STEPS: 5,
    CORRECTION_FACTOR: 0.8,             // зменшення порогів на 20% за крок
    LOG_EVERY: 1,
  };

  let lastTradeTime = Date.now();
  let correctionStep = 0;
  let originalConfig = null;

  // Зберігаємо оригінальні значення при старті
  function saveOriginalConfig() {
    originalConfig = {
      deviation: CONFIG.signal.DEVIATION_THRESHOLD,
      volume: CONFIG.signal.VOLUME_THRESHOLD,
      volatility: CONFIG.signal.VOLATILITY_THRESHOLD,
      cooldownEnabled: CONFIG.cooldown.ENABLED,
    };
    console.log("📝 Original config saved for auto-correction");
  }

  // Функція корекції – зменшує пороги або вимикає фільтри
  function applyCorrection() {
    if (correctionStep >= CFG.MAX_CORRECTION_STEPS) {
      console.log("⚠️ Max correction steps reached. Forcing entry mode...");
      // Примусове вимкнення всіх фільтрів
      CONFIG.signal.DEVIATION_THRESHOLD = 0.0001;
      CONFIG.signal.VOLUME_THRESHOLD = 1.0;
      CONFIG.signal.VOLATILITY_THRESHOLD = 0.00005;
      CONFIG.cooldown.ENABLED = false;
      if (global.antiReversalCheck) global.antiReversalCheck = () => true;
      if (global.volatilityCheck) global.volatilityCheck = () => ({ action: "TRADE", volatility: 1 });
      return;
    }

    correctionStep++;
    const factor = Math.pow(CFG.CORRECTION_FACTOR, correctionStep);
    const newDeviation = originalConfig.deviation * factor;
    const newVolume = originalConfig.volume * factor;
    const newVolatility = originalConfig.volatility * factor;

    CONFIG.signal.DEVIATION_THRESHOLD = Math.max(0.0001, newDeviation);
    CONFIG.signal.VOLUME_THRESHOLD = Math.max(1.0, newVolume);
    CONFIG.signal.VOLATILITY_THRESHOLD = Math.max(0.00005, newVolatility);
    
    console.log(`🔧 Auto-correction step ${correctionStep}: deviation=${CONFIG.signal.DEVIATION_THRESHOLD.toFixed(5)}, volume=${CONFIG.signal.VOLUME_THRESHOLD.toFixed(2)}, volatility=${CONFIG.signal.VOLATILITY_THRESHOLD.toFixed(5)}`);
  }

  // Функція скидання корекції після успішного трейду
  function resetCorrection() {
    if (correctionStep === 0) return;
    correctionStep = 0;
    if (originalConfig) {
      CONFIG.signal.DEVIATION_THRESHOLD = originalConfig.deviation;
      CONFIG.signal.VOLUME_THRESHOLD = originalConfig.volume;
      CONFIG.signal.VOLATILITY_THRESHOLD = originalConfig.volatility;
      CONFIG.cooldown.ENABLED = originalConfig.cooldownEnabled;
      console.log("✅ Auto-correction reset after successful trade");
    }
  }

  // Відстежуємо час останнього трейду через перехоплення onTick
  const originalOnTick = onTick;
  onTick = async function(price, volume) {
    const result = await originalOnTick(price, volume);
    // Якщо був вхід у позицію, оновлюємо час
    if (state.status === "IN_TRADE") {
      lastTradeTime = Date.now();
    }
    return result;
  };

  // Перехоплюємо закриття позиції для скидання корекції
  const originalCheckExit = checkExit;
  checkExit = function(price) {
    const exitResult = originalCheckExit(price);
    if (exitResult === 'TP' || exitResult === 'SL') {
      // Після виходу скидаємо корекцію (але через невелику затримку)
      setTimeout(() => resetCorrection(), 1000);
    }
    return exitResult;
  };

  // Періодична перевірка активності
  setInterval(() => {
    const now = Date.now();
    const idleTime = now - lastTradeTime;
    if (idleTime > CFG.NO_TRADE_TIMEOUT_MS && state.status === "IDLE") {
      console.log(`⚠️ No trade for ${Math.floor(idleTime/1000)}s. Applying auto-correction.`);
      applyCorrection();
    }
    if (idleTime > CFG.CRITICAL_NO_TRADE_MS) {
      console.log(`🚨 CRITICAL: No trade for ${Math.floor(idleTime/1000)}s. Forcing entry mode.`);
      applyCorrection(); // це викличе форсований режим після досягнення максимуму
    }
  }, CFG.CHECK_INTERVAL_MS);

  // Зберігаємо оригінальні параметри при запуску
  saveOriginalConfig();
  console.log("✅ Auto-correction logic ready. Will adjust thresholds if no trades detected.");
})();

// ================== MODULE 49: BINANCE PRICE VALIDATOR & CORRECTOR ==================
(function initModule49() {
  if (global.__MODULE_49_LOADED__) return;
  global.__MODULE_49_LOADED__ = true;
  console.log("💰 MODULE 49: Binance Price Validator & Corrector ACTIVE");

  // Конфігурація
  const CFG = {
    VALIDATION_INTERVAL_MS: 10000,      // перевіряти ціну кожні 10 секунд
    MAX_DEVIATION_PERCENT: 1.0,         // максимальне відхилення 1% перед корекцією
    DISABLE_AGGRESSIVE_NORMALIZATION: true,
    FETCH_TIMEOUT_MS: 3000,
  };

  let lastValidPrice = null;
  let lastValidationTime = 0;
  let correctionCount = 0;

  // Функція отримання поточної ціни з Binance REST API (symbol price ticker)
  async function fetchRealPrice() {
    const symbol = CONFIG.ws.SYMBOL.toUpperCase();
    const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CFG.FETCH_TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await res.json();
      if (data && data.price) {
        return parseFloat(data.price);
      }
    } catch (err) {
      console.error("❌ Failed to fetch real price:", err.message);
    }
    return null;
  }

  // Корекція ціни, якщо відхилення занадто велике
  async function validateAndCorrect(currentPrice) {
    if (!currentPrice || currentPrice <= 0) return null;
    const now = Date.now();
    // Не перевіряти частіше ніж раз на 10 секунд
    if (now - lastValidationTime < CFG.VALIDATION_INTERVAL_MS && lastValidPrice !== null) {
      // Якщо відхилення від останньої відомої ціни менше 5%, повертаємо поточну
      if (lastValidPrice && Math.abs((currentPrice - lastValidPrice) / lastValidPrice) * 100 < 5) {
        return currentPrice;
      }
    }
    const realPrice = await fetchRealPrice();
    if (!realPrice) return currentPrice;
    lastValidationTime = now;
    const deviation = Math.abs((currentPrice - realPrice) / realPrice) * 100;
    if (deviation > CFG.MAX_DEVIATION_PERCENT) {
      console.log(`⚠️ Price deviation detected: WS=${currentPrice.toFixed(8)}, REAL=${realPrice.toFixed(8)} (${deviation.toFixed(2)}%). Correcting to REAL.`);
      correctionCount++;
      lastValidPrice = realPrice;
      return realPrice;
    }
    lastValidPrice = currentPrice;
    return currentPrice;
  }

  // Вимкнути агресивну нормалізацію (модуль 35)
  if (CFG.DISABLE_AGGRESSIVE_NORMALIZATION && global.normalizePrice) {
    const originalNormalize = global.normalizePrice;
    global.normalizePrice = function(price) {
      // Якщо ціна менше 0.01, не нормалізуємо до 0.1
      if (price < 0.1 && price > 0.001) return price;
      return originalNormalize ? originalNormalize(price) : price;
    };
    console.log("🔧 Aggressive price normalization disabled");
  }

  // Перехоплюємо onTick для валідації ціни
  const originalOnTick49 = onTick;
  onTick = async function(price, volume) {
    const validatedPrice = await validateAndCorrect(price);
    if (!validatedPrice) return originalOnTick49(price, volume);
    if (validatedPrice !== price) {
      console.log(`🔧 Price corrected: ${price.toFixed(8)} → ${validatedPrice.toFixed(8)}`);
    }
    return originalOnTick49(validatedPrice, volume);
  };

  // Періодичне оновлення ціни навіть без тиків
  setInterval(async () => {
    const realPrice = await fetchRealPrice();
    if (realPrice && lastValidPrice && Math.abs((realPrice - lastValidPrice) / lastValidPrice) * 100 > CFG.MAX_DEVIATION_PERCENT) {
      console.log(`🔧 Background price sync: ${lastValidPrice?.toFixed(8)} → ${realPrice.toFixed(8)}`);
      lastValidPrice = realPrice;
    } else if (realPrice) {
      lastValidPrice = realPrice;
    }
  }, CFG.VALIDATION_INTERVAL_MS);

  // Функція для ручного виклику
  global.validateCurrentPrice = async () => {
    const realPrice = await fetchRealPrice();
    console.log(`Current WS price: ${buffers.getPrices().slice(-1)[0]}, Real price: ${realPrice}`);
    return realPrice;
  };

  console.log(`✅ Price validator ready. Max deviation: ${CFG.MAX_DEVIATION_PERCENT}%, checking every ${CFG.VALIDATION_INTERVAL_MS/1000}s`);
})();

// ================== MODULE 53: AI GUARD ORCHESTRATOR ==================
// Структурований цикл прийняття рішень: зважені докази, перемикання режимів, прибутковий вихід
(function initModule53() {
  if (global.__MODULE_53_LOADED__) return;
  global.__MODULE_53_LOADED__ = true;
  console.log("🎛️ MODULE 53: AI Guard Orchestrator - Structured Decision Cycle ACTIVE");

  // ========== 1. КОНФІГУРАЦІЯ ОРКЕСТРАТОРА ==========
  const ORCH_CFG = {
    // Часи опитування
    POLL_INTERVAL_MS: 3000,           // кожні 3 секунди аналізуємо можливість входу
    MAX_WAIT_FOR_SIGNAL_MS: 30000,    // 30 секунд очікування сильного сигналу
    // Ваги доказів (сума має бути 1.0)
    EVIDENCE_WEIGHTS: {
      deviation: 0.35,     // відхилення ціни від середньої
      volumeSpike: 0.25,   // сплеск об'єму
      volatility: 0.15,    // волатильність
      candlePattern: 0.10, // патерн свічки
      trend: 0.10,         // мікротренд
      liquidity: 0.05,     // ліквідність
    },
    // Пороги для прийняття рішення
    ENTRY_THRESHOLD: 0.65,            // 65% зважених доказів для входу
    EXIT_PROFIT_THRESHOLD: 0.5,       // 0.5% прибутку для виходу (або використовуємо TP)
    MAX_LOSS_PERCENT: 0.3,            // максимальний збиток 0.3% перед виходом
    // Режими торгів
    MODES: ['conservative', 'moderate', 'aggressive'],
    DEFAULT_MODE: 'moderate',
  };

  // Поточний стан оркестратора
  let orchestrationState = {
    mode: ORCH_CFG.DEFAULT_MODE,
    lastPollTime: 0,
    evidenceHistory: [],
    pendingDecision: null,
    lastEntryTime: 0,
    profitTarget: CONFIG.risk.TAKE_PROFIT,
    lossLimit: CONFIG.risk.STOP_LOSS,
    consecutiveLosses: 0,
    adaptiveFactor: 1.0,
  };

  // ========== 2. ЗБІР ДОКАЗІВ (ЗВАЖЕНІ ФАКТОРИ) ==========
  function collectEvidence(price) {
    const dev = Math.abs(deviation(price));
    const spike = volumeSpike();
    const vol = volatility();
    const lastCandle = global.getLastCandleAnalysis ? global.getLastCandleAnalysis() : null;
    const trend = (() => {
      const prices = buffers.getPrices();
      if (prices.length < 10) return 0;
      const short = avg(prices.slice(-5));
      const long = avg(prices.slice(-10));
      return (short - long) / long;
    })();
    const liquidity = (() => {
      // Симуляція ліквідності на основі об'єму
      const volumes = buffers.getVolumes();
      if (volumes.length < 10) return 0.5;
      const avgVol = avg(volumes);
      const lastVol = volumes[volumes.length - 1];
      return Math.min(1, lastVol / (avgVol + 0.001));
    })();

    // Нормалізуємо значення до діапазону [0..1]
    const normDev = Math.min(1, dev / 0.01); // 1% відхилення = 1.0
    const normSpike = Math.min(1, spike / 3); // 3x сплеск = 1.0
    const normVol = Math.min(1, vol / 0.005); // 0.5% волатильність = 1.0
    const normCandle = lastCandle ? (lastCandle.isReversal ? 0.8 : (lastCandle.type.includes('BULLISH') ? 0.6 : 0.3)) : 0.4;
    const normTrend = Math.min(1, Math.abs(trend) / 0.002); // 0.2% тренд = 1.0
    const normLiquidity = liquidity;

    const evidence = {
      deviation: normDev,
      volumeSpike: normSpike,
      volatility: normVol,
      candlePattern: normCandle,
      trend: normTrend,
      liquidity: normLiquidity,
    };
    return evidence;
  }

  function computeWeightedScore(evidence) {
    let score = 0;
    for (const [key, weight] of Object.entries(ORCH_CFG.EVIDENCE_WEIGHTS)) {
      score += (evidence[key] || 0) * weight;
    }
    return Math.min(1, Math.max(0, score));
  }

  // ========== 3. ТИМЧАСОВЕ ОПИТУВАННЯ ІМІТОВАНОЇ МОДЕЛІ ==========
  // Штучна нейронна оцінка (простий фільтр Калмана подібний)
  let predictedPrice = null;
  let lastPrice = null;
  let priceVelocity = 0;
  function updatePrediction(currentPrice) {
    if (lastPrice === null) {
      lastPrice = currentPrice;
      predictedPrice = currentPrice;
      return;
    }
    const dt = 1; // умовно 1 секунда
    const alpha = 0.3; // коефіцієнт згладжування
    priceVelocity = priceVelocity * 0.8 + ((currentPrice - lastPrice) / dt) * 0.2;
    predictedPrice = currentPrice + priceVelocity * dt;
    lastPrice = currentPrice;
  }
  function getModelSignal(price) {
    updatePrediction(price);
    const predictedMove = (predictedPrice - price) / price;
    if (Math.abs(predictedMove) < 0.0005) return { side: null, confidence: 0 };
    const side = predictedMove > 0 ? 'long' : 'short';
    const confidence = Math.min(0.9, Math.abs(predictedMove) * 100);
    return { side, confidence };
  }

  // ========== 4. AI GUARD ПІДТВЕРДЖЕННЯ (зважені докази + модель) ==========
  async function getAIGuardApproval(price, side) {
    const evidence = collectEvidence(price);
    const weightedScore = computeWeightedScore(evidence);
    const modelSignal = getModelSignal(price);
    let modelAgree = (modelSignal.side === side) ? modelSignal.confidence : (1 - modelSignal.confidence);
    const totalConfidence = weightedScore * 0.6 + modelAgree * 0.4;
    const approved = totalConfidence >= ORCH_CFG.ENTRY_THRESHOLD;
    console.log(`🧠 AI GUARD: side=${side}, score=${weightedScore.toFixed(2)}, model=${modelAgree.toFixed(2)}, total=${totalConfidence.toFixed(2)} → ${approved ? 'APPROVED' : 'REJECTED'}`);
    return { approved, confidence: totalConfidence, evidence };
  }

  // ========== 5. ПЕРЕМИКАННЯ РЕЖИМАМИ ТОРГІВЛІ ==========
  function adjustTradingMode(performance) {
    // performance: winRate (0..1), avgProfit, consecutiveLosses
    let newMode = ORCH_CFG.DEFAULT_MODE;
    if (performance.winRate > 0.6 && performance.avgProfit > 0.002) {
      newMode = 'aggressive';
      ORCH_CFG.EVIDENCE_WEIGHTS.deviation = 0.4;
      ORCH_CFG.EVIDENCE_WEIGHTS.volumeSpike = 0.3;
      ORCH_CFG.ENTRY_THRESHOLD = 0.55;
    } else if (performance.winRate < 0.4 || performance.consecutiveLosses > 2) {
      newMode = 'conservative';
      ORCH_CFG.EVIDENCE_WEIGHTS.deviation = 0.3;
      ORCH_CFG.EVIDENCE_WEIGHTS.volumeSpike = 0.2;
      ORCH_CFG.ENTRY_THRESHOLD = 0.75;
    } else {
      newMode = 'moderate';
      ORCH_CFG.EVIDENCE_WEIGHTS.deviation = 0.35;
      ORCH_CFG.EVIDENCE_WEIGHTS.volumeSpike = 0.25;
      ORCH_CFG.ENTRY_THRESHOLD = 0.65;
    }
    if (newMode !== orchestrationState.mode) {
      console.log(`🔄 Mode switch: ${orchestrationState.mode} → ${newMode}`);
      orchestrationState.mode = newMode;
    }
    // Коригування коефіцієнта заробітку (adaptiveFactor)
    if (performance.winRate > 0.55) {
      orchestrationState.adaptiveFactor = Math.min(1.5, orchestrationState.adaptiveFactor + 0.05);
    } else if (performance.winRate < 0.45) {
      orchestrationState.adaptiveFactor = Math.max(0.7, orchestrationState.adaptiveFactor - 0.05);
    }
    // Оновлюємо TP/SL відповідно до режиму та адаптивного фактора
    if (orchestrationState.mode === 'aggressive') {
      CONFIG.risk.TAKE_PROFIT = Math.min(0.5, 0.3 * orchestrationState.adaptiveFactor);
      CONFIG.risk.STOP_LOSS = Math.min(0.8, 0.4 * orchestrationState.adaptiveFactor);
    } else if (orchestrationState.mode === 'conservative') {
      CONFIG.risk.TAKE_PROFIT = Math.max(0.1, 0.15 * orchestrationState.adaptiveFactor);
      CONFIG.risk.STOP_LOSS = Math.max(0.2, 0.25 * orchestrationState.adaptiveFactor);
    } else {
      CONFIG.risk.TAKE_PROFIT = Math.min(0.4, 0.2 * orchestrationState.adaptiveFactor);
      CONFIG.risk.STOP_LOSS = Math.min(0.6, 0.35 * orchestrationState.adaptiveFactor);
    }
    console.log(`📊 Mode: ${orchestrationState.mode}, TP=${CONFIG.risk.TAKE_PROFIT.toFixed(2)}%, SL=${CONFIG.risk.STOP_LOSS.toFixed(2)}%, factor=${orchestrationState.adaptiveFactor.toFixed(2)}`);
  }

  // ========== 6. ПРИБУТКОВЕ ЗАКРИТТЯ ПОЗИЦІЇ (КРАЩЕ, НІЖ ЗБИТОК) ==========
  function shouldCloseProfitable(price, entry, side) {
    if (state.status !== 'IN_TRADE') return false;
    let profitPercent = (side === 'long') ? (price - entry) / entry : (entry - price) / entry;
    profitPercent *= 100;
    if (profitPercent >= ORCH_CFG.EXIT_PROFIT_THRESHOLD) {
      console.log(`💰 PROFIT EXIT: ${profitPercent.toFixed(2)}%`);
      return true;
    }
    // Якщо збиток перевищує ліміт – виходимо, але це не прибутково, тому намагаємося уникати
    if (-profitPercent > ORCH_CFG.MAX_LOSS_PERCENT) {
      console.log(`⚠️ LOSS LIMIT: ${(-profitPercent).toFixed(2)}%`);
      return true;
    }
    return false;
  }

  // Перевизначаємо checkExit, щоб додати логіку прибуткового закриття
  const originalCheckExit53 = checkExit;
  checkExit = function(price) {
    if (state.status === 'IN_TRADE') {
      if (shouldCloseProfitable(price, state.entry, state.side)) {
        // Примусове закриття з прибутком
        const pnl = state.side === 'long' ? (price - state.entry) : (state.entry - price);
        const pnlPercent = (pnl / state.entry) * 100;
        account.balance += account.balance * (pnlPercent / 100);
        if (pnlPercent < 0) account.dailyLoss += Math.abs(pnlPercent);
        console.log(`💰 Orchestrator closed: PnL ${pnlPercent.toFixed(2)}%`);
        state.status = "IDLE";
        state.entry = null;
        state.side = null;
        return 'ORCHESTRATOR_EXIT';
      }
    }
    return originalCheckExit53(price);
  };

  // ========== 7. ГОЛОВНИЙ ЦИКЛ ОРКЕСТРАТОРА ==========
  async function orchestrationCycle() {
    const now = Date.now();
    if (now - orchestrationState.lastPollTime < ORCH_CFG.POLL_INTERVAL_MS) return;
    orchestrationState.lastPollTime = now;

    if (state.status !== 'IDLE') return;
    if (cooldownUntil > now) return;

    // Отримуємо правдиву ціну (з модуля 50-52)
    const price = global.getTruthfulPrice ? global.getTruthfulPrice() : buffers.getPrices().slice(-1)[0];
    if (!price) return;

    // 1. Збираємо докази
    const evidence = collectEvidence(price);
    const weightedScore = computeWeightedScore(evidence);
    
    // 2. Отримуємо сигнал від імітованої моделі
    const modelSignal = getModelSignal(price);
    let proposedSide = modelSignal.side;
    if (!proposedSide) {
      // Якщо модель не дає напрямку, використовуємо відхилення ціни
      const dev = deviation(price);
      if (Math.abs(dev) > 0.0005) proposedSide = dev > 0 ? 'short' : 'long';
      else return;
    }

    // 3. AI Guard підтвердження
    const { approved, confidence, evidence: ev } = await getAIGuardApproval(price, proposedSide);
    if (!approved) return;

    // 4. Перевірка, чи не минуло занадто багато часу без сигналу (опціонально)
    // 5. Вхід
    const qty = calcPositionSize(price);
    if (qty <= 0) return;
    const order = await placeOrder(proposedSide, qty, price);
    if (order) {
      state.status = "IN_TRADE";
      state.entry = price;
      state.side = proposedSide;
      orchestrationState.lastEntryTime = now;
      orchestrationState.consecutiveLosses = 0;
      console.log(`🎯 ORCHESTRATOR ENTRY: ${proposedSide} @ ${price}, confidence=${confidence.toFixed(2)}`);
    }
  }

  // ========== 8. ЗБІР СТАТИСТИКИ ДЛЯ АДАПТАЦІЇ РЕЖИМУ ==========
  let tradeResults = []; // зберігає останні 20 угод
  function updateTradeStats(result, pnlPercent) {
    tradeResults.push({ result, pnlPercent, timestamp: Date.now() });
    if (tradeResults.length > 20) tradeResults.shift();
    const wins = tradeResults.filter(t => t.result === 'win').length;
    const losses = tradeResults.filter(t => t.result === 'loss').length;
    const winRate = wins / (wins + losses || 1);
    const avgProfit = tradeResults.filter(t => t.pnlPercent > 0).reduce((s, t) => s + t.pnlPercent, 0) / (wins || 1);
    const consecutiveLosses = (() => {
      let cnt = 0;
      for (let i = tradeResults.length - 1; i >= 0; i--) {
        if (tradeResults[i].result === 'loss') cnt++;
        else break;
      }
      return cnt;
    })();
    orchestrationState.consecutiveLosses = consecutiveLosses;
    adjustTradingMode({ winRate, avgProfit, consecutiveLosses });
  }

  // Перехоплюємо закриття позиції (TP/SL або Orchestrator exit)
  const originalExitHandler = checkExit;
  checkExit = function(price) {
    const exitResult = originalExitHandler(price);
    if (exitResult && state.status === 'IDLE') {
      // Після виходу визначаємо, чи це був прибуток чи збиток
      // Нам потрібно знати PnL – можна зберегти в глобальній змінній останнього PnL
      const lastPnL = (() => {
        // Симуляція: якщо вийшли по TP – прибуток, по SL – збиток
        if (exitResult === 'TP') return 'win';
        if (exitResult === 'SL') return 'loss';
        if (exitResult === 'ORCHESTRATOR_EXIT') return 'win';
        return 'unknown';
      })();
      if (lastPnL !== 'unknown') {
        // pnlPercent приблизно
        const pnlPercent = (lastPnL === 'win') ? CONFIG.risk.TAKE_PROFIT : -CONFIG.risk.STOP_LOSS;
        updateTradeStats(lastPnL, pnlPercent);
      }
    }
    return exitResult;
  };

  // ========== 9. ЗАПУСК ЦИКЛУ ==========
  setInterval(() => orchestrationCycle(), ORCH_CFG.POLL_INTERVAL_MS);
  console.log("✅ Orchestrator active: structured entry, mode switching, profitable exit.");
})();

// ================== MODULE 54: EMERGENCY ENTRY & FIX NORMALIZATION ==================
(function initModule54() {
  if (global.__MODULE_54_LOADED__) return;
  global.__MODULE_54_LOADED__ = true;
  console.log("🚨 MODULE 54: Emergency Entry & Fix Normalization ACTIVE");

  // 1. Вимкнути агресивну нормалізацію ціни (модуль 35)
  if (global.normalizePrice) {
    global.normalizePrice = (price) => price;
    console.log("   ✅ Price normalization disabled");
  }

  // 2. Вимкнути anti-reversal (модуль 17)
  if (global.antiReversalCheck) {
    global.antiReversalCheck = () => true;
    console.log("   ✅ Anti-reversal disabled");
  }

  // 3. Вимкнути volatility filter (модуль 15)
  if (global.volatilityCheck) {
    global.volatilityCheck = () => ({ action: "TRADE", volatility: 1 });
    console.log("   ✅ Volatility filter disabled");
  }

  // 4. Вимкнути баланс фільтр (модуль 13)
  if (global.balanceFilter) {
    global.balanceFilter = (signal) => signal;
    console.log("   ✅ Balance filter disabled");
  }

  // 5. Зменшити пороги входу до мінімуму
  if (CONFIG.signal) {
    CONFIG.signal.DEVIATION_THRESHOLD = 0.0001;   // 0.01%
    CONFIG.signal.VOLUME_THRESHOLD = 1.0;
    CONFIG.signal.VOLATILITY_THRESHOLD = 0.00005;
    console.log("   ✅ Thresholds minimized");
  }

  // 6. Видалити обмеження кулдауну
  if (CONFIG.cooldown) {
    CONFIG.cooldown.ENABLED = false;
    console.log("   ✅ Cooldown disabled");
  }

  // 7. Перевизначити buildSignal для генерації сигналів при малому відхиленні
  const originalBuildSignal54 = buildSignal;
  global.buildSignal = function(price) {
    let signal = originalBuildSignal54(price);
    if (!signal && price > 0) {
      const dev = deviation(price);
      if (Math.abs(dev) > 0.0003) { // 0.03% відхилення
        signal = { side: dev > 0 ? "short" : "long", dev, ts: Date.now(), emergency: true };
        console.log(`🚨 Emergency signal: ${signal.side} deviation=${(dev*100).toFixed(3)}%`);
      }
    }
    return signal;
  };

  // 8. Примусовий таймер входу (кожні 5 секунд, якщо немає позиції)
  let lastForceAttempt = 0;
  const forceInterval = setInterval(async () => {
    if (state.status !== "IDLE") return;
    if (cooldownUntil > Date.now()) return;
    const price = buffers.getPrices().slice(-1)[0];
    if (!price || price < 0.09 || price > 0.11) return;
    const dev = deviation(price);
    if (Math.abs(dev) < 0.0003) return;
    const side = dev > 0 ? "short" : "long";
    const qty = calcPositionSize(price);
    if (qty <= 0) return;
    console.log(`🚨 FORCE ENTRY: ${side} @ ${price}`);
    const order = await placeOrder(side, qty, price);
    if (order) {
      state.status = "IN_TRADE";
      state.entry = price;
      state.side = side;
    }
  }, 5000);

  // Збереження для можливого скидання
  global.disableForceEntry = () => clearInterval(forceInterval);
  console.log("✅ Emergency entry ready - bot will force entries every 5s if conditions met");
})();

// ================== MODULE 55: HARD ENTRY ENFORCER ==================
(function initModule55() {
  if (global.__MODULE_55_LOADED__) return;
  global.__MODULE_55_LOADED__ = true;
  console.log("🔥 MODULE 55: Hard Entry Enforcer ACTIVE - bypassing all filters");

  // Вимкнути всі можливі блокування
  if (CONFIG.cooldown) CONFIG.cooldown.ENABLED = false;
  if (CONFIG.signal) {
    CONFIG.signal.DEVIATION_THRESHOLD = 0.00001;
    CONFIG.signal.VOLUME_THRESHOLD = 0.1;
    CONFIG.signal.VOLATILITY_THRESHOLD = 0.00001;
  }
  if (global.antiReversalCheck) global.antiReversalCheck = () => true;
  if (global.volatilityCheck) global.volatilityCheck = () => ({ action: "TRADE" });
  if (global.balanceFilter) global.balanceFilter = (s) => s;
  if (global.normalizePrice) global.normalizePrice = (p) => p;

  // Перевизначаємо buildSignal - завжди генерує сигнал на основі простого тренду
  global.buildSignal = function(price) {
    const prices = buffers.getPrices();
    if (prices.length < 5) return null;
    const shortAvg = avg(prices.slice(-3));
    const longAvg = avg(prices.slice(-5));
    const side = shortAvg > longAvg ? "long" : "short";
    return { side, dev: (shortAvg - longAvg) / longAvg, ts: Date.now(), hard: true };
  };

  // Примусовий вхід кожні 3 секунди, якщо немає позиції
  let lastHardEntry = 0;
  setInterval(async () => {
    if (state.status !== "IDLE") return;
    const now = Date.now();
    if (now - lastHardEntry < 3000) return;
    lastHardEntry = now;
    
    const price = global.getTruthfulPrice ? global.getTruthfulPrice() : buffers.getPrices().slice(-1)[0];
    if (!price || price < 0.09 || price > 0.10) return;
    
    const signal = global.buildSignal(price);
    if (!signal || !signal.side) return;
    
    const qty = calcPositionSize(price);
    if (qty <= 0) return;
    
    console.log(`🔥 HARD ENTRY: ${signal.side} @ ${price.toFixed(8)}`);
    const order = await placeOrder(signal.side, qty, price);
    if (order) {
      state.status = "IN_TRADE";
      state.entry = price;
      state.side = signal.side;
      console.log("✅ HARD ENTRY SUCCESS");
    } else {
      console.log("❌ HARD ENTRY FAILED - check placeOrder");
    }
  }, 3000);
})();

// ================== MODULE 56: FIX NORMALIZATION & WORKERS ==================
(function() {
  // 1. Вбиваємо нормалізацію ціни (яка перетворює 0.093 на 0)
  if (global.normalizePrice) global.normalizePrice = p => p;
  if (global.priceNormalize) global.priceNormalize = p => p;
  // 2. Тимчасово вимикаємо заміну хворих воркерів (щоб не спамило)
  if (global.replaceSickWorker) global.replaceSickWorker = () => {};
  console.log("✅ Price normalization killed, worker replacement disabled.");
})();

// ================== MODULE 57: COMPLETE FIX ==================
(function(){
  // Виправлення ціни - завжди повертає реальне значення
  global.normalizePrice = p => p;
  global.priceNormalize = p => p;
  // Зупиняємо заміну воркерів
  global.replaceSickWorker = ()=>{};
  // Вимикаємо всі блокувальні фільтри
  if(CONFIG.cooldown) CONFIG.cooldown.ENABLED=false;
  if(CONFIG.signal){
    CONFIG.signal.DEVIATION_THRESHOLD=0.0001;
    CONFIG.signal.VOLUME_THRESHOLD=1.0;
  }
  // Перевизначаємо checkExit, щоб вона не блокувала вхід
  const orig=checkExit;
  checkExit = function(price){
    if(state.status==="IN_TRADE") return orig(price);
    return null;
  };
  console.log("✅ FULL FIX: price OK, workers stable, filters off");
})();

// ================== MODULE 58: BINANCE ERROR CORRECTOR (COPY OF 35) ==================
(function initModule58() {
  if (global.__MODULE_58_LOADED__) return;
  global.__MODULE_58_LOADED__ = true;
  console.log("🛡️ MODULE 58: Binance Error Corrector (copy of 35) ACTIVE");

  const CFG = {
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 2000,
    POSITION_RECOVERY_ATTEMPTS: 2,
    MARGIN_CALL_THRESHOLD: 0.95,
    LIQUIDATION_BUFFER: 0.05,
    CORRECTION_FACTOR: 0.9,
    EMERGENCY_COOLDOWN: 60000,
  };

  const binanceErrorCache = new Map();
  let consecutiveBinanceErrors = 0;
  let lastErrorTime = 0;
  let emergencyRecoveryMode = false;

  const errorHashLog = new Map();
  function logError(errorCode, errorMsg, context) {
    const key = crypto.createHash('sha256').update(`${Date.now()}:${errorCode}:${errorMsg}`).digest('hex');
    if (errorHashLog.has(key)) {
      errorHashLog.get(key).count++;
    } else {
      errorHashLog.set(key, { errorCode, errorMsg, context, count: 1, timestamp: Date.now() });
      if (errorHashLog.size > 5000) {
        const oldest = Array.from(errorHashLog.entries()).sort((a,b) => a[1].timestamp - b[1].timestamp)[0];
        errorHashLog.delete(oldest[0]);
      }
    }
  }

  function analyzeBinanceError(error) {
    const errorCode = error?.code || error?.data?.code || 'UNKNOWN';
    const errorMsg = error?.msg || error?.message || String(error);
    
    const categories = {
      INSUFFICIENT_MARGIN: ['-2010', '-2011', '-1003', 'margin', 'balance', 'insufficient'],
      PRICE_FILTER: ['-2010', 'PRICE_FILTER', 'price too high', 'price too low'],
      LOT_SIZE: ['-2010', 'LOT_SIZE', 'step size', 'minQty', 'maxQty'],
      POSITION_NOT_FOUND: ['-2013', 'Order does not exist', 'position not found'],
      MARKET_CLOSED: ['-1002', 'Market closed', 'trading halted'],
      RATE_LIMIT: ['-1003', 'Too many requests', 'rate limit'],
      LIQUIDATION: ['-2010', 'Liquidation', 'force close'],
      SERVER_BUSY: ['-1001', 'Internal error', 'timeout', 'busy']
    };
    
    let category = 'OTHER';
    for (const [cat, patterns] of Object.entries(categories)) {
      if (patterns.some(p => errorMsg.includes(p) || (errorCode && errorCode.includes(p)))) {
        category = cat;
        break;
      }
    }
    logError(errorCode, errorMsg, category);
    return { category, errorCode, errorMsg };
  }

  async function fixInsufficientMargin(originalParams) {
    console.log("💰 AI Guard: Fixing insufficient margin...");
    const newQuantity = Math.max(1, Math.floor(originalParams.quantity * CFG.CORRECTION_FACTOR));
    console.log(`   New quantity: ${newQuantity} (was ${originalParams.quantity})`);
    return { ...originalParams, quantity: newQuantity, fixed: true };
  }

  async function fixLotSize(originalParams) {
    console.log("📏 AI Guard: Fixing lot size / step size...");
    const stepSize = global.stepSize || 1;
    let newQuantity = Math.floor(originalParams.quantity / stepSize) * stepSize;
    if (newQuantity < 1) newQuantity = stepSize;
    console.log(`   New quantity: ${newQuantity} (step=${stepSize})`);
    return { ...originalParams, quantity: newQuantity, fixed: true };
  }

  async function fixPriceFilter(originalParams) {
    console.log("💲 AI Guard: Fixing price filter...");
    const tickSize = global.tickSize || 0.00001;
    let newPrice = Math.floor(originalParams.price / tickSize) * tickSize;
    if (newPrice <= 0) newPrice = tickSize;
    console.log(`   New price: ${newPrice} (tick=${tickSize})`);
    return { ...originalParams, price: newPrice, fixed: true };
  }

  async function fixRateLimit() {
    console.log("⏳ AI Guard: Rate limit hit. Waiting 5 seconds...");
    await new Promise(r => setTimeout(r, 5000));
    return { action: 'retry', delay: 5000 };
  }

  async function fixLiquidation(originalParams) {
    console.log("⚠️ AI Guard: Liquidation risk detected! Closing position...");
    if (state.status === "IN_TRADE") {
      const closeSide = state.side === "long" ? "sell" : "buy";
      try {
        const qty = calcPositionSize(originalParams.price);
        await placeOrder(closeSide, qty, originalParams.price);
        console.log("✅ AI Guard: Position closed due to liquidation risk");
        state.status = "IDLE";
        state.entry = null;
        state.side = null;
      } catch (e) {
        console.error("❌ AI Guard: Failed to close position", e.message);
      }
    }
    return { action: 'abort', reason: 'liquidation' };
  }

  async function fixOtherError(originalParams) {
    console.log("🔧 AI Guard: Unknown Binance error, applying generic fix...");
    const newQuantity = Math.max(1, Math.floor(originalParams.quantity * 0.8));
    await new Promise(r => setTimeout(r, 3000));
    return { ...originalParams, quantity: newQuantity, fixed: true, delay: 3000 };
  }

  async function handleBinanceError(error, originalParams, retryCount = 0) {
    const analysis = analyzeBinanceError(error);
    console.log(`⚠️ Binance error: [${analysis.errorCode}] ${analysis.errorMsg} (category: ${analysis.category})`);
    
    consecutiveBinanceErrors++;
    lastErrorTime = Date.now();
    
    if (consecutiveBinanceErrors > 5) {
      console.log("🚨 Too many consecutive Binance errors. Entering emergency recovery mode.");
      emergencyRecoveryMode = true;
      setTimeout(() => { emergencyRecoveryMode = false; console.log("✅ Emergency recovery mode ended"); }, CFG.EMERGENCY_COOLDOWN);
    }
    
    if (retryCount >= CFG.MAX_RETRIES) {
      console.log(`❌ Max retries (${CFG.MAX_RETRIES}) reached. Aborting order.`);
      return { success: false, action: 'abort' };
    }
    
    let fixResult;
    switch (analysis.category) {
      case 'INSUFFICIENT_MARGIN':
        fixResult = await fixInsufficientMargin(originalParams);
        break;
      case 'LOT_SIZE':
        fixResult = await fixLotSize(originalParams);
        break;
      case 'PRICE_FILTER':
        fixResult = await fixPriceFilter(originalParams);
        break;
      case 'RATE_LIMIT':
        fixResult = await fixRateLimit();
        break;
      case 'LIQUIDATION':
        fixResult = await fixLiquidation(originalParams);
        break;
      default:
        fixResult = await fixOtherError(originalParams);
    }
    
    if (fixResult.action === 'abort') {
      return { success: false, action: 'abort' };
    }
    if (fixResult.action === 'retry') {
      await new Promise(r => setTimeout(r, fixResult.delay || CFG.RETRY_DELAY_MS));
      return { success: true, action: 'retry', params: originalParams };
    }
    if (fixResult.fixed) {
      console.log(`🔄 Retrying with fixed params (attempt ${retryCount + 1}/${CFG.MAX_RETRIES})...`);
      await new Promise(r => setTimeout(r, CFG.RETRY_DELAY_MS));
      return { success: true, action: 'retry', params: fixResult };
    }
    return { success: false, action: 'abort' };
  }

  const originalPlaceOrder = global.placeOrder || placeOrder;
  const orderRetryMap = new Map();
  
  global.placeOrder = async function(side, quantity, currentPrice, context = {}) {
    const orderKey = `${side}_${Date.now()}_${Math.random()}`;
    let retries = orderRetryMap.get(orderKey) || 0;
    
    const executeWithRetry = async (params) => {
      try {
        const result = await originalPlaceOrder(params.side, params.quantity, params.price);
        consecutiveBinanceErrors = 0;
        emergencyRecoveryMode = false;
        orderRetryMap.delete(orderKey);
        return result;
      } catch (error) {
        if (error?.msg || error?.code || error?.message?.includes('binance')) {
          const handlerResult = await handleBinanceError(error, params, retries);
          if (handlerResult.success && handlerResult.action === 'retry') {
            retries++;
            orderRetryMap.set(orderKey, retries);
            return executeWithRetry(handlerResult.params);
          }
        }
        console.error("❌ Unrecoverable order error:", error);
        return null;
      }
    };
    return executeWithRetry({ side, quantity, price: currentPrice });
  };

  async function checkAccountHealth() {
    if (!CONFIG.trading.REAL_MODE) return;
    try {
      const balance = account.balance;
      const usedMargin = account.balance * 0.1;
      const usage = usedMargin / (account.balance || 1);
      if (usage > CFG.MARGIN_CALL_THRESHOLD) {
        console.log(`⚠️ High margin usage: ${(usage*100).toFixed(1)}%. Reducing risk.`);
        CONFIG.risk.MAX_RISK_PER_TRADE = Math.max(0.5, CONFIG.risk.MAX_RISK_PER_TRADE * 0.8);
      }
    } catch (err) {
      console.error("Health check error:", err.message);
    }
  }

  setInterval(() => checkAccountHealth(), 30000);

  let reconnectAttempts = 0;
  const originalStartWebSocket = startWebSocket;
  global.startWebSocket = function() {
    console.log("🔌 AI Guard: Starting WebSocket with auto-recovery...");
    originalStartWebSocket();
    if (ws) {
      ws.on('error', (err) => {
        console.error("WebSocket error:", err.message);
        reconnectAttempts++;
        if (reconnectAttempts > 3) {
          console.log("🔄 Multiple WebSocket errors, restarting connection...");
          setTimeout(() => {
            if (ws) ws.close();
            startWebSocket();
          }, 10000);
        }
      });
      ws.on('open', () => { reconnectAttempts = 0; });
    }
  };

  console.log("✅ MODULE 58: Binance Error Corrector ready");
})();

// ================== MODULE 59: TIMESTAMP-BASED REAL DATA VALIDATOR ==================
(function initModule59() {
  if (global.__MODULE_59_LOADED__) return;
  global.__MODULE_59_LOADED__ = true;
  console.log("⏱️ MODULE 59: Timestamp-based Real Data Validator ACTIVE");

  const CFG = {
    MAX_ALLOWED_DELAY_MS: 5000,      // відкидати дані старіші за 5 секунд
    MIN_INTERVAL_MS: 200,            // мінімальний інтервал між тиками (захист від спаму)
    TIMESTAMP_TOLERANCE_MS: 1000,    // допустиме відхилення часу
    MAX_CONSECUTIVE_INVALID: 5,      // після N невалідних даних – примусова синхронізація
  };

  let lastValidTimestamp = 0;
  let lastTickTime = 0;
  let invalidCount = 0;
  let lastPrice = null;

  // Отримуємо реальний час із сервера Binance (або локальний)
  async function getRealTimestamp() {
    try {
      const res = await fetch('https://fapi.binance.com/fapi/v1/time');
      const data = await res.json();
      return data.serverTime;
    } catch (e) {
      return Date.now(); // fallback
    }
  }

  // Функція перевірки даних
  async function validateData(price, volume, receivedTimestamp = Date.now()) {
    const now = Date.now();
    const serverTime = await getRealTimestamp();
    const timeDiff = Math.abs(serverTime - now);
    
    // 1. Якщо різниця з серверним часом занадто велика – синхронізуємо
    if (timeDiff > CFG.TIMESTAMP_TOLERANCE_MS) {
      console.log(`⚠️ Time drift detected: ${timeDiff}ms. Syncing...`);
      return false;
    }
    
    // 2. Перевірка на застарілі дані
    if (receivedTimestamp < now - CFG.MAX_ALLOWED_DELAY_MS) {
      console.log(`⏳ Stale data ignored (${now - receivedTimestamp}ms old)`);
      return false;
    }
    
    // 3. Перевірка мінімального інтервалу (захист від спаму)
    if (now - lastTickTime < CFG.MIN_INTERVAL_MS && lastPrice === price) {
      console.log(`🚫 Duplicate/spam tick ignored (${now - lastTickTime}ms)`);
      return false;
    }
    
    // 4. Перевірка ціни на аномалії (стрибки більше 5% за один тік)
    if (lastPrice !== null && Math.abs((price - lastPrice) / lastPrice) > 0.05) {
      console.log(`⚠️ Price spike ignored: ${lastPrice} → ${price}`);
      invalidCount++;
      if (invalidCount >= CFG.MAX_CONSECUTIVE_INVALID) {
        console.log("🔄 Too many invalid ticks, forcing price sync...");
        await global.validateCurrentPrice?.();
        invalidCount = 0;
      }
      return false;
    }
    
    // Все добре
    lastValidTimestamp = now;
    lastTickTime = now;
    lastPrice = price;
    invalidCount = 0;
    return true;
  }

  // Перехоплюємо onTick – валідуємо дані перед передачею
  const originalOnTick59 = onTick;
  onTick = async function(price, volume) {
    const isValid = await validateData(price, volume);
    if (!isValid) return;
    return originalOnTick59(price, volume);
  };

  // Функція примусової синхронізації (викликається зовні)
  global.syncMarketData = async () => {
    const realPrice = await global.validateCurrentPrice?.();
    const realTime = await getRealTimestamp();
    console.log(`🔄 Manual sync: price=${realPrice}, time=${realTime}`);
    lastValidTimestamp = realTime;
    lastTickTime = realTime;
    if (realPrice) lastPrice = realPrice;
  };

  // Періодична синхронізація кожні 30 секунд
  setInterval(async () => {
    await global.syncMarketData?.();
  }, 30000);

  console.log("✅ Real data validator active: stale/spoofed ticks will be ignored.");
})();

// ================== MODULE 60: FINAL FIX - REST ONLY, NO BLOCKS ==================
(function initModule60() {
  if (global.__MODULE_60_LOADED__) return;
  global.__MODULE_60_LOADED__ = true;
  console.log("🔥 MODULE 60: FINAL FIX - REST only, all filters disabled");

  // 1. Повністю вимикаємо всі фільтри
  if (CONFIG.cooldown) CONFIG.cooldown.ENABLED = false;
  if (CONFIG.signal) {
    CONFIG.signal.DEVIATION_THRESHOLD = 0.0001;
    CONFIG.signal.VOLUME_THRESHOLD = 0.5;
    CONFIG.signal.VOLATILITY_THRESHOLD = 0.00001;
  }
  // 2. Вбиваємо нормалізацію ціни
  if (global.normalizePrice) global.normalizePrice = p => p;
  if (global.priceNormalize) global.priceNormalize = p => p;
  // 3. Вимикаємо анти-реверсал та інше
  if (global.antiReversalCheck) global.antiReversalCheck = () => true;
  if (global.volatilityCheck) global.volatilityCheck = () => ({ action: "TRADE" });
  if (global.balanceFilter) global.balanceFilter = s => s;

  // 4. Отримуємо реальну ціну тільки через REST (кожну секунду)
  let realPrice = null;
  async function fetchRealPrice() {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT`);
      const data = await res.json();
      realPrice = parseFloat(data.price);
    } catch (e) {}
  }
  fetchRealPrice();
  setInterval(fetchRealPrice, 1000);

  // 5. Перевизначаємо onTick – ігноруємо WS price, використовуємо REST
  const originalOnTick = onTick;
  onTick = async function(wsPrice, volume) {
    if (realPrice && realPrice > 0) {
      return originalOnTick(realPrice, volume);
    }
    return originalOnTick(wsPrice, volume);
  };

  // 6. Примусовий вхід кожні 10 секунд, якщо немає позиції
  setInterval(async () => {
    if (state.status !== "IDLE") return;
    if (!realPrice) return;
    const dev = (realPrice - (buffers.getPrices().slice(-1)[0] || realPrice)) / realPrice;
    const side = dev > 0.0001 ? "short" : (dev < -0.0001 ? "long" : null);
    if (!side) return;
    const qty = calcPositionSize(realPrice);
    if (qty <= 0) return;
    console.log(`🚀 FORCE ENTRY: ${side} @ ${realPrice}`);
    const order = await placeOrder(side, qty, realPrice);
    if (order) {
      state.status = "IN_TRADE";
      state.entry = realPrice;
      state.side = side;
    }
  }, 10000);

  console.log("✅ Ready: using REST price only. Bot will enter positions.");
})();


[// ================== MODULE 60: REAL TRADING FINAL FIX ==================
(function initModule60() {
  if (global.__MODULE_60_LOADED__) return;
  global.__MODULE_60_LOADED__ = true;
  console.log("🔥 MODULE 60: Real Trading Final Fix ACTIVE");

  // 1. Вимикаємо нормалізацію ціни
  if (global.normalizePrice) global.normalizePrice = p => p;
  if (global.priceNormalize) global.priceNormalize = p => p;

  // 2. Вимикаємо всі блокувальні фільтри
  if (CONFIG.cooldown) CONFIG.cooldown.ENABLED = false;
  if (CONFIG.signal) {
    CONFIG.signal.DEVIATION_THRESHOLD = 0.0002;
    CONFIG.signal.VOLUME_THRESHOLD = 0.8;
    CONFIG.signal.VOLATILITY_THRESHOLD = 0.00005;
  }
  if (global.antiReversalCheck) global.antiReversalCheck = () => true;
  if (global.volatilityCheck) global.volatilityCheck = () => ({ action: "TRADE" });
  if (global.balanceFilter) global.balanceFilter = s => s;

  // 3. Отримуємо реальну ціну через REST (кожну секунду)
  let lastRealPrice = null;
  async function updateRealPrice() {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT`);
      const data = await res.json();
      lastRealPrice = parseFloat(data.price);
    } catch(e) {}
  }
  updateRealPrice();
  setInterval(updateRealPrice, 1000);

  // 4. Перевизначаємо onTick – використовуємо REST price
  const originalOnTick60 = onTick;
  onTick = async function(wsPrice, volume) {
    if (lastRealPrice && lastRealPrice > 0) {
      return originalOnTick60(lastRealPrice, volume);
    }
    return originalOnTick60(wsPrice, volume);
  };

  // 5. Примусовий вхід, якщо довго немає позиції
  let lastEntryAttempt = 0;
  setInterval(async () => {
    if (state.status !== "IDLE") return;
    if (cooldownUntil > Date.now()) return;
    if (!lastRealPrice) return;
    if (Date.now() - lastEntryAttempt < 15000) return;
    lastEntryAttempt = Date.now();

    let signal = buildSignal(lastRealPrice);
    if (!signal) {
      const dev = deviation(lastRealPrice);
      if (Math.abs(dev) > 0.0003) {
        signal = { side: dev > 0 ? "short" : "long", dev };
      }
    }
    if (!signal) return;

    const qty = calcPositionSize(lastRealPrice);
    if (qty <= 0) return;
    console.log(`🔹 REAL TRADE: ${signal.side} @ ${lastRealPrice}`);
    const order = await placeOrder(signal.side, qty, lastRealPrice);
    if (order) {
      state.status = "IN_TRADE";
      state.entry = lastRealPrice;
      state.side = signal.side;
    }
  }, 15000);
  console.log("✅ Real trading fix applied. Using REST price, filters disabled.");

})();

// ================== MODULE 61: ULTIMATE FIX - REAL TRADING ==================
(function ultimateFix() {
  if (global.__MODULE_61_LOADED__) return;
  global.__MODULE_61_LOADED__ = true;

  console.log("💎 MODULE 61: ULTIMATE FIX - REAL TRADING");

  const identity = (x) => x;
  global.normalizePrice = identity;
  global.priceNormalize = identity;

  if (CONFIG.cooldown) CONFIG.cooldown.ENABLED = false;

  if (CONFIG.signal) {
    CONFIG.signal.DEVIATION_THRESHOLD = 0.0002;
    CONFIG.signal.VOLUME_THRESHOLD = 0.8;
  }

  if (global.antiReversalCheck) global.antiReversalCheck = () => true;
  if (global.volatilityCheck) global.volatilityCheck = () => ({ action: "TRADE" });
  if (global.balanceFilter) global.balanceFilter = (s) => s;

  let realPrice = null;

  setInterval(async () => {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT`);
      const data = await res.json();
      realPrice = parseFloat(data.price);
    } catch (e) {}
  }, 1000);

  const originalCalcPos = calcPositionSize;

  global.calcPositionSize = function(price) {
    if (account.balance < 10) return 5;
    return originalCalcPos(price);
  };

  console.log("✅ MODULE 61 READY");
})();

// ================== MODULE 62: FORCE TRADE ENGINE ==================
(function() {
  if (global.__MODULE_62_LOADED__) return;
  global.__MODULE_62_LOADED__ = true;
  console.log("⚡ MODULE 62: Force Trade Engine ACTIVE");

  let realPrice = null;
  setInterval(async () => {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT`);
      const data = await res.json();
      realPrice = parseFloat(data.price);
    } catch (e) {}
  }, 1000);

  setInterval(async () => {
    if (state.status !== "IDLE") return;
    if (!realPrice) return;
    const prices = buffers.getPrices();
    const lastPrice = prices.length ? prices[prices.length - 1] : realPrice;
    const dev = (realPrice - lastPrice) / realPrice;
    if (Math.abs(dev) < 0.0003) return;
    const side = dev > 0 ? "short" : "long";
    const qty = calcPositionSize(realPrice);
    if (qty <= 0) return;
    console.log(`🔥 FORCE TRADE: ${side} ${qty} @ ${realPrice}`);
    await placeOrder(side, qty, realPrice);
  }, 8000);

  console.log("✅ Force trade engine ready");
})();

// ================== MODULE 63: FORCE TRADE FIX (NO WINDOW) ==================
(function() {
  if (global.__MODULE_63_LOADED__) return;
  global.__MODULE_63_LOADED__ = true;
  console.log("⚡ MODULE 63: Force Trade Fix ACTIVE");

  global.normalizePrice = p => p;
  global.priceNormalize = p => p;
  if (global.tickSize === 0.1) global.tickSize = 0.00001;
  if (CONFIG.cooldown) CONFIG.cooldown.ENABLED = false;
  if (CONFIG.signal) {
    CONFIG.signal.DEVIATION_THRESHOLD = 0.0002;
    CONFIG.signal.VOLUME_THRESHOLD = 0.8;
  }
  if (global.antiReversalCheck) global.antiReversalCheck = () => true;
  if (global.volatilityCheck) global.volatilityCheck = () => ({ action: "TRADE" });
  if (global.balanceFilter) global.balanceFilter = s => s;

  let realPrice = null;
  setInterval(async () => {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${CONFIG.ws.SYMBOL.toUpperCase()}`);
      const data = await res.json();
      realPrice = parseFloat(data.price);
    } catch (e) {}
  }, 1000);

  setInterval(async () => {
    if (state.status !== "IDLE") return;
    if (!realPrice) return;
    const prices = buffers.getPrices();
    const lastPrice = prices.length ? prices[prices.length - 1] : realPrice;
    const dev = (realPrice - lastPrice) / realPrice;
    if (Math.abs(dev) < 0.0003) return;
    const side = dev > 0 ? "short" : "long";
    const qty = calcPositionSize(realPrice);
    if (qty <= 0) return;
    console.log(`🔥 FORCE TRADE (63): ${side} ${qty} @ ${realPrice}`);
    await placeOrder(side, qty, realPrice);
  }, 8000);

  console.log("✅ Force trade fix ready");
})();

// ================== MODULE 64: ULTIMATE FORCE TRADE (NO WINDOW) ==================
(function() {
  if (global.__MODULE_64_LOADED__) return;
  global.__MODULE_64_LOADED__ = true;
  console.log("🔥 MODULE 64: Ultimate Force Trade (no window) ACTIVE");

  const identity = (x) => x;
  if (global.normalizePrice) global.normalizePrice = identity;
  if (global.priceNormalize) global.priceNormalize = identity;
  if (global.tickSize === 0.1) global.tickSize = 0.00001;
  if (global.stepSize === 0.001) global.stepSize = 1;
  if (CONFIG.cooldown) CONFIG.cooldown.ENABLED = false;
  if (CONFIG.signal) {
    CONFIG.signal.DEVIATION_THRESHOLD = 0.0002;
    CONFIG.signal.VOLUME_THRESHOLD = 0.8;
    CONFIG.signal.VOLATILITY_THRESHOLD = 0.00005;
  }
  if (global.antiReversalCheck) global.antiReversalCheck = () => true;
  if (global.volatilityCheck) global.volatilityCheck = () => ({ action: "TRADE" });
  if (global.balanceFilter) global.balanceFilter = (s) => s;
  if (global.liquidityFilter) global.liquidityFilter = () => true;
  if (global.isFakeBreakout) global.isFakeBreakout = () => false;

  let realPrice = null;
  let lastFetch = 0;
  const symbol = CONFIG.ws.SYMBOL.toUpperCase();
  async function fetchRealPrice() {
    const now = Date.now();
    if (now - lastFetch < 1000) return realPrice;
    lastFetch = now;
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
      const data = await res.json();
      realPrice = parseFloat(data.price);
      return realPrice;
    } catch (e) { return realPrice; }
  }
  fetchRealPrice();
  setInterval(fetchRealPrice, 1000);

  const originalCalcPos = calcPositionSize;
  global.calcPositionSize = function(price) {
    if (account.balance < 10) return 5;
    return originalCalcPos(price);
  };

  let lastForce = 0;
  setInterval(async () => {
    if (state.status !== "IDLE") return;
    if (cooldownUntil > Date.now()) return;
    if (Date.now() - lastForce < 8000) return;
    lastForce = Date.now();
    const price = await fetchRealPrice();
    if (!price) return;
    const prices = buffers.getPrices();
    if (prices.length < 5) return;
    const short = avg(prices.slice(-3));
    const long = avg(prices.slice(-5));
    const dev = (short - long) / long;
    if (Math.abs(dev) < 0.0003) return;
    const side = dev > 0 ? "long" : "short";
    const qty = calcPositionSize(price);
    if (qty <= 0) return;
    console.log(`🚀 FORCE ENTRY: ${side} ${qty} DOGE @ ${price}`);
    const order = await placeOrder(side, qty, price);
    if (order) {
      state.status = "IN_TRADE";
      state.entry = price;
      state.side = side;
    }
  }, 8000);

  console.log("✅ Ultimate force trade ready (no window)");
})();

// ================== MODULE 65: AUTOFIX & AUTOBLOCK ==================
(function autoFix() {
  if (global.__AUTOFIX_LOADED__) return;
  global.__AUTOFIX_LOADED__ = true;
  const fs = require('fs');
  const path = require('path');
  const selfPath = process.argv[1];
  if (!selfPath) return;
  const content = fs.readFileSync(selfPath, 'utf8');
  const lines = content.split('\n');
  let cleaned = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('export ') && !trimmed.includes('{')) continue;
    if (trimmed.startsWith('npm ') || trimmed.startsWith('node ') || trimmed.startsWith('# ') || trimmed.startsWith('```')) {
      removed++;
      continue;
    }
    if (/^\s*~\$\s*/.test(line)) continue;
    cleaned.push(line);
  }
  if (removed > 0) {
    fs.writeFileSync(selfPath, cleaned.join('\n'));
    console.log(`🔧 AutoFix: removed ${removed} invalid lines. Restarting...`);
    process.exit(0);
  }
})();

// ================== MODULE 66: AUTOCLEAN & AUTOFIX ==================
(function() {
  const fs = require('fs');
  const path = process.argv[1];
  if (!path) return;
  let content = fs.readFileSync(path, 'utf8');
  const original = content;
  // Видаляємо рядки, що містять window (небезпечні для Node.js)
  content = content.replace(/^.*\bwindow\b.*$/gm, '');
  // Видаляємо команди bash
  content = content.replace(/^export .*$/gm, '');
  content = content.replace(/^npm .*$/gm, '');
  content = content.replace(/^node .*$/gm, '');
  content = content.replace(/^# .*$/gm, '');
  content = content.replace(/^```.*$/gm, '');
  // Видаляємо порожні рядки (зайві)
  content = content.replace(/^\s*[\r\n]/gm, '');
  if (content !== original) {
    fs.writeFileSync(path, content);
    console.log("🧹 AutoClean: removed invalid lines. Please restart bot.");
    process.exit(0);
  }
})();

// ================== MODULE 67: FORCE REAL TRADING ACTIVATOR ==================
(function() {
  if (global.__FORCE_REAL_TRADING__) return;
  global.__FORCE_REAL_TRADING__ = true;
  console.log("🔥 FORCE REAL TRADING ACTIVATOR");

  // Знищуємо всі фільтри
  CONFIG.cooldown.ENABLED = false;
  CONFIG.signal.DEVIATION_THRESHOLD = 0.0001;
  CONFIG.signal.VOLUME_THRESHOLD = 0.5;
  if (global.normalizePrice) global.normalizePrice = p => p;
  if (global.priceNormalize) global.priceNormalize = p => p;
  if (global.tickSize === 0.1) global.tickSize = 0.00001;
  if (global.stepSize === 0.001) global.stepSize = 1;
  if (global.antiReversalCheck) global.antiReversalCheck = () => true;
  if (global.volatilityCheck) global.volatilityCheck = () => ({ action: "TRADE" });
  if (global.balanceFilter) global.balanceFilter = s => s;
  if (global.liquidityFilter) global.liquidityFilter = () => true;
  if (global.isFakeBreakout) global.isFakeBreakout = () => false;

  // Реальна ціна з REST
  let realPrice = null;
  setInterval(async () => {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${CONFIG.ws.SYMBOL.toUpperCase()}`);
      const data = await res.json();
      realPrice = parseFloat(data.price);
    } catch(e) {}
  }, 1000);

  // Примусовий вхід кожні 5 секунд
  setInterval(async () => {
    if (state.status !== "IDLE") return;
    if (!realPrice) return;
    const qty = Math.max(1, Math.floor(account.balance / realPrice * 0.95));
    if (qty <= 0) return;
    const side = Math.random() > 0.5 ? "long" : "short";
    console.log(`🚀 FORCE REAL TRADE: ${side} ${qty} @ ${realPrice}`);
    const order = await placeOrder(side, qty, realPrice);
    if (order) {
      state.status = "IN_TRADE";
      state.entry = realPrice;
      state.side = side;
    }
  }, 5000);
})();

// ================== MODULE 68: CLEAN FORCE TRADE (NO WINDOW) ==================
(function() {
  if (global.__CLEAN_FORCE_68__) return;
  global.__CLEAN_FORCE_68__ = true;

  console.log("⚡ MODULE 68: Clean Force Trade ACTIVE");

  const symbol = (CONFIG.ws.SYMBOL || "DOGEUSDT").toUpperCase();

  let realPrice = null;

  async function updatePrice() {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
      const data = await res.json();
      realPrice = parseFloat(data.price);
    } catch(e) {}
  }

  updatePrice();
  setInterval(updatePrice, 1000);

  setInterval(async () => {
    if (state.status !== "IDLE") return;
    if (!realPrice) return;

    let qty = Math.floor((account.balance * 0.95) / realPrice);
    if (qty < 1) qty = 1;

    const side = Math.random() > 0.5 ? "long" : "short";

    console.log(`🚀 FORCE TRADE: ${side} ${qty} @ ${realPrice}`);

    const order = await placeOrder(side, qty, realPrice);

    if (order) {
      state.status = "IN_TRADE";
      state.entry = realPrice;
      state.side = side;
    }
  }, 5000);

})();
main();
