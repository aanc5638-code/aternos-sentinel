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

        console.log('🌐 Direct server dashboard open kar rahe hain...');
        await page.goto('https://aternos.org/server/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Cookie banner accept
        try {
            const consentBtn = await page.waitForSelector('.fc-cta-consent, .cookie-consent-accept, button[aria-label="Consent"]', { timeout: 4000 });
            if (consentBtn) await consentBtn.click();
        } catch (e) {}

        // Agar galti se servers list open ho, toh first server click karein
        try {
            const serverCard = await page.waitForSelector('.serverbox, .server-body', { timeout: 4000 });
            if (serverCard) {
                await serverCard.click();
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            }
        } catch (e) {}

        // Start button click
        console.log('🔍 Looking for Start button...');
        const startBtn = await page.waitForSelector('#start, .btn-start, [id="start"]', { visible: true, timeout: 25000 });
        if (startBtn) {
            await startBtn.click();
            console.log('🟢 [SUCCESS] Start button clicked successfully!');
        }

        // Queue confirm popup agar aaye
        try {
            const confirmBtn = await page.waitForSelector('#confirm, .btn-confirm, [id="confirm"]', { visible: true, timeout: 8000 });
            if (confirmBtn) {
                await confirmBtn.click();
                console.log('✅ Queue confirmed!');
            }
        } catch (e) {}

        await new Promise(r => setTimeout(r, 6000));
        console.log('🎉 Server auto-start executed!');

    } catch (err) {
        console.log(`❌ Error: ${err.message}`);
    } finally {
        await browser.close();
    }
})();
