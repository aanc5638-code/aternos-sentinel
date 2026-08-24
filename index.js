const express = require('express');
const util = require('minecraft-server-util');
const mineflayer = require('mineflayer');
const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const CONFIG = {
    SERVER_HOST: process.env.SERVER_HOST || 'Notzz_aahil.aternos.me',
    SERVER_PORT: parseInt(process.env.SERVER_PORT, 10) || 58642,
    BOT_USERNAME: process.env.BOT_USERNAME || 'Mai_hu_ek_ninja',
    ATERNOS_USER: process.env.ATERNOS_USER || '',
    ATERNOS_PASS: process.env.ATERNOS_PASS || '',
    BOT_CHECK_INTERVAL_SEC: 6,
    AUTOSTART_INTERVAL_SEC: 20,
    MAX_RETRIES: 5
};

let currentSessionCookie = '';
let currentSecToken = '';
let isRefreshingSession = false;

const app = express();
const PORT = process.env.PORT || 3000;

let bot = null;
let serverStatus = 'OFFLINE';
let botStatus = 'DISCONNECTED';
let recoveryAttempts = 0;
const logs = [];

function log(msg) {
    const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
    const entry = `[${time}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 60) logs.shift();
}

async function refreshAternosSession() {
    if (isRefreshingSession) return false;
    if (!CONFIG.ATERNOS_USER || !CONFIG.ATERNOS_PASS) {
        log('❌ Set ATERNOS_USER and ATERNOS_PASS in Environment Variables.');
        return false;
    }

    isRefreshingSession = true;
    log('🔑 Auto-Login: Fetching fresh Aternos session...');

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await page.goto('https://aternos.org/go/', { waitUntil: 'networkidle2', timeout: 45000 });

        await page.type('#user', CONFIG.ATERNOS_USER);
        await page.type('#password', CONFIG.ATERNOS_PASS);
        await page.click('#login');

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 });
        await page.goto('https://aternos.org/server/', { waitUntil: 'networkidle2', timeout: 45000 });

        const cookies = await page.cookies();
        const sessionCookieObj = cookies.find(c => c.name === 'ATERNOS_SESSION');

        if (!sessionCookieObj) {
            log('⚠️ Failed to extract ATERNOS_SESSION.');
            await browser.close();
            isRefreshingSession = false;
            return false;
        }

        currentSessionCookie = sessionCookieObj.value;
        const extractedSec = await page.evaluate(() => window.AJAX_TOKEN || (window.server && window.server.sec) || '');
        currentSecToken = extractedSec;

        log('✅ Session active and refreshed!');
        await browser.close();
        isRefreshingSession = false;
        return true;
    } catch (err) {
        log(`❌ Auto-Login Error: ${err.message}`);
        if (browser) await browser.close();
        isRefreshingSession = false;
        return false;
    }
}

async function triggerAternosStart() {
    if (!currentSessionCookie || !currentSecToken) {
        const refreshed = await refreshAternosSession();
        if (!refreshed) return false;
    }

    const startUrl = `https://aternos.org/panel/ajax/start.php?SEC=${currentSecToken}&headstart=0`;
    try {
        const res = await axios.get(startUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Cookie': `ATERNOS_SESSION=${currentSessionCookie};`,
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': 'https://aternos.org/server/'
            },
            timeout: 10000
        });

        if (res.data && res.data.success) {
            log('⚡ Aternos START command accepted.');
            return true;
        } else {
            log('⚠️ Session expired mid-run. Refreshing token next cycle...');
            currentSessionCookie = '';
            currentSecToken = '';
            return false;
        }
    } catch (err) {
        log(`❌ Start request error: ${err.message}`);
        return false;
    }
}

function connectBot() {
    if (botStatus === 'CONNECTING' || botStatus === 'CONNECTED') return;

    botStatus = 'CONNECTING';
    log(`🤖 Connecting Bot (${CONFIG.BOT_USERNAME})...`);

    try {
        bot = mineflayer.createBot({
            host: CONFIG.SERVER_HOST,
            port: CONFIG.SERVER_PORT,
            username: CONFIG.BOT_USERNAME,
            version: false
        });

        bot.on('spawn', () => {
            botStatus = 'CONNECTED';
            log('✅ Bot joined server successfully!');
        });

        bot.on('end', () => {
            botStatus = 'DISCONNECTED';
            log('🔴 Bot disconnected.');
            bot = null;
        });

        bot.on('error', (err) => {
            botStatus = 'DISCONNECTED';
            log(`⚠️ Bot error: ${err.message}`);
            bot = null;
        });

        bot.on('kicked', () => {
            botStatus = 'DISCONNECTED';
            bot = null;
        });
    } catch (e) {
        botStatus = 'DISCONNECTED';
        log(`❌ Bot failed to initialize: ${e.message}`);
    }
}

function startWatchdogs() {
    log('🚀 Watchdog started.');

    // Har 6s: Bot & Server Status Check
    setInterval(async () => {
        try {
            await util.status(CONFIG.SERVER_HOST, CONFIG.SERVER_PORT, { timeout: 3000 });

            if (serverStatus !== 'ONLINE') {
                log('🟢 Server is ONLINE!');
                serverStatus = 'ONLINE';
                recoveryAttempts = 0;
            }

            if (botStatus === 'DISCONNECTED') {
                connectBot();
            }
        } catch (err) {
            if (serverStatus === 'ONLINE') {
                log('🔴 Server went OFFLINE.');
            }
            if (serverStatus !== 'STARTING') {
                serverStatus = 'OFFLINE';
            }
            botStatus = 'DISCONNECTED';
        }
    }, CONFIG.BOT_CHECK_INTERVAL_SEC * 1000);

    // Har 20s: Server Recovery Trigger
    setInterval(async () => {
        if (serverStatus === 'OFFLINE') {
            if (recoveryAttempts < CONFIG.MAX_RETRIES) {
                recoveryAttempts++;
                serverStatus = 'STARTING';
                log(`🔄 [Auto-Start] Attempt ${recoveryAttempts}/${CONFIG.MAX_RETRIES}...`);
                await triggerAternosStart();
            }
        }
    }, CONFIG.AUTOSTART_INTERVAL_SEC * 1000);
}

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Aternos Sentinel</title><meta http-equiv="refresh" content="5"></head>
        <body style="background:#0b0d14;color:#e6edf3;font-family:monospace;padding:20px;">
            <h2>⚡ ATERNOS SENTINEL (ACTIVE)</h2>
            <p>Server: <b>${CONFIG.SERVER_HOST}:${CONFIG.SERVER_PORT}</b></p>
            <p>Status: <b>${serverStatus}</b> | Bot: <b>${botStatus}</b></p>
            <hr style="border:1px solid #30363d;"/>
            <h3>Live Logs</h3>
            <div style="background:#010409;padding:10px;border-radius:6px;max-height:250px;overflow-y:auto;">
                ${logs.map(l => `<div style="color:#7ee787;">${l}</div>`).join('')}
            </div>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    log(`HTTP Server running on port ${PORT}`);
    startWatchdogs();
});
      
