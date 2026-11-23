'use strict';

const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
// Every run owns a fresh profile. No installed application's settings, native
// keyboard/mouse input, login registration, or actual power state is changed.
const dataDir = fs.mkdtempSync(path.join(output, 'profile-'));
const errors = [];
const geometryErrors = new Set();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(read, predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await sleep(25);
  } while (Date.now() < deadline);
  assert.fail(`${description}: ${JSON.stringify(value)}`);
}

async function launch() {
  const application = await electron.launch({ args: [root, `--data-dir=${dataDir}`, '--settings'], timeout: 30000 });
  const observe = page => page.on('pageerror', error => errors.push(error.message));
  application.on('window', observe);
  application.windows().forEach(observe);
  try {
    const settingsPage = await waitFor(
      async () => application.windows().find(page => page.url().endsWith('settings.html')),
      Boolean, 'settings window loaded', 10000);
    const petPage = await waitFor(
      async () => application.windows().find(page => page.url().endsWith('pet.html')),
      Boolean, 'transparent pet window loaded', 10000);
    await Promise.all([settingsPage.waitForLoadState('load'), petPage.waitForLoadState('load')]);
    await settingsPage.waitForFunction(() => Boolean(window.hare));
    await petPage.waitForFunction(() => {
      const canvas = document.querySelector('canvas');
      if (!canvas || !canvas.width) return false;
      return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
    });
    await petPage.evaluate(() => {
      window.hare.onPet(payload => { window.__testPetPacket = payload; });
    });
    return { application, settingsPage, petPage };
  } catch (error) {
    await application.close();
    throw error;
  }
}

const getState = page => page.evaluate(() => window.hare.getState());
const save = (page, patch) => page.evaluate(value => window.hare.saveSettings(value), patch);
const action = (page, name) => page.evaluate(value => window.hare.action(value), name);
const setIdle = (application, seconds) => application.evaluate((_electron, value) => { globalThis.__hareTest.idle = value; }, seconds);
const getPetWindow = application => application.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('pet.html'));
  return { bounds: window.getBounds(), visible: window.isVisible(), focusable: window.isFocusable(), webPreferences: window.webContents.getLastWebPreferences() };
});

async function installMocks(application) {
  return application.evaluate(({ powerMonitor, screen }) => {
    const actual = screen.getPrimaryDisplay();
    // Keep all native windows inside the real monitor. Shortening only the
    // exposed work area makes an entire native patrol take about three seconds.
    const display = { ...actual, workArea: { ...actual.workArea, width: Math.min(400, actual.workArea.width) } };
    globalThis.__hareTest = {
      idle: 0, locked: false, display,
      cursor: { x: actual.workArea.x + actual.workArea.width - 1, y: actual.workArea.y },
    };
    powerMonitor.getSystemIdleTime = () => globalThis.__hareTest.idle;
    powerMonitor.getSystemIdleState = () => globalThis.__hareTest.locked ? 'locked' : 'active';
    screen.getPrimaryDisplay = () => globalThis.__hareTest.display;
    screen.getAllDisplays = () => [globalThis.__hareTest.display];
    screen.getCursorScreenPoint = () => globalThis.__hareTest.cursor;
    screen.emit('display-metrics-changed', {}, display, ['workArea']);
    return display.workArea;
  });
}

async function assertContained(application, area) {
  const { bounds } = await getPetWindow(application);
  assert(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width, 'native window stays within horizontal work area');
  const footOffset = bounds.y + bounds.height - area.y - area.height;
  // Windows may round a requested DIP extent at fractional scale factors.
  // At most one DIP above the taskbar is acceptable; overlapping it is not.
  if (footOffset > 0 || footOffset < -1) geometryErrors.add(JSON.stringify({ bounds, area, footOffset }));
  assert(bounds.y >= area.y, 'native window stays above the taskbar');
  return bounds;
}

async function powerEvent(application, event, locked, idle) {
  await application.evaluate(({ powerMonitor }, value) => {
    globalThis.__hareTest.locked = value.locked;
    globalThis.__hareTest.idle = value.idle;
    powerMonitor.emit(value.event);
  }, { event, locked, idle });
}

async function startDrag(application, petPage) {
  const { bounds } = await getPetWindow(application);
  await application.evaluate((_electron, position) => { globalThis.__hareTest.cursor = position; }, { x: bounds.x + 50, y: bounds.y + 50 });
  await petPage.evaluate(() => window.hare.dragStart());
  await petPage.waitForFunction(() => window.__testPetPacket?.dragging === true);
}

async function dragTo(application, area, x) {
  await application.evaluate((_electron, position) => { globalThis.__hareTest.cursor = position; }, { x: x + 50, y: area.y + area.height - 100 });
  await waitFor(() => getPetWindow(application), window => window.bounds.x === Math.round(x), 'dragging follows the mocked cursor');
}

async function resizeWorkArea(application, width) {
  return application.evaluate(({ screen }, value) => {
    globalThis.__hareTest.display.workArea.width = value;
    screen.emit('display-metrics-changed', {}, globalThis.__hareTest.display, ['workArea']);
    return globalThis.__hareTest.display.workArea;
  }, width);
}

async function main() {
  let expectedSettings;
  let session = await launch();
  try {
    const { application, settingsPage, petPage } = session;
    const initial = await getState(settingsPage);
    assert.equal(initial.settings.idleMinutes, 10);
    assert.equal(initial.settings.launchAtLogin, false);
    const pet = await getPetWindow(application);
    assert.equal(pet.focusable, false, 'pet never takes keyboard focus');
    assert.equal(pet.webPreferences.nodeIntegration, false);
    assert.equal(pet.webPreferences.contextIsolation, true);
    assert.equal(pet.webPreferences.sandbox, true);

    let area = await installMocks(application);
    await save(settingsPage, { speed: 180, homeRatio: 0 });
    const home = (await getState(settingsPage)).status.x;
    const bounds = await assertContained(application, area);
    const right = area.x + area.width - bounds.width - 8;
    await setIdle(application, 599);
    await sleep(300);
    assert.equal((await getState(settingsPage)).status.phase, 'idle', '599 seconds cannot trigger a ten-minute patrol');
    await setIdle(application, 600);
    const outbound = await waitFor(() => getState(settingsPage), state => state.status.phase === 'outbound' && state.status.x > home + 20, 'automatic patrol starts at 600 seconds');
    assert.equal(outbound.status.direction, 'right');
    assert.equal(outbound.status.animation, 'running-right');
    await assertContained(application, area);
    const returning = await waitFor(() => getState(settingsPage), state => state.status.phase === 'returning', 'patrol reaches the far edge and turns');
    assert(returning.status.x >= right - 15, 'turn occurs at the right edge, not mid-route');
    assert.equal(returning.status.direction, 'left');
    assert.equal(returning.status.animation, 'running-left');
    await assertContained(application, area);
    const completed = await waitFor(() => getState(settingsPage), state => state.status.phase === 'idle', 'full automatic patrol returns home');
    assert.equal(completed.status.x, home);
    assert.equal(completed.status.consumedIdle, true);
    await setIdle(application, 900);
    await sleep(400);
    assert.equal((await getState(settingsPage)).status.phase, 'idle', 'same continuous idle episode never starts a second patrol');
    console.log('Passed: full automatic patrol, one patrol per idle episode, directional animation.');

    await setIdle(application, 0);
    await waitFor(() => getState(settingsPage), state => !state.status.consumedIdle, 'new input rearms the next idle episode');
    await setIdle(application, 600);
    await waitFor(() => getState(settingsPage), state => state.status.phase === 'outbound' && state.status.x > home + 60, 'second idle episode starts another patrol');
    await setIdle(application, 0);
    const interrupted = await waitFor(() => getState(settingsPage), state => state.status.phase === 'returning', 'new input interrupts outbound patrol');
    assert.equal(interrupted.status.animation, 'running-left');
    const returned = await waitFor(() => getState(settingsPage), state => state.status.phase === 'idle', 'input interruption returns home');
    assert.equal(returned.status.x, home);
    await action(settingsPage, 'walk');
    await sleep(250);
    const manual = await save(settingsPage, { speed: 80, clickThrough: true });
    assert.equal(manual.status.phase, 'outbound', 'initial click grace and non-geometric setting changes preserve manual route');
    await action(settingsPage, 'pause');
    assert.equal((await getState(settingsPage)).status.phase, 'paused');
    await save(settingsPage, { paused: false, clickThrough: false, speed: 180 });
    await sleep(250);
    console.log('Passed: second idle episode, real controller input interruption, manual grace, pause, non-geometric setting changes.');

    await action(settingsPage, 'walk');
    await sleep(250);
    await powerEvent(application, 'lock-screen', true, 800);
    assert.equal((await getState(settingsPage)).status.phase, 'suspended');
    const locked = await getPetWindow(application);
    assert.equal(locked.visible, false, 'pet is hidden while locked');
    await sleep(250);
    assert.deepEqual((await getPetWindow(application)).bounds, locked.bounds, 'locked pet never moves');
    await powerEvent(application, 'suspend', true, 850);
    await powerEvent(application, 'resume', true, 900);
    assert.equal((await getPetWindow(application)).visible, false, 'resume while still locked keeps pet hidden');
    assert.equal((await getState(settingsPage)).status.phase, 'suspended');
    await powerEvent(application, 'unlock-screen', false, 900);
    const unlocked = await getPetWindow(application);
    assert.equal(unlocked.visible, true);
    assert(Math.abs(unlocked.bounds.x - locked.bounds.x) <= 15, 'unlock does not jump across the screen');
    await waitFor(() => getState(settingsPage), state => state.status.phase === 'idle', 'unlock returns to dock');
    await sleep(300);
    assert.equal((await getState(settingsPage)).status.phase, 'idle', 'unlock does not immediately consume the long locked interval as fresh idle');
    await action(settingsPage, 'walk');
    await sleep(180);
    await powerEvent(application, 'suspend', false, 900);
    assert.equal((await getPetWindow(application)).visible, false);
    await powerEvent(application, 'resume', false, 900);
    assert.equal((await getPetWindow(application)).visible, true, 'resume outside lock screen shows the pet again');
    await waitFor(() => getState(settingsPage), state => state.status.phase === 'idle', 'resume outside lock screen returns home');
    console.log('Passed: lock, suspend, locked resume, unlock, unlocked resume, visibility and movement continuity.');

    await setIdle(application, 0);
    await sleep(250);
    await startDrag(application, petPage);
    const dockX = home + (right - home) / 2;
    await dragTo(application, area, dockX);
    await petPage.evaluate(() => window.hare.dragEnd());
    const dragged = await waitFor(() => getState(settingsPage), state => Math.abs(state.settings.homeRatio - 0.5) < 0.001, 'drag release saves the new dock');
    assert.equal(Math.round(dragged.status.x), Math.round(dockX));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).homeRatio, dragged.settings.homeRatio);
    await assertContained(application, area);

    await startDrag(application, petPage);
    await dragTo(application, area, home + 180);
    area = await resizeWorkArea(application, 360);
    await petPage.waitForFunction(() => window.__testPetPacket?.dragging === false);
    const afterGeometry = await assertContained(application, area);
    await application.evaluate((_electron, x) => { globalThis.__hareTest.cursor.x = x; }, area.x + 100);
    await sleep(250);
    assert.equal((await getPetWindow(application)).bounds.x, afterGeometry.x, 'geometry change terminates drag instead of following later cursor movement');
    await action(settingsPage, 'walk');
    await waitFor(() => getState(settingsPage), state => state.status.phase === 'to-left', 'non-left dock starts by moving toward left edge');
    await sleep(200);
    area = await resizeWorkArea(application, 380);
    const rerouted = await getState(settingsPage);
    assert(['returning', 'idle'].includes(rerouted.status.phase), 'display geometry change cancels the old patrol route');
    if (rerouted.status.moving) assert.equal(rerouted.status.animation, 'running-right');
    await waitFor(() => getState(settingsPage), state => state.status.phase === 'idle', 'new geometry returns to adjusted dock');
    await assertContained(application, area);
    console.log('Passed: drag dock persistence, geometry change cancels drag, geometry change cancels stale patrol.');

    expectedSettings = (await save(settingsPage, { idleMinutes: 12, speed: 70 })).settings;
    assert(expectedSettings.homeRatio > 0 && expectedSettings.homeRatio < 1, 'restart exercises a non-default dock');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).idleMinutes, 12);
    await settingsPage.screenshot({ path: path.join(output, 'settings.png') });
    await petPage.screenshot({ path: path.join(output, 'pet.png'), omitBackground: true });
    await settingsPage.close();
    await waitFor(async () => application.windows().length, count => count === 1, 'closing settings leaves pet and tray running');
    assert.deepEqual(errors, [], 'no renderer errors');
  } finally {
    await session.application.close();
  }

  session = await launch();
  try {
    const restored = await getState(session.settingsPage);
    assert.equal(restored.settings.idleMinutes, expectedSettings.idleMinutes, 'same profile restores idle duration after process restart');
    assert.equal(restored.settings.homeRatio, expectedSettings.homeRatio, 'same profile restores dragged dock after process restart');
    assert.equal(restored.settings.speed, expectedSettings.speed);
    const area = await session.application.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    await assertContained(session.application, area);
    assert.deepEqual(errors, [], 'no renderer errors after restart');
    assert.deepEqual([...geometryErrors], [], 'native foot bounds remain within one DIP above the taskbar, never overlapping it');
    console.log('Electron integration passed: real transparent windows, sprites, full automatic patrol, rearming, input interruption, directional animation, taskbar bounds, manual controls, lock/suspend/resume, dragging, monitor changes, tray lifetime, and persisted settings after restart.');
  } finally {
    await session.application.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
