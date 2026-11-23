const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'test-results');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(output, 'preview-'));
  const app = await _electron.launch({ args: [root, `--data-dir=${profile}`, '--settings'] });
  try {
    await app.firstWindow();
    await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
    let page;
    for (let i = 0; i < 50; i++) {
      page = app.windows().find(window => window.url().endsWith('settings.html'));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await page.waitForLoadState();
    await page.waitForFunction(() => document.getElementById('habit-minutes').textContent.includes('10 分钟') && !document.getElementById('walk-button').disabled);
    await page.waitForFunction(() => {
      const canvas = document.getElementById('scene-pet');
      return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v > 0);
    });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(root, 'docs/home-scene.png') });
    await page.locator('#settings-button').click();
    await page.screenshot({ path: path.join(root, 'docs/settings-drawer.png') });
    console.log('Default ten-minute scene and drawer previews saved.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
