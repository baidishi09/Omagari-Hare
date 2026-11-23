const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, powerMonitor, screen, dialog } = require('electron');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { mergeSettings } = require('./core/settings.cjs');
const { getPatrolGeometry } = require('./core/geometry.cjs');
const { PatrolController } = require('./core/patrol.cjs');
const { readSettings, writeSettings } = require('./persistence.cjs');

const dataArgument = process.argv.find(arg => arg.startsWith('--data-dir='));
if (dataArgument) app.setPath('userData', path.resolve(dataArgument.slice('--data-dir='.length)));
app.setAppUserModelId('io.github.baidishi09.omagarihare');
app.setName('Omagari Hare');

let petWindow, settingsWindow, tray, controller, settings, settingsFile, timer;
let quitting = false;
let suspended = false;
let dragging = null;
let expression = null;
let expressionToken = 0;
let expressionUntil = 0;
let lastPetJSON = '';
let lastTick = performance.now();
let lastStatus = 0;
let idleSeconds = 0;
let hitTest = false;
let lastPlacement = '';
const assets = path.join(__dirname, '..', 'assets');
const renderer = path.join(__dirname, 'renderer');

function selectedDisplay() {
  return screen.getAllDisplays().find(display => String(display.id) === settings.displayId) || screen.getPrimaryDisplay();
}

function payload() {
  const status = controller.snapshot();
  const geometry = getPatrolGeometry(selectedDisplay(), settings);
  const travelRatio = geometry.right > geometry.left
    ? Math.max(0, Math.min(1, (status.x - geometry.left) / (geometry.right - geometry.left))) : 0;
  return {
    settings,
    status: { ...status, idleSeconds, travelRatio },
    displays: screen.getAllDisplays().map((display, index) => ({
      id: String(display.id),
      label: display.label || `屏幕 ${index + 1} · ${display.size.width} × ${display.size.height}`,
      primary: display.id === screen.getPrimaryDisplay().id
    })),
    version: app.getVersion(),
    loginAvailable: app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE
  };
}

function broadcast() {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('hare:state', payload());
}

function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
}

function createPet() {
  const geometry = getPatrolGeometry(selectedDisplay(), settings);
  petWindow = new BrowserWindow({
    x: Math.round(geometry.homeX), y: geometry.y, width: geometry.width, height: geometry.height,
    title: '小钩晴 · 桌面伙伴', frame: false, transparent: true, resizable: false,
    movable: false, hasShadow: false, skipTaskbar: true, focusable: false,
    show: false, alwaysOnTop: settings.alwaysOnTop,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  secureWindow(petWindow);
  updateHitTest();
  petWindow.loadFile(path.join(renderer, 'pet.html'));
  petWindow.once('ready-to-show', () => { if (!suspended) petWindow.showInactive(); sendPet(true); });
  petWindow.on('closed', () => { petWindow = null; if (!quitting) app.quit(); });
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show(); settingsWindow.focus(); return;
  }
  settingsWindow = new BrowserWindow({
    width: 1000, height: 790, minWidth: 800, minHeight: 640,
    title: '小钩晴 · 窗边工位', backgroundColor: '#252b38', autoHideMenuBar: true,
    icon: path.join(assets, 'hare-idle.png'), show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  secureWindow(settingsWindow);
  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(renderer, 'settings.html'));
  settingsWindow.once('ready-to-show', () => { settingsWindow.show(); broadcast(); });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function updateHitTest() {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.setIgnoreMouseEvents(settings.clickThrough || (!hitTest && !dragging), { forward: true });
}

function setExpression(name) {
  if (controller.snapshot().moving) return;
  expression = name;
  expressionToken++;
  expressionUntil = performance.now() + (name === 'jumping' ? 840 : 850);
  sendPet(true);
}

function sendPet(force = false) {
  if (!petWindow || petWindow.isDestroyed() || petWindow.webContents.isLoading()) return;
  const status = controller.snapshot();
  const pet = { ...status, expression, expressionToken, gazeAngle: null, dragging: Boolean(dragging) };
  if (dragging) { pet.animation = 'idle'; pet.moving = false; }
  // Reuse eight established look poses briefly when the pointer is near her face.
  if (!status.moving && !dragging && !expression && !settings.clickThrough && !settings.paused) {
    const cursor = screen.getCursorScreenPoint();
    const bounds = petWindow.getBounds();
    const dx = cursor.x - bounds.x - bounds.width / 2;
    const dy = cursor.y - bounds.y - status.spriteHeight * 0.36;
    const distance = Math.hypot(dx, dy);
    if (distance > 20 && distance < 220) pet.gazeAngle = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  }
  // Position is applied in the native process, never sent every frame unless changing.
  delete pet.x; delete pet.y; delete pet.remainingSeconds;
  const encoded = JSON.stringify(pet);
  if (force || encoded !== lastPetJSON) {
    lastPetJSON = encoded;
    petWindow.webContents.send('hare:pet', pet);
  }
}

function refreshGeometry() {
  if (!controller) return;
  if (dragging) finishDrag();
  lastPlacement = '';
  controller.setGeometry(getPatrolGeometry(selectedDisplay(), settings));
  placePet(); sendPet(true); broadcast();
}

function placePet() {
  if (!petWindow || petWindow.isDestroyed() || dragging) return;
  const status = controller.snapshot();
  // Keep the original DIP dimensions on every move. Reusing getBounds() via
  // setPosition() can compound fractional-DPI rounding and grow the window.
  // One DIP of clearance absorbs native rounding without touching the taskbar.
  const bounds = { x: Math.round(status.x), y: Math.max(selectedDisplay().workArea.y, Math.round(status.y) - 1), width: status.width, height: status.height };
  const placement = JSON.stringify(bounds);
  if (placement !== lastPlacement) {
    petWindow.setBounds(bounds, false);
    lastPlacement = placement;
  }
}

function readLaunchAtLogin(fallback = false) {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) return false;
  try {
    return app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin;
  } catch (error) {
    console.warn('Could not read login registration:', error.message);
    return fallback;
  }
}

function saveSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式无效。');
  const next = mergeSettings(settings, patch);
  // Windows startup settings can change outside this process. A shared portable
  // profile must not hide an installed copy's existing registration, and editing
  // an unrelated preference must never restore a startup entry the user removed.
  const registeredAtLogin = readLaunchAtLogin(settings.launchAtLogin);
  if (!Object.hasOwn(patch, 'launchAtLogin')) next.launchAtLogin = registeredAtLogin;
  const loginChanged = next.launchAtLogin !== registeredAtLogin;
  if (loginChanged && (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE)) {
    throw new Error('开机启动需要先安装安装版；便携版和开发模式请手动启动。');
  }
  const previous = settings;
  writeSettings(settingsFile, next);
  try {
    if (loginChanged) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin, path: process.execPath, args: ['--hidden'] });
  } catch (error) { writeSettings(settingsFile, previous); throw error; }
  settings = next;
  controller.setSettings(settings);
  if (['displayId', 'petHeight', 'homeRatio'].some(key => previous[key] !== settings[key])) {
    controller.setGeometry(getPatrolGeometry(selectedDisplay(), settings));
  }
  if (petWindow) petWindow.setAlwaysOnTop(settings.alwaysOnTop);
  updateHitTest(); updateTray(); placePet(); sendPet(true); broadcast();
  return payload();
}

function act(name) {
  if (name === 'walk') { expression = null; controller.startManualWalk(); }
  else if (name === 'home') { expression = null; controller.returnHome(); }
  else if (name === 'pause') return saveSettings({ paused: !settings.paused });
  else if (name === 'wave') setExpression('waving');
  else if (name === 'jump') setExpression('jumping');
  else throw new Error('未知操作。');
  placePet(); sendPet(true); broadcast();
  return payload();
}

function updateTray() {
  if (!tray) return;
  const safe = handler => () => { try { handler(); } catch (error) { dialog.showErrorBox('小钩晴', error.message); } };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '小钩晴 · 窗边工位', click: openSettings },
    { type: 'separator' },
    { label: '现在散步', enabled: !settings.paused && !suspended, click: safe(() => act('walk')) },
    { label: '回到停靠点', click: safe(() => act('home')) },
    { label: settings.paused ? '继续陪伴' : '暂停散步', click: safe(() => act('pause')) },
    { label: '点击穿透', type: 'checkbox', checked: settings.clickThrough, click: safe(() => saveSettings({ clickThrough: !settings.clickThrough })) },
    { type: 'separator' },
    { label: '退出小钩晴', click: () => app.quit() }
  ]));
}

function isTrusted(event, petOnly = false) {
  const windows = petOnly ? [petWindow] : [petWindow, settingsWindow];
  return windows.some(window => window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
}

function registerIPC() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, value) => {
    if (!isTrusted(event)) throw new Error('无效窗口。');
    return fn(value);
  });
  handle('hare:get-state', payload);
  handle('hare:save-settings', saveSettings);
  handle('hare:action', act);
  ipcMain.on('hare:open-settings', event => { if (isTrusted(event)) openSettings(); });
  ipcMain.on('hare:hit-test', (event, hit) => { if (isTrusted(event, true)) { hitTest = hit === true; updateHitTest(); } });
  ipcMain.on('hare:drag-start', event => {
    if (!isTrusted(event, true) || settings.clickThrough || suspended || dragging) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = petWindow.getBounds();
    dragging = { offset: cursor.x - bounds.x, start: cursor.x, startedAt: performance.now() };
    controller.returnHome(); expression = null; updateHitTest(); sendPet(true);
  });
  ipcMain.on('hare:drag-end', event => { if (isTrusted(event, true)) finishDrag(); });
}

function finishDrag() {
  if (!dragging) return;
  const geometry = getPatrolGeometry(selectedDisplay(), settings);
  const x = petWindow.getBounds().x;
  dragging = null;
  lastPlacement = '';
  const ratio = geometry.right > geometry.left ? (x - geometry.left) / (geometry.right - geometry.left) : 0;
  try {
    saveSettings({ homeRatio: Math.max(0, Math.min(1, ratio)) });
    // Dragging sets a new dock, so reconstruct at that position without a travel jump.
    controller = new PatrolController({ settings, geometry: getPatrolGeometry(selectedDisplay(), settings) });
    controller.tick({ dtSeconds: 0, idleSeconds: 0 });
    placePet(); broadcast();
  } catch (error) { console.error('Could not save dock:', error.message); }
  updateHitTest(); sendPet(true);
}

function setSuspended(value) {
  suspended = value;
  if (dragging) finishDrag();
  controller.setSuspended(value);
  expression = null;
  lastTick = performance.now();
  if (value) petWindow.hide();
  else { refreshGeometry(); petWindow.showInactive(); }
  updateTray(); broadcast();
}

function tick() {
  if (quitting) return;
  const now = performance.now();
  const dtSeconds = Math.min((now - lastTick) / 1000, 0.25);
  lastTick = now;
  if (!suspended) {
    idleSeconds = powerMonitor.getSystemIdleTime();
    if (dragging) {
      const geometry = getPatrolGeometry(selectedDisplay(), settings);
      const cursor = screen.getCursorScreenPoint();
      const x = Math.max(geometry.left, Math.min(geometry.right, cursor.x - dragging.offset));
      petWindow.setBounds({ x: Math.round(x), y: Math.max(selectedDisplay().workArea.y, geometry.y - 1), width: geometry.width, height: geometry.height }, false);
    } else {
      controller.tick({ dtSeconds, idleSeconds });
      placePet();
    }
    if (expression && now >= expressionUntil) expression = null;
    sendPet();
    if (now - lastStatus >= 1000) { broadcast(); lastStatus = now; }
  }
  timer = setTimeout(tick, !suspended && (dragging || controller.snapshot().moving) ? 1000 / 30 : 200);
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { if (controller) openSettings(); });
  app.on('before-quit', () => { quitting = true; clearTimeout(timer); if (tray) tray.destroy(); });
  app.on('window-all-closed', () => {});
  app.whenReady().then(() => {
    settingsFile = path.join(app.getPath('userData'), 'settings.json');
    const loaded = readSettings(settingsFile);
    settings = loaded.settings;
    settings.launchAtLogin = readLaunchAtLogin(settings.launchAtLogin);
    controller = new PatrolController({ settings, geometry: getPatrolGeometry(selectedDisplay(), settings) });
    registerIPC(); createPet();
    tray = new Tray(nativeImage.createFromPath(path.join(assets, 'hare-idle.png')).resize({ width: 30, height: 32 }));
    tray.setToolTip('小钩晴 · 安静陪你工作');
    tray.on('double-click', openSettings); tray.on('click', openSettings);
    updateTray();
    powerMonitor.on('lock-screen', () => setSuspended(true));
    powerMonitor.on('suspend', () => setSuspended(true));
    powerMonitor.on('unlock-screen', () => setSuspended(false));
    powerMonitor.on('resume', () => setSuspended(powerMonitor.getSystemIdleState(1) === 'locked'));
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, refreshGeometry);
    try { writeSettings(settingsFile, settings); } catch (error) { console.warn('Settings are read-only:', error.message); }
    if (!process.argv.includes('--hidden') && (loaded.firstRun || process.argv.includes('--settings'))) openSettings();
    lastTick = performance.now(); tick();
  }).catch(error => { console.error(error); dialog.showErrorBox('小钩晴启动失败', error.message); app.quit(); });
}
