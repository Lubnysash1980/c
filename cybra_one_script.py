#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════╗
║  CYBRA LIVE TRADER – 1 файл (WebSocket + REST Bybit)           ║
║  Momentum + AI | Динамічний SL/TP | Живий режим                 ║
╚══════════════════════════════════════════════════════════════════╝
"""

import json
import time
import hmac
import hashlib
import requests
import websocket
import threading
from collections import deque

print("🚀 CYBRA REAL BYBIT LIVE TRADER (WebSocket + REST)")

# ===============================
# 1. ВВЕДЕННЯ КЛЮЧІВ
# ===============================
API_KEY = input("🔑 API KEY: ").strip()
API_SECRET = input("🔐 API SECRET: ").strip()
LIVE_MODE = input("⚡ LIVE MODE (yes/no): ").strip().lower() == "yes"

if LIVE_MODE and (not API_KEY or not API_SECRET):
    print("❌ Для живого режиму потрібні API KEY та SECRET")
    exit()

# ===============================
# 2. КОНФІГУРАЦІЯ
# ===============================
SYMBOL = "DOGEUSDT"
TRADE_PERCENT = 90
STOP_LOSS_PERCENT = -3.0
TAKE_PROFIT_PERCENT = 5.0
VOLATILITY_WINDOW = 20

in_position = False
entry_price = 0.0
position_qty = 0.0
price_history = deque(maxlen=VOLATILITY_WINDOW)

# ===============================
# 3. REST API BYBIT
# ===============================
class BybitRest:
    def __init__(self, api_key, api_secret):
        self.api_key = api_key
        self.api_secret = api_secret
        self.base_url = "https://api.bybit.com"
        self.recv_window = 5000

    def _sign(self, params):
        query = '&'.join([f"{k}={v}" for k, v in sorted(params.items())])
        return hmac.new(self.api_secret.encode(), query.encode(), hashlib.sha256).hexdigest()

    def _request(self, method, endpoint, params=None):
        timestamp = int(time.time() * 1000)
        if params is None:
            params = {}
        params["api_key"] = self.api_key
        params["timestamp"] = timestamp
        params["recv_window"] = self.recv_window
        params["sign"] = self._sign(params)

        url = f"{self.base_url}{endpoint}"
        try:
            if method == "GET":
                resp = requests.get(url, params=params, timeout=10)
            else:
                resp = requests.post(url, params=params, timeout=10)
            data = resp.json()
            if data.get("retCode") == 0:
                return data.get("result")
            else:
                print(f"❌ API помилка {data.get('retCode')}: {data.get('retMsg')}")
                return None
        except Exception as e:
            print(f"❌ Помилка запиту: {e}")
            return None

    def get_balance(self):
        result = self._request("GET", "/v5/account/wallet-balance", {"accountType": "UNIFIED"})
        if result:
            for coin in result.get("list", [{}])[0].get("coin", []):
                if coin["coin"] == "USDT":
                    return float(coin["walletBalance"])
        return 0.0

    def market_buy(self, symbol, usdt_amount):
        ticker = self._request("GET", "/v5/market/tickers", {"category": "spot", "symbol": symbol})
        if not ticker or not ticker.get("list"):
            return None
        price = float(ticker["list"][0]["lastPrice"])
        qty = usdt_amount / price
        qty = round(qty, 6)
        order_params = {
            "category": "spot",
            "symbol": symbol,
            "side": "Buy",
            "orderType": "Market",
            "qty": str(qty),
            "timeInForce": "IOC"
        }
        result = self._request("POST", "/v5/order/create", order_params)
        return result, price, qty

    def market_sell(self, symbol, qty):
        order_params = {
            "category": "spot",
            "symbol": symbol,
            "side": "Sell",
            "orderType": "Market",
            "qty": str(qty),
            "timeInForce": "IOC"
        }
        return self._request("POST", "/v5/order/create", order_params)

rest = BybitRest(API_KEY, API_SECRET) if LIVE_MODE else None

# ===============================
# 4. ДИНАМІЧНИЙ SL/TP
# ===============================
def calculate_dynamic_sl_tp(price_list, entry_price):
    if len(price_list) < 5:
        return STOP_LOSS_PERCENT, TAKE_PROFIT_PERCENT
    diffs = [abs((p - entry_price) / entry_price) * 100 for p in price_list]
    volatility = sum(diffs) / len(diffs)
    sl = max(-8.0, STOP_LOSS_PERCENT - volatility * 0.5)
    tp = min(12.0, TAKE_PROFIT_PERCENT + volatility * 0.5)
    return round(sl, 2), round(tp, 2)

# ===============================
# 5. MOMENTUM ТА AI
# ===============================
class Momentum:
    def __init__(self):
        self.last_price = None

    def calc(self, price):
        if self.last_price is None:
            self.last_price = price
            return "HOLD"
        diff_pct = (price - self.last_price) / self.last_price * 100
        self.last_price = price
        if diff_pct > 0.3:
            return "BUY"
        if diff_pct < -0.3:
            return "SELL"
        return "HOLD"

class AI:
    def vote(self, price):
        a = "BUY" if price % 2 == 0 else "SELL"
        b = "SELL" if price % 3 == 0 else "HOLD"
        c = "BUY" if price % 5 == 0 else "HOLD"
        votes = [a, b, c]
        buy_cnt = votes.count("BUY")
        sell_cnt = votes.count("SELL")
        if buy_cnt > sell_cnt:
            return "BUY"
        if sell_cnt > buy_cnt:
            return "SELL"
        return "HOLD"

# ===============================
# 6. WEBSOCKET (РЕАЛЬНИЙ ПОТІК ЦІН)
# ===============================
class BybitWS:
    def __init__(self, symbol):
        self.symbol = symbol
        self.price = None
        self.ws = None

    def on_message(self, ws, message):
        global in_position, entry_price, position_qty, price_history
        try:
            data = json.loads(message)
            if "data" in data and isinstance(data["data"], list):
                tick = data["data"][0]
                self.price = float(tick["lastPrice"])
                price_history.append(self.price)
                print(f"📡 LIVE PRICE: {self.price}")

                if in_position and LIVE_MODE and rest:
                    current = self.price
                    pnl_pct = (current - entry_price) / entry_price * 100
                    sl, tp = calculate_dynamic_sl_tp(list(price_history), entry_price)
                    if pnl_pct <= sl:
                        print(f"🛡️ СТОП-ЛОСС! Продаж за {current:.6f} (збиток {pnl_pct:.2f}%)")
                        rest.market_sell(SYMBOL, position_qty)
                        in_position = False
                        entry_price = 0.0
                        position_qty = 0.0
                    elif pnl_pct >= tp:
                        print(f"🎯 ТЕЙК-ПРОФІТ! Продаж за {current:.6f} (прибуток +{pnl_pct:.2f}%)")
                        rest.market_sell(SYMBOL, position_qty)
                        in_position = False
                        entry_price = 0.0
                        position_qty = 0.0
        except Exception as e:
            print(f"⚠ Парсинг помилка: {e}")

    def on_open(self, ws):
        print("🚀 BYBIT WS CONNECTED")
        sub = {"op": "subscribe", "args": [f"tickers.{self.symbol}"]}
        ws.send(json.dumps(sub))

    def on_error(self, ws, error):
        print(f"⚠ WS ERROR: {error}")

    def on_close(self, ws, a, b):
        print("🔁 WS CLOSED → RECONNECTING...")
        self.connect()

    def connect(self):
        url = "wss://stream.bybit.com/v5/public/spot"
        self.ws = websocket.WebSocketApp(
            url,
            on_open=self.on_open,
            on_message=self.on_message,
            on_error=self.on_error,
            on_close=self.on_close
        )
        t = threading.Thread(target=self.ws.run_forever)
        t.daemon = True
        t.start()

    def get_price(self):
        return self.price

# ===============================
# 7. ГОЛОВНА ЛОГІКА ТОРГІВЛІ (У ПОТОЦІ)
# ===============================
def trading_loop(ws, momentum, ai):
    global in_position, entry_price, position_qty, price_history

    while True:
        price = ws.get_price()
        if price is None:
            time.sleep(0.5)
            continue

        price_history.append(price)

        sig_mom = momentum.calc(price)
        sig_ai = ai.vote(price)
        print(f"\n📊 PRICE: {price:.6f}")
        print(f"🧠 MOMENTUM: {sig_mom}")
        print(f"🧠 AI: {sig_ai}")

        if sig_mom == sig_ai and sig_mom != "HOLD" and not in_position:
            if LIVE_MODE and rest:
                balance = rest.get_balance()
                if balance < 10:
                    print("⚠️ Недостатньо коштів (менше 10 USDT)")
                else:
                    trade_amount = balance * TRADE_PERCENT / 100
                    print(f"💰 Купівля {SYMBOL} на {trade_amount:.2f} USDT...")
                    order, exec_price, qty = rest.market_buy(SYMBOL, trade_amount)
                    if order:
                        print(f"✅ ПОЗИЦІЮ ВІДКРИТО за {exec_price:.6f}")
                        in_position = True
                        entry_price = exec_price
                        position_qty = qty
                    else:
                        print("❌ Не вдалося відкрити позицію")
            else:
                print(f"🔥 СИГНАЛ (DEMO): {sig_mom}, але реальна торгівля вимкнена")
        elif in_position:
            pnl_pct = (price - entry_price) / entry_price * 100
            print(f"📈 ВІДКРИТА ПОЗИЦІЯ: P&L {pnl_pct:+.2f}%")
        else:
            print("⚖ HOLD (нема сигналу)")

        time.sleep(1)

# ===============================
# 8. ЗАПУСК
# ===============================
if __name__ == "__main__":
    ws = BybitWS(SYMBOL)
    ws.connect()
    momentum = Momentum()
    ai = AI()

    trade_thread = threading.Thread(target=trading_loop, args=(ws, momentum, ai))
    trade_thread.daemon = True
    trade_thread.start()

    while True:
        time.sleep(1)
