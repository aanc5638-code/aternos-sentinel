const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const ATERNOS_SESSION = process.env.ATERNOS_SESSION;

(async () => {
    if (!ATERNOS_SESSION) {
        console.log('❌ ATERNOS_SESSION cookie missing hai!');
        process.exit(1);
    }

    console.log('🚀 Launching Stealth Browser with Session Cookie...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        await page.setCookie({
            name: 'ATERNOS_SESSION',
            value: ATERNOS_SESSION.trim(),
            domain: '.aternos.org',
            path: '/',
            httpOnly: true,
            secure: true
        });

        console.log('🌐 Direct server panel open kar rahe hain...');
        await page.goto('https://aternos.org/server/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        try {
            const consentBtn = await page.waitForSelector('.fc-cta-consent, .cookie-consent-accept, button[aria-label="Consent"]', { timeout: 5000 });
            if (consentBtn) await consentBtn.click();
        } catch (e) {}

        if (page.url().includes('/servers/')) {
            const firstServer = await page.waitForSelector('.serverbox, .server-body', { timeout: 15000 });
            if (firstServer) {
                await firstServer.click();
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            }
        }

        const startBtn = '#start, .btn-start, [id="start"]';
        await page.waitForSelector(startBtn, { timeout: 30000 });
        await page.click(startBtn);
        console.log('🟢 [SUCCESS] Start button clicked successfully!');

        try {
            const confirmBtn = await page.waitForSelector('#confirm, .btn-confirm, [id="confirm"]', { visible: true, timeout: 8000 });
            if (confirmBtn) {
                await confirmBtn.click();
                console.log('✅ Queue confirmed!');
            }
        } catch (e) {}

        await new Promise(r => setTimeout(r, 8000));
        console.log('🎉 Server start command delivered!');

    } catch (err) {
        console.log(`❌ Error: ${err.message}`);
    } finally {
        await browser.close();
    }
})();
