// Ad-hoc screenshot driver for the design-migration rollout, scratchpad only.
const { chromium } = require('playwright');

const BASE = 'http://localhost:5173';
const OUT_DIR = '/tmp/claude-1000/-home-aroy2o-Music-SIH-railway/4a4cc9fe-dd16-476b-a602-fd1999a57df6/scratchpad/screenshots';

const [, , username, password, path, outName, tabRole] = process.argv;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });

  if (path) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  }
  await page.waitForTimeout(500);

  const skip = page.getByText('Skip tour');
  if (await skip.count()) {
    await skip.first().click();
    await page.waitForTimeout(300);
  }

  if (tabRole) {
    await page.getByRole('tab', { name: tabRole }).click();
    await page.waitForTimeout(400);
  }

  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.screenshot({ path: `${OUT_DIR}/${outName}.png`, fullPage: true });
  console.log('Console errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch((e) => {
  console.error('SHOT_FAIL', e);
  process.exit(1);
});
