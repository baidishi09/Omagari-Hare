const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'test-results');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(output, 'packaged-'));
  const application = await _electron.launch({ executablePath: path.join(root, 'release', 'win-unpacked', 'Omagari Hare.exe'), args: [`--data-dir=${profile}`, '--settings'] });
  try {
    await application.firstWindow();
    await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
    let page;
    for (let i = 0; i < 50; i++) {
      page = application.windows().find(window => window.url().endsWith('settings.html'));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(page);
    await page.waitForLoadState();
    const data = await page.evaluate(() => window.hare.getState());
    assert.equal(data.settings.idleMinutes, 10);
    assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
    const pet = application.windows().find(window => window.url().endsWith('pet.html'));
    await pet.waitForFunction(() => {
      const c = document.querySelector('canvas');
      return c && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0);
    });
    await page.waitForFunction(async () => (await window.hare.getState()).status.phase === 'idle');
    await page.waitForFunction(() => {
      const bg = document.querySelector('.room-background');
      const canvas = document.getElementById('scene-pet');
      return bg?.naturalWidth === 1536 && canvas && canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((v, i) => i % 4 === 3 && v > 0);
    });
    await page.locator('#settings-button').click();
    assert.equal(await page.locator('#settings-drawer').evaluate(element => element.open), true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.hare.action('walk'));
    assert.equal((await page.evaluate(() => window.hare.getState())).status.phase, 'outbound');
    console.log('Packaged EXE passed: app.isPackaged, default settings, bundled scene and sprite rendering, settings drawer, manual patrol.');
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
