'use strict';

const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'ui-profile-'));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(read, matches, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (matches(value)) return value;
    await sleep(40);
  } while (Date.now() < deadline);
  assert.fail(`${description}; last value: ${JSON.stringify(value)}`);
}

async function assertLayout(page, drawerOpen) {
  const layout = await page.evaluate(() => {
    const root = document.documentElement;
    const dialog = document.getElementById('settings-drawer');
    const rectangle = dialog.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: root.scrollWidth, height: root.scrollHeight },
      drawer: {
        top: rectangle.top, left: rectangle.left, right: rectangle.right, bottom: rectangle.bottom,
        width: dialog.clientWidth, scrollWidth: dialog.scrollWidth,
      },
    };
  });
  assert(layout.document.width <= layout.viewport.width + 1, `page has no horizontal overflow: ${JSON.stringify(layout)}`);
  assert(layout.document.height <= layout.viewport.height + 1, `page has no vertical overflow: ${JSON.stringify(layout)}`);
  if (drawerOpen) {
    const drawer = layout.drawer;
    assert(drawer.top >= -1 && drawer.left >= -1 && drawer.right <= layout.viewport.width + 1 && drawer.bottom <= layout.viewport.height + 1,
      `drawer stays within the viewport: ${JSON.stringify(layout)}`);
    assert(drawer.scrollWidth <= drawer.width + 1, 'drawer may scroll vertically, but never horizontally');
  }
}

async function main() {
  const application = await electron.launch({ args: [root, `--data-dir=${profile}`, '--settings'], timeout: 30000 });
  const errors = [];
  const observe = page => page.on('pageerror', error => errors.push(error.message));
  application.on('window', observe);
  application.windows().forEach(observe);
  try {
    const page = await until(async () => application.windows().find(item => item.url().endsWith('settings.html')), Boolean, 'settings page loaded');
    const pet = await until(async () => application.windows().find(item => item.url().endsWith('pet.html')), Boolean, 'native pet loaded');
    await Promise.all([page.waitForLoadState('load'), pet.waitForLoadState('load')]);
    await page.waitForFunction(() => Boolean(window.hare && document.getElementById('settings-drawer')));
    await page.evaluate(() => document.fonts.ready);
    await pet.evaluate(() => {
      window.__uiPetPackets = [];
      window.hare.onPet(packet => { window.__uiPetPackets.push(packet); });
    });
    await application.evaluate(({ powerMonitor }) => {
      globalThis.__uiIdle = 0;
      powerMonitor.getSystemIdleTime = () => globalThis.__uiIdle;
    });

    const state = () => page.evaluate(() => window.hare.getState());
    const latestPacket = () => pet.evaluate(() => window.__uiPetPackets.at(-1));
    const drawer = page.locator('#settings-drawer');
    const openSettings = page.locator('#settings-button');
    assert.equal(await drawer.evaluate(element => element.open), false, 'home starts with the settings drawer closed');
    const visibleFields = await page.locator('input, select').evaluateAll(elements => elements.filter(element => {
      const style = getComputedStyle(element);
      return element.getClientRects().length && style.visibility !== 'hidden';
    }).map(element => element.id));
    assert.deepEqual(visibleFields, [], 'home does not expose the settings form');
    await assertLayout(page, false);

    await openSettings.click();
    await until(() => drawer.evaluate(element => element.open), Boolean, 'settings button opens native dialog');
    assert.equal(await drawer.evaluate(element => element.matches(':modal')), true, 'drawer uses native modal dialog semantics');
    await page.keyboard.press('Escape');
    await until(() => drawer.evaluate(element => element.open), open => !open, 'Escape closes drawer');
    assert.equal(await openSettings.evaluate(element => document.activeElement === element), true, 'Escape restores focus to settings opener');

    await page.locator('#habits-button').click();
    await until(() => drawer.evaluate(element => element.open), Boolean, 'habit note opens drawer');
    assert.equal(await page.locator('#idle-minutes').evaluate(element => document.activeElement === element), true, 'habit note focuses the idle duration field');
    await page.locator('#idle-minutes').fill('12');
    await page.locator('#idle-minutes').press('Tab');
    await until(state, value => value.settings.idleMinutes === 12, 'duration edited in the UI reaches the actual main process');
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).idleMinutes, 12, 'duration is saved to the isolated profile');
    await page.locator('#close-settings').click();
    assert.equal(await page.locator('#habits-button').evaluate(element => document.activeElement === element), true, 'close button restores focus to the actual opener');
    console.log('Passed: scene-first home, hidden form, modal drawer, Escape and focus restoration, real preference persistence.');

    async function expression(button, expected, previousToken = -1) {
      await page.locator(button).click();
      return until(latestPacket, packet => packet?.expression === expected && packet.expressionToken > previousToken,
        `${button} changes the actual desktop pet expression`);
    }
    const waving = await expression('#wave-button', 'waving');
    const jumping = await expression('#jump-button', 'jumping', waving.expressionToken);
    assert(jumping.expressionToken > waving.expressionToken);
    await page.locator('#walk-button').click();
    await application.evaluate(() => { globalThis.__uiIdle = 2; });
    await until(state, value => value.status.moving, 'walk button controls the actual pet');
    assert.equal(await page.locator('#wave-button').isDisabled(), true, 'wave is disabled during movement');
    assert.equal(await page.locator('#jump-button').isDisabled(), true, 'jump is disabled during movement');
    assert.equal(await page.locator('#walk-button').isDisabled(), true, 'duplicate walk request is disabled during movement');
    const movingToken = (await latestPacket()).expressionToken;
    await page.evaluate(() => window.hare.action('wave'));
    await sleep(100);
    assert.equal((await latestPacket()).expressionToken, movingToken, 'main process also rejects expressions while moving');
    await page.locator('#home-button').click();
    await until(state, value => !value.status.moving, 'home button returns the pet to its dock');
    await until(() => page.locator('#wave-button').isEnabled(), Boolean, 'idle pet enables interaction again');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await expression('#wave-button', 'waving', movingToken);
    assert(reduced.expressionToken > movingToken, 'reduced motion does not disable explicit actions');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await sleep(1000);
    await page.screenshot({ path: path.join(output, 'home-scene.png') });
    await openSettings.click();
    await page.screenshot({ path: path.join(output, 'settings-drawer.png') });
    await page.keyboard.press('Escape');
    console.log('Passed: real wave/jump expression tokens, moving-state guards, walk/home interaction, reduced-motion controls.');

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('settings.html'));
      window.setSize(800, 640);
    });
    await sleep(250);
    await assertLayout(page, false);
    await openSettings.click();
    await assertLayout(page, true);
    await page.locator('#launch-at-login').scrollIntoViewIfNeeded();
    await assertLayout(page, true);
    console.log('Passed: minimum 800×640 native window layout; drawer scroll stays within the viewport.');

    // Inject one rejected main-process save only after all successful save
    // checks. This process/profile is disposable; no production handler or
    // installed application is modified.
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('hare:save-settings');
      ipcMain.handle('hare:save-settings', () => { throw new Error('UI_SAVE_TEST：模拟写入失败'); });
    });
    await page.locator('#idle-minutes').fill('13');
    await page.locator('#idle-minutes').press('Tab');
    await until(() => page.locator('#save-status').textContent(), text => text.includes('UI_SAVE_TEST') && /未能保存|保存失败/.test(text),
      'failed save produces visible explanatory feedback');
    assert.equal((await state()).settings.idleMinutes, 12, 'failed save cannot silently mutate the real setting');
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).idleMinutes, 12);
    assert.equal(await page.locator('#idle-minutes').inputValue(), '12', 'failed save restores the persisted value in the form');
    assert.deepEqual(errors, [], 'no renderer exceptions');
    console.log('UI smoke passed: scene home, accessible drawer, persistence, live pet actions, movement guards, reduced motion, error recovery, and minimum window layout.');
  } finally {
    await application.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
