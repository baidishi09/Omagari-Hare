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

async function assertFeedbackClear(page) {
  const layout = await page.evaluate(() => {
    const feedback = document.getElementById('interaction-feedback');
    const rectangle = feedback.getBoundingClientRect();
    const intersects = target => rectangle.left < target.right && rectangle.right > target.left
      && rectangle.top < target.bottom && rectangle.bottom > target.top;
    return {
      visible: Boolean(feedback.textContent.trim()) && getComputedStyle(feedback).display !== 'none', text: feedback.textContent,
      inside: rectangle.left >= 0 && rectangle.right <= innerWidth && rectangle.top >= 0 && rectangle.bottom <= innerHeight,
      collisions: ['.habit-note', '.room-greeting', '.action-bar', '.room-name', '.settings-entry']
        .filter(selector => intersects(document.querySelector(selector).getBoundingClientRect())),
    };
  });
  assert(layout.visible && layout.inside, `feedback stays visible within the viewport: ${JSON.stringify(layout)}`);
  assert.deepEqual(layout.collisions, [], `feedback avoids all home controls and copy: ${JSON.stringify(layout)}`);
}

async function assertMinutesFit(page) {
  const input = page.locator('#idle-minutes');
  await input.fill('120');
  const dimensions = await input.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
  assert(dimensions.width >= dimensions.content, `120 minutes fits without clipping: ${JSON.stringify(dimensions)}`);
  await input.fill('12');
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

    await openSettings.click();
    await assertMinutesFit(page);
    const slider = await page.locator('#speed').boundingBox();
    const drawerBounds = await drawer.boundingBox();
    await page.mouse.move(slider.x + slider.width * 0.75, slider.y + slider.height / 2);
    await page.mouse.down();
    await page.mouse.move(drawerBounds.x - 25, slider.y + slider.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.equal(await drawer.evaluate(element => element.open), true, 'dragging a slider out of the drawer never closes it');
    await page.locator('#speed').evaluate(element => {
      element.value = '70'; element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(state, value => value.settings.speed === 70, 'speed restored after slider gesture');
    await page.mouse.click(drawerBounds.x - 25, slider.y + slider.height / 2);
    await until(() => drawer.evaluate(element => element.open), open => !open, 'a complete click on the backdrop closes the drawer');

    await openSettings.click();
    await page.locator('#idle-minutes').fill('');
    await page.keyboard.press('Escape');
    await openSettings.click();
    assert.equal(await page.locator('#idle-minutes').inputValue(), '12', 'closing discards an invalid number draft');

    // Add a second display at the same physical work area so this regression
    // exercises selection and display-list updates without moving real windows
    // onto unavailable hardware.
    await application.evaluate(({ screen }) => {
      globalThis.__uiOriginalDisplays = screen.getAllDisplays;
      const primary = screen.getPrimaryDisplay();
      globalThis.__uiDisplays = [...screen.getAllDisplays(), { ...primary, id: 987654321, label: 'UI test display' }];
      screen.getAllDisplays = () => globalThis.__uiDisplays;
    });
    await until(() => page.locator('#display option[value="987654321"]').count(), count => count === 1, 'mock display appears');
    await page.evaluate(() => {
      window.__displaySelections = [];
      window.__stopDisplayObservation = window.hare.onState(payload => {
        window.__displaySelections.push({ value: document.getElementById('display').value, saved: payload.settings.displayId });
      });
    });
    await page.locator('#display').focus();
    await page.locator('#display').selectOption('987654321');
    await until(state, value => value.settings.displayId === '987654321', 'focused display selection is saved');
    assert.equal(await page.locator('#display').inputValue(), '987654321', 'saved display remains selected while focused');
    assert.equal(await page.evaluate(() => window.__displaySelections.some(item => item.saved === '987654321' && item.value === 'primary')), false, 'save broadcast never flashes the select back to primary');
    await application.evaluate(() => {
      globalThis.__uiDisplays = globalThis.__uiDisplays.map(display => display.id === 987654321 ? { ...display, label: 'Renamed test display' } : display);
    });
    await until(() => page.locator('#display option[value="987654321"]').textContent(), text => text.includes('Renamed'), 'display list changed during focus');
    assert.equal(await page.locator('#display').inputValue(), '987654321', 'rebuilding focused display options preserves the selected display');
    assert.equal(await page.locator('#display').evaluate(element => document.activeElement === element), true, 'display list refresh preserves focus');
    await page.evaluate(() => window.__stopDisplayObservation());
    await page.locator('#display').selectOption('primary');
    await until(state, value => value.settings.displayId === 'primary', 'restore primary display preference');
    await application.evaluate(({ screen }) => { screen.getAllDisplays = globalThis.__uiOriginalDisplays; });
    await page.keyboard.press('Escape');
    console.log('Passed: slider/backdrop gesture distinction, 120-minute input, invalid-draft reset, focused display selection and list refresh.');

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

    await application.evaluate(() => { globalThis.__uiIdle = 20; });
    await until(state, value => value.status.idleSeconds === 20, 'stable idle sample before pause');
    await page.locator('#pause-button').click();
    await until(state, value => value.settings.paused, 'pause stops patrol');
    await page.locator('#pause-button').click();
    await until(state, value => value.status.requireFreshInput, 'resume requires fresh input');
    await until(() => page.locator('#idle-status').textContent(), text => /重新计算闲置时间/.test(text),
      'resume explains waiting for fresh input rather than claiming a completed walk');
    await application.evaluate(() => { globalThis.__uiIdle = 0; });
    await until(state, value => !value.status.requireFreshInput, 'new input rearms idle counting');
    await application.evaluate(({ powerMonitor }) => {
      globalThis.__uiIdle = 60;
      powerMonitor.emit('lock-screen');
    });
    await until(state, value => value.status.phase === 'suspended', 'lock suspends the pet');
    await application.evaluate(({ powerMonitor }) => { powerMonitor.emit('unlock-screen'); });
    await until(state, value => value.status.requireFreshInput, 'unlock waits for fresh input');
    await until(() => page.locator('#idle-status').textContent(), text => /重新计算闲置时间/.test(text),
      'unlock displays the same honest waiting state');
    await application.evaluate(() => { globalThis.__uiIdle = 0; });
    await until(state, value => !value.status.requireFreshInput, 'input after unlock rearms counting');
    console.log('Passed: pause/resume and lock/unlock explain the fresh-input requirement.');

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
    await page.screenshot({ path: path.join(output, 'home-minimum.png') });
    await openSettings.click();
    await assertLayout(page, true);
    await assertMinutesFit(page);
    await page.screenshot({ path: path.join(output, 'drawer-minimum.png') });
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

    // A slow failed save must restore its own submitted value without erasing
    // another field, or a newer edit of the same field, still being typed.
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('hare:save-settings');
      ipcMain.handle('hare:save-settings', (_event, patch) => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error(`DELAYED_SAVE_TEST:${Object.keys(patch)[0]}`)), 600);
      }));
    });
    await page.locator('#speed').evaluate(element => {
      element.value = '80';
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#idle-minutes').fill('25');
    await until(() => page.locator('#save-status').textContent(), text => text.includes('DELAYED_SAVE_TEST:speed'), 'delayed save fails');
    assert.equal(await page.locator('#speed').inputValue(), '70', 'failed field restores its persisted value');
    assert.equal(await page.locator('#idle-minutes').inputValue(), '25', 'unrelated focused draft survives the delayed save');

    await page.locator('#idle-minutes').evaluate(element => element.dispatchEvent(new Event('change', { bubbles: true })));
    await page.locator('#idle-minutes').fill('26');
    await until(() => page.locator('#save-status').textContent(), text => text.includes('DELAYED_SAVE_TEST:idleMinutes'), 'same-field older save fails');
    assert.equal(await page.locator('#idle-minutes').inputValue(), '26', 'newer same-field draft survives the older failed save');

    await page.locator('#idle-minutes').fill('12');
    await page.keyboard.press('Escape');
    await sleep(750);
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('hare:action');
      ipcMain.handle('hare:action', () => { throw new Error('当前动作暂时无法完成，请稍后重新打开窗口再试。'.repeat(8)); });
    });
    for (const [width, height] of [[800, 640], [1000, 790]]) {
      await application.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('settings.html')).setSize(...size);
      }, [width, height]);
      await sleep(150);
      await page.locator('#wave-button').click();
      await until(() => page.locator('#interaction-feedback').textContent(), text => text.includes('当前动作暂时'), 'long action failure is visible');
      await assertFeedbackClear(page);
      assert((await page.locator('#interaction-feedback').textContent()).length <= 61, 'error feedback has a bounded length');
      await page.screenshot({ path: path.join(output, `feedback-${width}.png`) });
    }
    assert.deepEqual(errors, [], 'no renderer exceptions');
    console.log('UI smoke passed: scene home, accessible drawer, persistence, live pet actions, movement guards, reduced motion, error recovery, and minimum window layout.');
  } finally {
    await application.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
