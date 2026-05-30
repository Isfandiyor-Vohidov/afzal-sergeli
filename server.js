const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_STORE = path.join(__dirname, 'admin.json');
const PENDING_STORE = path.join(__dirname, 'pending.json');

if (!BOT_TOKEN) {
    console.error('BOT_TOKEN is required. Set it in .env or the environment.');
    process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

function loadJson(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (err) {
        console.warn(`Unable to load ${filePath}:`, err.message);
    }
    return defaultValue;
}

function saveJson(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error(`Unable to save ${filePath}:`, err.message);
    }
}

let adminChatId = loadJson(ADMIN_STORE, { chatId: null }).chatId;
let pendingReservations = loadJson(PENDING_STORE, []);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function persistAdminChatId(chatId) {
    adminChatId = chatId;
    saveJson(ADMIN_STORE, { chatId });
}

function persistPendingReservations() {
    saveJson(PENDING_STORE, pendingReservations);
}

function normalizePhone(phone) {
    return String(phone || '').replace(/[^0-9]/g, '');
}

function isPhoneValid(phone) {
    const normalized = normalizePhone(phone);
    if (normalized.startsWith('998') && normalized.length === 12) {
        return /^[0-9]{12}$/.test(normalized);
    }
    if (normalized.length === 9) {
        return /^[0-9]{9}$/.test(normalized);
    }
    return false;
}

function isDateValid(dateValue) {
    const timestamp = Date.parse(dateValue);
    if (Number.isNaN(timestamp)) return false;

    const selected = new Date(timestamp);
    selected.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return selected >= today;
}

function isTimeValid(timeValue) {
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(timeValue)) return false;
    const [hour] = timeValue.split(':').map(Number);
    return hour >= 10 && hour <= 23;
}

function isGuestsValid(guests) {
    const value = String(guests || '').trim();
    if (!value) return false;
    if (value === '5+') return true;
    return /^[1-9]$/.test(value) || /^[1][0-9]$/.test(value);
}

function formatReservation(reservation) {
    return [
        '🆕 Новое бронирование!',
        `👤 Имя: ${reservation.name}`,
        `📞 Телефон: ${reservation.phone}`,
        `📅 Дата: ${reservation.date}`,
        `⏰ Время: ${reservation.time}`,
        `👥 Гостей: ${reservation.guests || '—'}`,
        `💬 Комментарий: ${reservation.comment || '—'}`
    ].join('\n');
}

async function sendTelegramMessage(message) {
    if (!adminChatId) return false;
    try {
        await bot.sendMessage(adminChatId, message);
        return true;
    } catch (err) {
        console.error('Telegram request failed:', err.message);
        return false;
    }
}

async function flushPendingReservations() {
    if (!adminChatId || pendingReservations.length === 0) return;
    const queue = [...pendingReservations];
    pendingReservations = [];
    persistPendingReservations();

    for (const reservation of queue) {
        await sendTelegramMessage(formatReservation(reservation));
    }
}

bot.onText(/\/start/, async (msg) => {
    persistAdminChatId(msg.chat.id);
    await bot.sendMessage(adminChatId, 'Администратор зарегистрирован. Новые бронирования будут приходить сюда.');

    if (pendingReservations.length > 0) {
        await bot.sendMessage(adminChatId, `В очереди ${pendingReservations.length} отложенное(ых) бронирование(ий). Отправляю их сейчас.`);
        await flushPendingReservations();
    }
});

bot.on('polling_error', console.error);

app.post('/api/reserve', async (req, res) => {
    const { name, phone, date, time, guests = '1', comment = '' } = req.body;
    const errors = [];

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
        errors.push('Имя должно содержать минимум 2 символа.');
    }
    if (!phone || !isPhoneValid(phone)) {
        errors.push('Укажите корректный телефон.');
    }
    if (!date || !isDateValid(date)) {
        errors.push('Дата должна быть сегодня или позже.');
    }
    if (!time || !isTimeValid(time)) {
        errors.push('Время должно быть в формате HH:MM в диапазоне 10:00–23:00.');
    }
    if (!isGuestsValid(guests)) {
        errors.push('Выберите количество гостей (1–5+).');
    }
    if (typeof comment !== 'string' || comment.trim().length > 250) {
        errors.push('Комментарий не должен превышать 250 символов.');
    }

    if (errors.length) {
        return res.status(400).json({ success: false, errors });
    }

    const reservation = {
        name: name.trim(),
        phone: normalizePhone(phone),
        date,
        time,
        guests: String(guests).trim(),
        comment: comment.trim()
    };

    if (adminChatId) {
        const sent = await sendTelegramMessage(formatReservation(reservation));
        if (!sent) {
            pendingReservations.push(reservation);
            persistPendingReservations();
            return res.status(202).json({ success: true, queued: true, message: 'Администратор временно недоступен, бронирование поставлено в очередь.' });
        }
        return res.json({ success: true, message: 'Бронирование отправлено администратору.' });
    }

    pendingReservations.push(reservation);
    persistPendingReservations();
    return res.status(202).json({ success: true, queued: true, message: 'Администратор ещё не подключился. Бронирование будет отправлено автоматически.' });
});

app.get('/api/health', (req, res) => {
    res.json({ success: true, adminConnected: Boolean(adminChatId), queuedReservations: pendingReservations.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));