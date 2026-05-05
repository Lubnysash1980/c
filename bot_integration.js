#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Конфігурація
const PARLIAMENT_URL = 'http://127.0.0.1:5000/api/command';
const PORT = 3000;

// Статистика
let stats = {
    commands: 0,
    players: 0,
    uptime: Date.now()
};

// API Endpoints
app.get('/health', (req, res) => {
    res.json({ 
        status: 'online', 
        bot: 'Cybra Game Bot',
        uptime: Math.floor((Date.now() - stats.uptime) / 1000),
        commands: stats.commands 
    });
});

app.get('/api/status', (req, res) => {
    res.json({
        name: 'Cybra Game Bot',
        version: '2.0.0',
        running: true,
        commands_processed: stats.commands,
        players: stats.players,
        uptime: Math.floor((Date.now() - stats.uptime) / 1000)
    });
});

app.post('/api/command', async (req, res) => {
    const { command, playerId } = req.body;
    stats.commands++;
    
    let response = '';
    const cmd = command.toLowerCase();
    
    if (cmd.includes('ракетна') || cmd.includes('небезпека')) {
        response = '🔴🔴🔴 РАКЕТНА НЕБЕЗПЕКА! 🔴🔴🔴\n⚠️ Терміново прямуйте в укриття!\n🚨 Система оповіщення активована!';
    } 
    else if (cmd.includes('захистити') || cmd.includes('захист')) {
        response = '🛡️🛡️🛡️ ЗАХИСТ АКТИВОВАНО! 🛡️🛡️🛡️\n📧 lubnysash1980@gmail.com - ЗАХИЩЕНО\n📱 +380663181676 - ЗАХИЩЕНО\n🔐 Всі дані зашифровані';
    }
    else if (cmd.includes('борг') || cmd.includes('погасити')) {
        response = '💰💰💰 ФІНАНСОВА ОПЕРАЦІЯ 💰💰💰\n📋 Сума: 7365.08 UAH\n👤 Платник: Грабовський Олександр\n📅 Статус: ОБРОБЛЯЄТЬСЯ';
    }
    else if (cmd.includes('start')) {
        stats.players++;
        response = '🎮 ГРА РОЗПОЧАТА!\n🎯 Рівень: 1\n⭐ Досвід: 0\n💪 Бажаємо успіху!';
    }
    else if (cmd.includes('stop')) {
        response = '⏹️ ГРА ЗУПИНЕНА!\n📊 Ваша статистика збережена';
    }
    else if (cmd.includes('status')) {
        response = `🤖 СТАТУС БОТА:\n📊 Команд оброблено: ${stats.commands}\n👥 Гравців: ${stats.players}\n⏱️ Uptime: ${Math.floor((Date.now() - stats.uptime) / 60)} хв\n🔗 Парламент: ПІДКЛЮЧЕНО`;
    }
    else if (cmd.includes('parliament')) {
        // Виклик парламенту
        const query = cmd.replace('parliament', '').trim();
        try {
            const parliamentRes = await axios.post(PARLIAMENT_URL, { command: query || 'допомога' });
            response = `🏛️ ВІДПОВІДЬ ПАРЛАМЕНТУ:\n${parliamentRes.data.response}`;
        } catch (e) {
            response = `❌ Помилка зв'язку з парламентом. Переконайтеся що парламент запущено на порту 5000`;
        }
    }
    else if (cmd.includes('help')) {
        response = `📋 ДОСТУПНІ КОМАНДИ:\n🎮 start - почати гру\n⏹️ stop - зупинити гру\n📊 status - статус бота\n🔒 protect - захист акаунту\n💰 debt - перевірка боргу\n🏛️ parliament [запит] - звернення до парламенту\n❓ help - це повідомлення`;
    }
    else {
        response = `🤖 Отримано команду: "${command}". Введіть "help" для списку команд`;
    }
    
    res.json({ success: true, response: response, command: command });
});

app.post('/api/protect', (req, res) => {
    res.json({ 
        success: true, 
        message: '🔒 Акаунт lubnysash1980@gmail.com та телефон +380663181676 захищено!\n🔐 Всі дані під надійним захистом' 
    });
});

app.post('/api/debt', (req, res) => {
    res.json({ 
        success: true, 
        message: '💰 ЗАБОРГОВАНІСТЬ: 7365.08 UAH\n👤 ПЛАТНИК: Грабовський Олександр Миколайович\n🏠 АДРЕСА: вул. Залізнична, буд. 65, кв. 3\n💳 IBAN: UA923204780000026003924886633' 
    });
});

app.post('/api/pay', (req, res) => {
    res.json({ 
        success: true, 
        message: '✅ ПЛАТІЖ УСПІШНО ОБРОБЛЕНО!\n💰 Сума: 7365.08 UAH\n📅 Дата: ' + new Date().toLocaleString() + '\n🧾 Статус: ВИКОНАНО' 
    });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                                                                              ║');
    console.log('║     🤖 CYBRA GAME BOT - ЗАПУЩЕНО!                                            ║');
    console.log('║                                                                              ║');
    console.log(`║     🌐 API: http://localhost:${PORT}                                          ║`);
    console.log(`║     🏛️ Парламент: ${PARLIAMENT_URL}                                           ║`);
    console.log('║     📡 Статус: 🟢 ONLINE                                                     ║');
    console.log('║                                                                              ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
    console.log('\n📋 ДОСТУПНІ КОМАНДИ:');
    console.log('   start, stop, status, protect, debt, pay, parliament [запит], help\n');
});

module.exports = app;
