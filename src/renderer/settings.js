import { createScenePlayer } from './scene-player.js';
import { createSceneLayout } from './scene-layout.js';

const bridge = window.hare;
const $ = (id) => document.getElementById(id);
const drawer = $('settings-drawer');
const actor = $('scene-actor');
const scene = createScenePlayer($('scene-pet'));
const sceneLayout = createSceneLayout($('main'), document.querySelector('.room-background'), actor);
const elements = {
  idleMinutes: $('idle-minutes'), petHeight: $('pet-height'), speed: $('speed'),
  displayId: $('display'), alwaysOnTop: $('always-on-top'),
  clickThrough: $('click-through'), launchAtLogin: $('launch-at-login'),
};
const demo = {
  settings: { idleMinutes: 10, petHeight: 156, speed: 70, displayId: 'primary', alwaysOnTop: true, clickThrough: false, launchAtLogin: false, paused: false },
  status: { phase: 'idle', animation: 'idle', idleSeconds: 0, remainingSeconds: 600, moving: false, consumedIdle: false, travelRatio: 0 },
  displays: [{ id: 'primary', label: '主显示器', primary: true }], version: '0.1.1', loginAvailable: true,
};
let state = bridge ? null : demo;
let connection = bridge ? 'loading' : 'demo';
let displaySignature = '';
let saving = 0;
let saveSequence = 0;
const editRevisions = new Map();
const fieldSaves = new Map();
const failedFields = new Map();
const fieldNames = {
  idleMinutes: '闲置时间', petHeight: '角色大小', speed: '散步步调', displayId: '显示器',
  alwaysOnTop: '窗口置顶', clickThrough: '鼠标穿透', launchAtLogin: '登录启动',
};
let feedbackTimer;
let drawerOpener;
const busy = new Set();

function cleanError(value) {
  return String(typeof value === 'string' ? value : value?.message || '请稍后重试')
    .replace(/Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}

function message(text, type = '', detail = '') {
  $('save-status').textContent = text;
  $('save-status').className = type;
  $('save-status').title = detail;
}

function saveMessage() {
  if (failedFields.size) {
    const failures = [...failedFields];
    const [key, error] = failures.at(-1);
    const summary = [...`${fieldNames[key]}（${error}）`];
    const additional = failures.length > 1 ? `；另 ${failures.length - 1} 项未保存` : '';
    message(`未能保存：${summary.slice(0, 60).join('')}${summary.length > 60 ? '…' : ''}${additional}`, 'error',
      failures.map(([field, reason]) => `${fieldNames[field]}：${reason}`).join('；'));
  } else if (saving) message('记下来了，正在保存…', 'pending');
  else message('已经记住了。');
}

function feedback(text, type = '') {
  clearTimeout(feedbackTimer);
  const element = $('interaction-feedback');
  const clean = cleanError(text);
  const characters = [...clean];
  element.textContent = '';
  element.title = '';
  // Leave a paint opportunity between clearing and filling the persistent
  // live region so repeating the same action can be announced again.
  // One timer owns both stages; a newer message or pagehide cancels either.
  feedbackTimer = setTimeout(() => {
    element.textContent = type === 'error' && characters.length > 60 ? `${characters.slice(0, 60).join('')}…` : clean;
    element.title = type === 'error' ? clean : '';
    element.className = `interaction-feedback${type ? ` ${type}` : ''}`;
    feedbackTimer = setTimeout(() => { element.textContent = ''; element.title = ''; }, type === 'error' ? 6000 : 2600);
  }, 50);
}

function durationLabel(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (value < 60) return `${value} 秒`;
  return value % 60 ? `${Math.floor(value / 60)} 分 ${value % 60} 秒` : `${value / 60} 分钟`;
}

function openDrawer(opener, focusThreshold = false) {
  drawerOpener = opener;
  if (!drawer.open) drawer.showModal();
  if (focusThreshold) {
    elements.idleMinutes.focus();
    elements.idleMinutes.select();
  }
}

$('settings-button').addEventListener('click', () => openDrawer($('settings-button')));
$('habits-button').addEventListener('click', () => openDrawer($('habits-button'), true));
$('close-settings').addEventListener('click', () => drawer.close());
let backdropPointer;
let backdropClick = false;
function onBackdrop(event) {
  if (event.target !== drawer) return false;
  const bounds = drawer.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
}
drawer.addEventListener('pointerdown', (event) => {
  backdropPointer = event.button === 0 && onBackdrop(event) ? event.pointerId : undefined;
  backdropClick = false;
});
drawer.addEventListener('pointerup', (event) => {
  backdropClick = event.pointerId === backdropPointer && onBackdrop(event);
  backdropPointer = undefined;
});
drawer.addEventListener('pointercancel', () => { backdropPointer = undefined; backdropClick = false; });
drawer.addEventListener('close', () => {
  backdropPointer = undefined;
  backdropClick = false;
  for (const [key, element] of Object.entries(elements)) {
    if (!element.checkValidity()) element.value = state?.settings?.[key] ?? '';
  }
  drawerOpener?.focus();
});
drawer.addEventListener('click', (event) => {
  if (backdropClick && onBackdrop(event)) drawer.close();
  backdropClick = false;
});

function updateLabels() {
  $('height-output').textContent = `${elements.petHeight.value} DIP`;
  $('speed-output').textContent = `${elements.speed.value} DIP/秒`;
}

function deriveView(settings, status) {
  const phase = status.phase === 'suspended' ? 'suspended' : settings.paused ? 'paused'
    : status.phase === 'returning' ? 'returning' : status.moving ? 'moving'
      : status.requireFreshInput ? 'waiting-input' : status.consumedIdle ? 'rested' : 'idle';
  const moving = phase === 'returning' || phase === 'moving';
  const titles = { suspended: '她也在休息。', paused: '先不走了。', returning: '在往回走。', moving: '出去走走了。' };
  const subtitles = {
    suspended: '等电脑醒来，再继续这份陪伴。',
    paused: '安静陪你一会儿，点「继续」再出发。',
    returning: '这就回到停靠点，继续陪你。',
    moving: '沿着任务栏走一小圈，一会儿回来。',
    'waiting-input': '动动鼠标或按一下键，再重新计算闲置时间。',
    rested: '已经散过步了，现在安静陪你。',
  };
  const elapsed = Math.max(0, Math.floor(Number(status.idleSeconds) || 0));
  const elapsedText = elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;
  const remaining = status.remainingSeconds ?? Math.max(0, settings.idleMinutes * 60 - elapsed);
  return {
    phase, moving, title: titles[phase] || '我在这里。',
    subtitle: subtitles[phase] || (elapsed < 1 ? '你在用电脑，她就在工位等着。'
      : `已闲置 ${elapsedText}，再等 ${durationLabel(remaining)}就去走一圈。`),
    allowed: {
      walk: !moving && !['suspended', 'paused'].includes(phase),
      wave: !moving && phase !== 'suspended', jump: !moving && phase !== 'suspended',
      home: moving, pause: phase !== 'suspended',
    },
  };
}

function renderConnection(next) {
  connection = next;
  const failed = next === 'failed';
  $('phase-label').textContent = failed ? '暂时没连上。' : '正在连接桌面上的她…';
  $('idle-status').textContent = failed ? '没连上桌面上的她，请从托盘重新打开。' : '正在读取她的状态与散步习惯。';
  $('habit-minutes').textContent = '…';
  $('height-output').textContent = '— DIP';
  $('speed-output').textContent = '— DIP/秒';
  for (const element of Object.values(elements)) element.disabled = true;
  for (const name of ['walk', 'wave', 'jump', 'home', 'pause']) $(`${name}-button`).disabled = true;
  $('scene-pet').setAttribute('aria-label', failed ? '尚未连接桌面角色' : '正在连接桌面角色');
  scene.setState({ phase: 'suspended', moving: false });
  message(failed ? '未读取到设置，请从托盘重新打开。' : '正在读取设置…', failed ? 'error' : 'pending');
}

function render(payload, force = false) {
  if (!payload?.settings) return;
  const wasDisconnected = bridge && connection !== 'ready';
  if (bridge) connection = 'ready';
  state = payload;
  const { settings, status = {}, displays = [] } = state;
  const missingDisplay = settings.displayId !== 'primary' && !displays.some(display => String(display.id) === String(settings.displayId))
    ? String(settings.displayId) : null;
  const signature = JSON.stringify([displays, missingDisplay]);
  if (signature !== displaySignature) {
    displaySignature = signature;
    const draft = elements.displayId.value;
    const preserveDraft = !force && (document.activeElement === elements.displayId || saving > 0);
    elements.displayId.replaceChildren();
    const primary = document.createElement('option');
    primary.value = 'primary';
    primary.textContent = '跟随主显示器';
    elements.displayId.append(primary);
    for (const display of displays) {
      if (String(display.id) === 'primary') continue;
      const option = document.createElement('option');
      option.value = String(display.id);
      option.textContent = `${display.label || `显示器 ${display.id}`}${display.primary ? ' · 主屏幕' : ''}`;
      elements.displayId.append(option);
    }
    if (missingDisplay) {
      const disconnected = document.createElement('option');
      disconnected.value = missingDisplay;
      disconnected.textContent = '原屏幕已断开 · 暂用主显示器';
      elements.displayId.append(disconnected);
    }
    const draftStillAvailable = draft === 'primary' || draft === missingDisplay || displays.some(display => String(display.id) === draft);
    elements.displayId.value = preserveDraft && draftStillAvailable ? draft : settings.displayId;
  }
  for (const [key, element] of Object.entries(elements)) {
    element.disabled = false;
    if (!force && (document.activeElement === element || saving > 0)) continue;
    if (element.type === 'checkbox') element.checked = Boolean(settings[key]);
    else element.value = settings[key];
  }
  updateLabels();
  const unavailable = state.loginAvailable === false;
  elements.launchAtLogin.disabled = unavailable;
  $('login-help').textContent = unavailable ? '安装版支持；当前版本请手动启动。' : '随 Windows 登录自动启动。';
  const view = deriveView(settings, status);
  $('phase-label').textContent = view.title;
  $('idle-status').textContent = view.subtitle;
  $('habit-minutes').textContent = `${settings.idleMinutes} 分钟`;
  $('pause-button').textContent = settings.paused ? '继续' : '暂停';
  for (const name of ['walk', 'wave', 'jump', 'home', 'pause']) $(`${name}-button`).disabled = busy.has(name) || !view.allowed[name];
  $('scene-pet').setAttribute('aria-label', `小钩晴的状态预览：${view.title}`);
  const ratio = Math.max(0, Math.min(1, Number(status.travelRatio) || 0));
  actor.style.left = `${40 + ratio * 24}%`;
  actor.classList.toggle('stationary', !view.moving);
  scene.setState({ ...status, phase: view.phase, moving: view.moving, paused: Boolean(settings.paused) });
  if (state.version) $('version').textContent = `v${String(state.version).replace(/^v/, '')}`;
  if (wasDisconnected) message('设置会自动保存');
}

async function save(key, value) {
  if (bridge && connection !== 'ready') return;
  if (!bridge) {
    render({ ...state, settings: { ...state.settings, [key]: value } });
    message('演示模式 · 更改未保存', 'pending');
    return;
  }
  const sequence = ++saveSequence;
  const revision = editRevisions.get(key) || 0;
  fieldSaves.set(key, sequence);
  failedFields.delete(key);
  saving += 1;
  saveMessage();
  try {
    const result = await bridge.saveSettings({ [key]: value });
    if (sequence === saveSequence) {
      state = result || state;
    }
  } catch (error) {
    if (fieldSaves.get(key) === sequence) {
      failedFields.set(key, cleanError(error));
      if (!drawer.open) feedback('这次设置没能保存，请打开设置查看。', 'error');
    }
  } finally {
    saving -= 1;
    // An older acknowledgement must not overwrite a new draft in this or
    // another focused field. Only reconcile the submitted, unchanged draft.
    if (fieldSaves.get(key) === sequence && (editRevisions.get(key) || 0) === revision) {
      const element = elements[key];
      if (element.type === 'checkbox') element.checked = Boolean(state.settings[key]);
      else element.value = state.settings[key];
    }
    if (saving === 0) render(state);
    saveMessage();
  }
}

for (const [key, element] of Object.entries(elements)) {
  element.addEventListener('input', () => editRevisions.set(key, (editRevisions.get(key) || 0) + 1));
  element.addEventListener('change', () => {
    if (!element.checkValidity()) { element.reportValidity(); return; }
    const value = element.type === 'checkbox' ? element.checked : element.type === 'range' || element.type === 'number' ? Number(element.value) : element.value;
    void save(key, value);
  });
}
elements.petHeight.addEventListener('input', updateLabels);
elements.speed.addEventListener('input', updateLabels);

async function perform(name) {
  if (busy.has(name) || (bridge && connection !== 'ready')) return;
  if (!bridge) {
    if (name === 'wave' || name === 'jump') scene.playExpression(name === 'wave' ? 'waving' : 'jumping');
    feedback('这是动作演示，没有控制桌面的她。');
    return;
  }
  busy.add(name);
  render(state);
  try {
    let result = await bridge.action(name);
    const confirmed = Boolean(result?.settings && result?.status);
    if (!confirmed) result = await bridge.getState();
    if (!result?.settings || !result?.status) throw new Error('未能读取动作结果，请从托盘重新打开。');
    render(result);
    const current = deriveView(state.settings, state.status);
    if (name === 'wave' || name === 'jump') {
      if (!current.allowed[name]) feedback('等她回来，再打个招呼吧。');
      else if (!confirmed) feedback('已同步她的状态，暂未确认这个动作。');
      else {
        scene.playExpression(name === 'wave' ? 'waving' : 'jumping');
        feedback(name === 'wave' ? '嗯，看到你了。' : '轻轻跳一下。');
      }
    } else if (name === 'walk') {
      if (current.phase === 'moving') feedback('去走一小圈，一会儿回来。');
      else if (current.phase === 'paused') feedback('散步已暂停，点「继续」后再出发。');
      else if (current.phase === 'suspended') feedback('等电脑醒来，再出去走走。');
      else if (current.phase === 'returning') feedback('她已经在往回走。');
      else feedback('这次没有出发，请稍后再试。');
    } else if (name === 'home') {
      if (current.phase === 'returning') feedback('好，这就回家。');
      else if (current.phase === 'suspended') feedback('等电脑醒来，再回到停靠点。');
      else if (current.moving) feedback('暂时没能返程，请再试一次。');
      else feedback('已经在停靠点了。');
    }
    else feedback(state.settings.paused ? '先安静待一会儿。' : '继续陪你。');
  } catch (error) {
    feedback(`没能完成：${error?.message || '请稍后再试'}`, 'error');
  } finally {
    busy.delete(name);
    render(state);
  }
}
for (const name of ['walk', 'wave', 'jump', 'home', 'pause']) $(`${name}-button`).addEventListener('click', () => void perform(name));

if (!bridge) {
  render(demo);
  $('demo-banner').hidden = false;
  message('演示模式 · 更改未保存', 'pending');
} else {
  renderConnection('loading');
  const unsubscribe = bridge.onState((payload) => render(payload));
  window.addEventListener('pagehide', () => unsubscribe?.(), { once: true });
  bridge.getState().then((payload) => {
    if (!payload?.settings || !payload?.status) throw new Error('未读取到桌宠状态');
    if (connection !== 'ready') render(payload, true);
  }).catch(() => {
    if (connection !== 'ready') renderConnection('failed');
  });
}
window.addEventListener('pagehide', () => { clearTimeout(feedbackTimer); scene.destroy(); sceneLayout.destroy(); }, { once: true });
