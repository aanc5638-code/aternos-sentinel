const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const ATERNOS_USER = process.env.ATERNOS_USER;
const ATERNOS_PASS = process.env.ATERNOS_PASS;

(async () => {
    if (!ATERNOS_USER || !ATERNOS_PASS) {
        console.log('❌ ATERNOS_USER ya ATERNOS_PASS missing hai!');
        process.exit(1);
    }

    console.log('🚀 Launching Stealth Browser...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        console.log('🌐 Aternos login page open kar rahe hain...');
        await page.goto('https://aternos.org/go/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        try {
            const consentBtn = await page.waitForSelector('.fc-cta-consent, .cookie-consent-accept, button[aria-label="Consent"]', { timeout: 6000 });
            if (consentBtn) await consentBtn.click();
        } catch (e) {}

        const userSelector = '#user, input[name="user"], input[type="text"]';
        await page.waitForSelector(userSelector, { timeout: 30000 });
        await page.type(userSelector, ATERNOS_USER, { delay: 40 });

        const passSelector = '#password, input[name="password"], input[type="password"]';
        await page.waitForSelector(passSelector, { timeout: 20000 });
        await page.type(passSelector, ATERNOS_PASS, { delay: 40 });

        const loginBtn = '#login, button[type="submit"], .login-button';
        await page.waitForSelector(loginBtn, { timeout: 15000 });
        await Promise.all([
            page.click(loginBtn),
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
        ]);

        console.log('🔑 Login success! Server choose kar rahe hain...');

        if (page.url().includes('/servers/')) {
            const serverCard = await page.waitForSelector('.server-body, .serverbox', { timeout: 20000 });
            await serverCard.click();
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }

        const startBtn = '#start, .btn-start, [id="start"]';
        await page.waitForSelector(startBtn, { timeout: 30000 });
        await page.click(startBtn);
        console.log('🟢 Start button clicked!');

        try {
            const confirmBtn = await page.waitForSelector('#confirm, .btn-confirm, [id="confirm"]', { visible: true, timeout: 8000 });
            if (confirmBtn) {
                await confirmBtn.click();
                console.log('✅ Queue confirmed!');
            }
        } catch (e) {}

        await new Promise(r => setTimeout(r, 10000));
        console.log('🎉 Server start command successfully sent!');

    } catch (err) {
        console.log(`❌ Error: ${err.message}`);
    } finally {
        await browser.close();
    }
})();
