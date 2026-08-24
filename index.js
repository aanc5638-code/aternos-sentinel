const express = require('express');
const util = require('minecraft-server-util');
const mineflayer = require('mineflayer');
const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');

puppeteer.use(StealthPlugin());

// ================= CONFIGURATION =================
const CONFIG = {
    SERVER_HOST: process.env.SERVER_HOST || 'Notzz_aahil.aternos.me',
    SERVER_PORT: parseInt(process.env.SERVER_PORT, 10) || 58642,
    BOT_USERNAME: process.env.BOT_USERNAME || 'Mai_hu_ek_ninja',
    BOT_PASSWORD: process.env.BOT_PASSWORD || '',
    ATERNOS_USER: process.env.ATERNOS_USER || '',
    ATERNOS_PASS: process.env.ATERNOS_PASS || '',
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
    RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || '',
    BOT_CHECK_INTERVAL_SEC: 6,
    AUTOSTART_INTERVAL_SEC: 20,
    COOLDOWN_MS: 180000 // 3-Minute Safety Cooldown
};

let isPuppeteerRunning = false;
let watchdogPaused = false;
let lastStartAttemptTime = 0;
let reconnectTimer = null;

const app = express();
const PORT = process.env.PORT || 3000;

let bot = null;
let serverStatus = 'OFFLINE';
let botStatus = 'DISCONNECTED';
const logs = [];

function log(msg) {
    const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
    const entry = `[${time}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 90) logs.shift();
}

async function sendDiscordAlert(title, message, color = 0x00ff66) {
    if (!CONFIG.DISCORD_WEBHOOK_URL) return;
    try {
        await axios.post(CONFIG.DISCORD_WEBHOOK_URL, {
            embeds: [{
                title: title,
                description: message,
                color: color,
                timestamp: new Date().toISOString()
            }]
        });
    } catch (e) {
        log(`⚠️ Discord Webhook Error: ${e.message}`);
    }
}

// ================= ATERNOS AUTOMATION ENGINE =================
async function executeAternosStartSequence() {
    if (isPuppeteerRunning) return false;
    if (!CONFIG.ATERNOS_USER || !CONFIG.ATERNOS_PASS) {
        log('❌ Missing ATERNOS_USER or ATERNOS_PASS in environment variables.');
        return false;
    }

    const now = Date.now();
    if (now - lastStartAttemptTime < CONFIG.COOLDOWN_MS) return false;

    isPuppeteerRunning = true;
    lastStartAttemptTime = Date.now();
    log('🚀 Launching Stealth Browser to start Aternos server...');

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        // Ad-Block & Tracker Interceptor (Saves RAM/CPU)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resType = req.resourceType();
            const url = req.url();
            if (['image', 'media', 'font', 'stylesheet'].includes(resType) || url.includes('google-analytics') || url.includes('doubleclick') || url.includes('adservice')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto('https://aternos.org/go/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#user', { timeout: 15000 });
        await page.type('#user', CONFIG.ATERNOS_USER, { delay: 20 });
        await page.type('#password', CONFIG.ATERNOS_PASS, { delay: 20 });
        await page.click('#login');

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 });

        // Auto-Card Targeter for specific server
        if (page.url().includes('/servers/')) {
            await page.evaluate((targetHost) => {
                const cards = document.querySelectorAll('.server-body');
                for (let card of cards) {
                    if (card.innerText.toLowerCase().includes(targetHost.toLowerCase().split('.')[0])) {
                        card.click();
                        return;
                    }
                }
                const firstServer = document.querySelector('.serverbox, .server-body');
                if (firstServer) firstServer.click();
            }, CONFIG.SERVER_HOST);
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        await page.waitForSelector('#start', { timeout: 15000 });
        await page.click('#start');
        log('🟢 Clicked #start button on Aternos panel.');

        // Queue Confirmation Clicker
        try {
            const confirmBtn = await page.waitForSelector('#confirm, .btn-confirm', { visible: true, timeout: 8000 });
            if (confirmBtn) {
                await confirmBtn.click();
                log('✅ Queue Confirmation Popup Accepted!');
            }
        } catch (e) {}

        sendDiscordAlert('⚡ Server Starting', 'Aternos auto-start sequence executed successfully.', 0xffaa00);
        await browser.close();
        isPuppeteerRunning = false;
        return true;
    } catch (err) {
        log(`❌ Aternos Automation Error: ${err.message}`);
        if (browser) await browser.close();
        isPuppeteerRunning = false;
        return false;
    }
}

// ================= DYNAMIC ROAMING & ANTI-AFK ENGINE =================
function startDynamicRoaming(botInstance) {
    let roamTimeout = null;
    let slotTimeout = null;
    let basePosition = null;

    function scheduleSlotJiggle() {
        const nextDelay = Math.floor(Math.random() * (35000 - 12000 + 1)) + 12000;
        slotTimeout = setTimeout(() => {
            if (botInstance && botInstance.entity) {
                const currentSlot = botInstance.quickBarSlot || 0;
                let targetSlot = Math.random() < 0.7 ? (currentSlot + (Math.random() > 0.5 ? 1 : -1) + 9) % 9 : Math.floor(Math.random() * 9);
                botInstance.setQuickBarSlot(targetSlot);
            }
            scheduleSlotJiggle();
        }, nextDelay);
    }

    function scheduleNextRoam() {
        const nextDelay = Math.floor(Math.random() * (14000 - 6000 + 1)) + 6000;
        roamTimeout = setTimeout(() => {
            if (botInstance && botInstance.entity && botInstance.pathfinder) {
                if (!botInstance.pathfinder.isMoving()) {
                    if (!basePosition) basePosition = botInstance.entity.position.clone();
                    const actionRoll = Math.random();

                    if (actionRoll < 0.65) {
                        const radius = 5;
                        const xOffset = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
                        const zOffset = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
                        const targetX = Math.floor(basePosition.x + xOffset);
                        const targetZ = Math.floor(basePosition.z + zOffset);
                        const targetY = Math.floor(botInstance.entity.position.y);

                        const defaultMove = new Movements(botInstance, require('minecraft-data')(botInstance.version));
                        defaultMove.allowFreeClearance = true;
                        defaultMove.canDig = false;
                        botInstance.pathfinder.setMovements(defaultMove);
                        botInstance.pathfinder.setGoal(new GoalNear(targetX, targetY, targetZ, 1));
                    } else if (actionRoll < 0.85) {
                        botInstance.setControlState('sneak', true);
                        botInstance.look(botInstance.entity.yaw + (Math.random() * 1.6 - 0.8), (Math.random() * 0.4 - 0.2), true);
                        setTimeout(() => botInstance.setControlState('sneak', false), 800);
                    } else {
                        botInstance.swingArm('right');
                    }
                }
            }
            scheduleNextRoam();
        }, nextDelay);
    }

    botInstance.stopRoaming = () => {
        if (roamTimeout) clearTimeout(roamTimeout);
        if (slotTimeout) clearTimeout(slotTimeout);
    };

    scheduleSlotJiggle();
    scheduleNextRoam();
}

// ================= CONTINUOUS RECONNECT LOOP =================
function startReconnectionLoop() {
    if (reconnectTimer) return;
    reconnectTimer = setInterval(() => {
        if (botStatus === 'DISCONNECTED') {
            connectBot();
        }
    }, 8000);
}

// ================= MINEFLAYER BOT CONTROLLER =================
function connectBot() {
    if (botStatus === 'CONNECTING' || botStatus === 'CONNECTED') return;

    botStatus = 'CONNECTING';
    log(`🤖 Attempting to join server (${CONFIG.BOT_USERNAME})...`);

    try {
        bot = mineflayer.createBot({
            host: CONFIG.SERVER_HOST,
            port: CONFIG.SERVER_PORT,
            username: CONFIG.BOT_USERNAME,
            version: false
        });

        bot.loadPlugin(pathfinder);

        bot.on('spawn', () => {
            botStatus = 'CONNECTED';
            log('✅ Bot successfully joined the server and started roaming!');
            sendDiscordAlert('🟢 Bot Joined', `${CONFIG.BOT_USERNAME} has entered the server.`, 0x00ff66);

            startDynamicRoaming(bot);

            if (CONFIG.BOT_PASSWORD) {
                setTimeout(() => {
                    bot.chat(`/register ${CONFIG.BOT_PASSWORD} ${CONFIG.BOT_PASSWORD}`);
                    bot.chat(`/login ${CONFIG.BOT_PASSWORD}`);
                }, 2000);
            }
        });

        bot.on('death', () => {
            log('💀 Bot died! Respawning...');
            setTimeout(() => { if (bot) bot.respawn(); }, 2000);
        });

        bot.on('health', async () => {
            if (bot.food < 15) {
                const food = bot.inventory.items().find(i => i.name.includes('cooked') || i.name.includes('bread') || i.name.includes('apple'));
                if (food) {
                    try {
                        await bot.equip(food, 'hand');
                        await bot.consume();
                    } catch (e) {}
                }
            }
        });

        bot.on('chat', (username, message) => {
            if (username === bot.username) return;
            const args = message.trim().split(' ');
            const cmd = args[0].toLowerCase();

            if (cmd === '!follow') {
                const targetPlayer = args[1] ? args[1] : username;
                const target = bot.players[targetPlayer]?.entity;
                if (!target) {
                    bot.chat(`[Sentinel] ${targetPlayer} nahi dikh raha.`);
                    return;
                }
                bot.chat(`[Sentinel] ${targetPlayer} ke peeche chal raha hoon.`);
                const defaultMove = new Movements(bot, require('minecraft-data')(bot.version));
                defaultMove.allowFreeClearance = true;
                bot.pathfinder.setMovements(defaultMove);
                bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 2), true);
            } else if (cmd === '!stop') {
                bot.chat('[Sentinel] Ruka hua hoon.');
                bot.pathfinder.setGoal(null);
                bot.clearControlStates();
            } else if (cmd === '!coords') {
                const pos = bot.entity.position;
                bot.chat(`[Sentinel] X:${Math.round(pos.x)} Y:${Math.round(pos.y)} Z:${Math.round(pos.z)}`);
            } else if (cmd === '!status') {
                bot.chat(`[Sentinel] HP: ${Math.round(bot.health || 20)}/20 | Food: ${Math.round(bot.food || 20)}/20`);
            }
        });

        bot.on('end', () => {
            botStatus = 'DISCONNECTED';
            if (bot && bot.stopRoaming) bot.stopRoaming();
            log('🔴 Bot disconnected from server.');
            bot = null;
        });

        bot.on('error', (err) => {
            botStatus = 'DISCONNECTED';
            if (bot && bot.stopRoaming) bot.stopRoaming();
            log(`⚠️ Bot connection error: ${err.message}`);
            bot = null;
        });

    } catch (e) {
        botStatus = 'DISCONNECTED';
        log(`❌ Bot init error: ${e.message}`);
    }
}

// ================= WATCHDOG & KEEP-ALIVE =================
function startWatchdogs() {
    log('🚀 Unified Server & Bot Watchdog Activated.');

    // Server status monitoring & instant join trigger
    setInterval(async () => {
        if (watchdogPaused) return;
        try {
            await util.status(CONFIG.SERVER_HOST, CONFIG.SERVER_PORT, { timeout: 3000 });
            if (serverStatus !== 'ONLINE') {
                log('🟢 Server is confirmed ONLINE!');
                serverStatus = 'ONLINE';
            }
            if (botStatus === 'DISCONNECTED') {
                connectBot();
            }
        } catch (err) {
            if (serverStatus === 'ONLINE') log('🔴 Server went OFFLINE.');
            serverStatus = 'OFFLINE';
            botStatus = 'DISCONNECTED';
        }
    }, CONFIG.BOT_CHECK_INTERVAL_SEC * 1000);

    // Auto-start trigger for Aternos
    setInterval(async () => {
        if (watchdogPaused) return;
        if (serverStatus === 'OFFLINE' && !isPuppeteerRunning) {
            if (Date.now() - lastStartAttemptTime >= CONFIG.COOLDOWN_MS) {
                log('🔄 [Auto-Start] Triggering Aternos boot sequence...');
                await executeAternosStartSequence();
            }
        }
    }, CONFIG.AUTOSTART_INTERVAL_SEC * 1000);

    // Keep-alive loop for Render free tier
    if (CONFIG.RENDER_EXTERNAL_URL) {
        setInterval(async () => {
            try {
                await axios.get(CONFIG.RENDER_EXTERNAL_URL, { timeout: 10000 });
            } catch (e) {}
        }, 240000);
    }

    // Start 8-second continuous rejoin worker
    startReconnectionLoop();
}

// ================= WEB DASHBOARD =================
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Aternos Sentinel Unified</title><meta http-equiv="refresh" content="5"></head>
        <body style="background:#090d16;color:#e6edf3;font-family:monospace;padding:20px;">
            <h2>⚡ ATERNOS SENTINEL (COMBINED ENGINE)</h2>
            <p>Server: <b>${CONFIG.SERVER_HOST}:${CONFIG.SERVER_PORT}</b></p>
            <p>Status: <b style="color:${serverStatus === 'ONLINE' ? '#3fb950' : '#f85149'};">${serverStatus}</b> | Bot: <b>${botStatus}</b> | Watchdog: <b>${watchdogPaused ? 'PAUSED' : 'ACTIVE'}</b></p>
            <p>
                <a href="/start" style="background:#238636;color:white;padding:8px 12px;text-decoration:none;border-radius:4px;display:inline-block;margin-right:10px;">⚡ Force Start</a>
                <a href="/toggle" style="background:#8957e5;color:white;padding:8px 12px;text-decoration:none;border-radius:4px;display:inline-block;">⏯️ Toggle Watchdog</a>
            </p>
            <hr style="border:1px solid #30363d;"/>
            <h3>Live System Logs</h3>
            <div style="background:#010409;padding:12px;border-radius:6px;max-height:300px;overflow-y:auto;">
                ${logs.map(l => `<div style="color:#7ee787;margin-bottom:3px;">${l}</div>`).join('')}
            </div>
        </body>
        </html>
    `);
});

app.get('/start', async (req, res) => {
    lastStartAttemptTime = 0;
    executeAternosStartSequence();
    res.redirect('/');
});

app.get('/toggle', (req, res) => {
    watchdogPaused = !watchdogPaused;
    log(`⚠️ Watchdog manually ${watchdogPaused ? 'PAUSED' : 'RESUMED'}.`);
    res.redirect('/');
});

app.listen(PORT, () => {
    log(`🌐 Dashboard live on port ${PORT}`);
    startWatchdogs();
});
