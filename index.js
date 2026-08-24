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
    RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || '',
    BOT_CHECK_INTERVAL_SEC: 6,
    AUTOSTART_INTERVAL_SEC: 25,
    COOLDOWN_MS: 240000 // 4-Minute Cooldown
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
let lastPingLatency = null;
const logs = [];

function log(msg) {
    const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
    const entry = `[${time}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 80) logs.shift();
}

// ================= ROBUST ATERNOS AUTOMATION =================
async function executeAternosStartSequence() {
    if (isPuppeteerRunning) return false;
    if (!CONFIG.ATERNOS_USER || !CONFIG.ATERNOS_PASS) {
        log('❌ [CONFIG ERROR] ATERNOS_USER ya ATERNOS_PASS missing hain!');
        return false;
    }

    const now = Date.now();
    if (now - lastStartAttemptTime < CONFIG.COOLDOWN_MS) {
        return false;
    }

    isPuppeteerRunning = true;
    lastStartAttemptTime = Date.now();
    log('🚀 [ATERNOS] Stealth browser launch ho raha hai...');

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--single-process',
                '--disable-accelerated-2d-canvas',
                '--disable-extensions',
                '--js-flags=--max-old-space-size=128'
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resType = req.resourceType();
            const url = req.url();
            if (['image', 'media', 'font'].includes(resType) || url.includes('google-analytics') || url.includes('doubleclick')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        log('🌐 [ATERNOS] Login page open kar rahe hain...');
        await page.goto('https://aternos.org/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Cookie/Consent Popup bypass
        try {
            const consentBtn = await page.waitForSelector('.fc-cta-consent, .cookie-consent-accept, button[aria-label="Consent"]', { timeout: 6000 });
            if (consentBtn) {
                await consentBtn.click();
                log('🍪 Cookie consent auto-accepted.');
            }
        } catch (e) {}

        const userSelector = '#user, input[name="user"], input[type="text"]';
        await page.waitForSelector(userSelector, { timeout: 40000 });
        await page.type(userSelector, CONFIG.ATERNOS_USER, { delay: 20 });
        
        const passSelector = '#password, input[name="password"], input[type="password"]';
        await page.type(passSelector, CONFIG.ATERNOS_PASS, { delay: 20 });

        const loginBtnSelector = '#login, button[type="submit"], .login-button';
        await Promise.all([
            page.click(loginBtnSelector),
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
        ]);

        log('🔑 [ATERNOS] Login complete. Server panel check kar rahe hain...');

        if (page.url().includes('/servers/')) {
            await page.evaluate((targetHost) => {
                const cleanHost = targetHost.toLowerCase().split('.')[0];
                const cards = document.querySelectorAll('.server-body, .serverbox');
                for (let card of cards) {
                    if (card.innerText.toLowerCase().includes(cleanHost)) {
                        card.click();
                        return;
                    }
                }
                const firstServer = document.querySelector('.serverbox, .server-body');
                if (firstServer) firstServer.click();
            }, CONFIG.SERVER_HOST);

            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }

        const startBtnSelector = '#start, .btn-start, [id="start"]';
        await page.waitForSelector(startBtnSelector, { timeout: 30000 });
        await page.click(startBtnSelector);
        log('🟢 [ATERNOS] Start button click ho gaya!');

        try {
            const confirmBtn = await page.waitForSelector('#confirm, .btn-confirm, [id="confirm"]', { visible: true, timeout: 8000 });
            if (confirmBtn) {
                await confirmBtn.click();
                log('✅ [ATERNOS] Queue Confirmation popup accept ho gaya!');
            }
        } catch (e) {}

        await browser.close();
        isPuppeteerRunning = false;
        return true;
    } catch (err) {
        log(`❌ [ATERNOS ERROR] ${err.message}`);
        if (browser) await browser.close();
        isPuppeteerRunning = false;
        return false;
    }
}

// ================= DYNAMIC ROAMING & ANTI-AFK =================
function startDynamicRoaming(botInstance) {
    let roamTimeout = null;
    let slotTimeout = null;
    let basePosition = null;

    function scheduleSlotJiggle() {
        const nextDelay = Math.floor(Math.random() * (35000 - 15000 + 1)) + 15000;
        slotTimeout = setTimeout(() => {
            if (botInstance && botInstance.entity) {
                const currentSlot = botInstance.quickBarSlot || 0;
                let targetSlot = (currentSlot + 1) % 9;
                botInstance.setQuickBarSlot(targetSlot);
            }
            scheduleSlotJiggle();
        }, nextDelay);
    }

    function scheduleNextRoam() {
        const nextDelay = Math.floor(Math.random() * (15000 - 8000 + 1)) + 8000;
        roamTimeout = setTimeout(() => {
            if (botInstance && botInstance.entity && botInstance.pathfinder) {
                if (!botInstance.pathfinder.isMoving()) {
                    if (!basePosition) basePosition = botInstance.entity.position.clone();
                    const actionRoll = Math.random();

                    if (actionRoll < 0.60) {
                        const radius = 4;
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
                        botInstance.look(botInstance.entity.yaw + 0.5, 0, true);
                        setTimeout(() => botInstance.setControlState('sneak', false), 600);
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
    reconnectTimer = setInterval(async () => {
        if (botStatus === 'DISCONNECTED') {
            try {
                const response = await util.status(CONFIG.SERVER_HOST, CONFIG.SERVER_PORT, { timeout: 3000 });
                serverStatus = 'ONLINE';
                lastPingLatency = response.roundTripLatency;
                log(`🟢 [SERVER LIVE] Status: ONLINE | Ping: ${lastPingLatency}ms | Connecting bot...`);
                connectBot();
            } catch (err) {
                serverStatus = 'OFFLINE';
                lastPingLatency = null;
                log(`🔴 [SERVER STATUS] OFFLINE. Agle 8s me fir check hoga.`);
            }
        }
    }, 8000);
}

// ================= BOT CONTROLLER =================
function connectBot() {
    if (botStatus === 'CONNECTING' || botStatus === 'CONNECTED') return;

    botStatus = 'CONNECTING';
    log(`🤖 [BOT] Joining server as '${CONFIG.BOT_USERNAME}'...`);

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
            log(`✅ [BOT] Successfully join ho gaya! Anti-AFK Roaming active.`);
            startDynamicRoaming(bot);

            if (CONFIG.BOT_PASSWORD) {
                setTimeout(() => {
                    bot.chat(`/register ${CONFIG.BOT_PASSWORD} ${CONFIG.BOT_PASSWORD}`);
                    bot.chat(`/login ${CONFIG.BOT_PASSWORD}`);
                }, 2000);
            }
        });

        bot.on('death', () => {
            log('💀 [BOT] Bot died! Respawn ho raha hai...');
            setTimeout(() => { if (bot) bot.respawn(); }, 2000);
        });

        bot.on('kicked', (reason) => {
            log(`⚠️ [BOT] Kicked: ${reason}`);
        });

        bot.on('end', () => {
            botStatus = 'DISCONNECTED';
            if (bot && bot.stopRoaming) bot.stopRoaming();
            log('🔴 [BOT] Disconnected.');
            bot = null;
        });

        bot.on('error', (err) => {
            botStatus = 'DISCONNECTED';
            if (bot && bot.stopRoaming) bot.stopRoaming();
            log(`❌ [BOT ERROR] Connection error: ${err.message}`);
            bot = null;
        });

    } catch (e) {
        botStatus = 'DISCONNECTED';
        log(`❌ [BOT EXCEPTION] ${e.message}`);
    }
}

// ================= WATCHDOG & SELF PING =================
function startWatchdogs() {
    log('🚀 [SYSTEM] Watchdog Ready.');

    setInterval(async () => {
        if (watchdogPaused) return;
        if (serverStatus === 'OFFLINE' && !isPuppeteerRunning) {
            if (Date.now() - lastStartAttemptTime >= CONFIG.COOLDOWN_MS) {
                log('🔄 [WATCHDOG] Server start trigger kiya...');
                await executeAternosStartSequence();
            }
        }
    }, CONFIG.AUTOSTART_INTERVAL_SEC * 1000);

    if (CONFIG.RENDER_EXTERNAL_URL) {
        setInterval(async () => {
            try {
                await axios.get(CONFIG.RENDER_EXTERNAL_URL, { timeout: 10000 });
            } catch (e) {}
        }, 240000);
    }

    startReconnectionLoop();
}

// ================= DASHBOARD =================
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Aternos Sentinel Dashboard</title><meta http-equiv="refresh" content="5"></head>
        <body style="background:#090d16;color:#e6edf3;font-family:monospace;padding:20px;">
            <h2>⚡ ATERNOS SENTINEL DASHBOARD</h2>
            <p>Server: <b>${CONFIG.SERVER_HOST}:${CONFIG.SERVER_PORT}</b></p>
            <p>Status: <b style="color:${serverStatus === 'ONLINE' ? '#3fb950' : '#f85149'};">${serverStatus}</b> | Bot: <b>${botStatus}</b></p>
            <p>
                <a href="/start" style="background:#238636;color:white;padding:8px 12px;text-decoration:none;border-radius:4px;display:inline-block;margin-right:10px;">⚡ Force Start</a>
                <a href="/toggle" style="background:#8957e5;color:white;padding:8px 12px;text-decoration:none;border-radius:4px;display:inline-block;">⏯️ Toggle Watchdog</a>
            </p>
            <hr style="border:1px solid #30363d;"/>
            <h3>System Logs</h3>
            <div style="background:#010409;padding:12px;border-radius:6px;max-height:350px;overflow-y:auto;font-size:12px;">
                ${logs.map(l => `<div style="color:${l.includes('ERROR') || l.includes('OFFLINE') ? '#f85149' : '#7ee787'};margin-bottom:4px;">${l}</div>`).join('')}
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
    log(`⚠️ [WATCHDOG] ${watchdogPaused ? 'PAUSED' : 'RESUMED'}.`);
    res.redirect('/');
});

app.listen(PORT, () => {
    log(`🌐 Dashboard running on port ${PORT}`);
    startWatchdogs();
});
