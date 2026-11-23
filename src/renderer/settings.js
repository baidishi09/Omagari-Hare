import { createScenePlayer } from './scene-player.js';

const bridge = window.hare;
const $ = (id) => document.getElementById(id);
const drawer = $('settings-drawer');
const actor = $('scene-actor');
const scene = createScenePlayer($('scene-pet'));
const elements = {
  idleMinutes: $('idle-minutes'), petHeight: $('pet-height'), speed: $('speed'),
  displayId: $('display'), alwaysOnTop: $('always-on-top'),
  clickThrough: $('click-through'), launchAtLogin: $('launch-at-login'),
};
const demo = {
  settings: { idleMinutes: 10, petHeight: 156, speed: 70, displayId: 'primary', alwaysOnTop: true, clickThrough: false, launchAtLogin: false, paused: false },
  status: { phase: 'idle', animation: 'idle', idleSeconds: 0, remainingSeconds: 600, moving: false, consumedIdle: false, travelRatio: 0 },
  displays: [{ id: 'primary', label: '主显示器', primary: true }], version: '0.1.0', loginAvailable: true,
};
let state = demo;
let displaySignature = '';
let saving = 0;
let saveSequence = 0;
let feedbackTimer;
let drawerOpener;
const busy = new Set();

function message(text, type = '') {
  $('save-status').textContent = text;
  $('save-status').className = type;
}

function feedback(text, type = '') {
  clearTimeout(feedbackTimer);
  const element = $('interaction-feedback');
  element.textContent = text;
  element.className = `interaction-feedback${type ? ` ${type}` : ''}`;
  element.hidden = false;
  feedbackTimer = setTimeout(() => { element.hidden = true; }, type === 'error' ? 6000 : 2600);
}

function durationLabel(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  return value >= 60 ? `${Math.ceil(value / 60)} 分钟` : `${value} 秒`;
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
drawer.addEventListener('close', () => drawerOpener?.focus());
drawer.addEventListener('click', (event) => {
  if (event.target !== drawer) return;
  const bounds = drawer.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) drawer.close();
});

function updateLabels() {
  $('height-output').textContent = `${elements.petHeight.value} px`;
  $('speed-output').textContent = `${elements.speed.value} px/s`;
}

function render(payload, force = false) {
  if (!payload?.settings) return;
  state = payload;
  const { settings, status = {}, displays = [] } = state;
  const signature = JSON.stringify([displays, settings.displayId]);
  if (signature !== displaySignature) {
    displaySignature = signature;
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
    if (settings.displayId !== 'primary' && !displays.some((display) => String(display.id) === String(settings.displayId))) {
      const disconnected = document.createElement('option');
      disconnected.value = String(settings.displayId);
      disconnected.textContent = '原屏幕已断开 · 暂用主显示器';
      elements.displayId.append(disconnected);
    }
  }
  for (const [key, element] of Object.entries(elements)) {
    if (!force && (document.activeElement === element || saving > 0)) continue;
    if (element.type === 'checkbox') element.checked = Boolean(settings[key]);
    else element.value = settings[key];
  }
  updateLabels();
  const unavailable = state.loginAvailable === false;
  elements.launchAtLogin.disabled = unavailable;
  $('login-help').textContent = unavailable ? '安装版支持；当前版本请手动启动。' : '随 Windows 登录自动启动。';
  const titles = { idle: '我在这里。', 'to-left': '出去走走了。', outbound: '出去走走了。', returning: '在往回走。', paused: '先不走了。', suspended: '她也在休息。' };
  $('phase-label').textContent = titles[status.phase] || titles.idle;
  $('state-dot').className = `state-dot${settings.paused ? ' paused' : status.moving ? ' moving' : ''}`;
  if (settings.paused) $('idle-status').textContent = '安静陪你一会儿，点「继续」再出发。';
  else if (status.phase === 'suspended') $('idle-status').textContent = '等电脑醒来，再继续这份陪伴。';
  else if (status.phase === 'returning') $('idle-status').textContent = '这就回到停靠点，继续陪你。';
  else if (status.moving) $('idle-status').textContent = '沿着任务栏走一小圈，一会儿回来。';
  else if (status.consumedIdle) $('idle-status').textContent = '已经散过步了，现在安静陪你。';
  else $('idle-status').textContent = `再闲置 ${durationLabel(status.remainingSeconds ?? settings.idleMinutes * 60)}，就去走一圈。`;
  $('habit-minutes').textContent = `${settings.idleMinutes} 分钟`;
  $('pause-button').textContent = settings.paused ? '继续' : '暂停';
  $('pause-button').setAttribute('aria-pressed', String(Boolean(settings.paused)));
  const suspended = status.phase === 'suspended';
  $('walk-button').disabled = busy.has('walk') || Boolean(settings.paused || status.moving || suspended);
  $('wave-button').disabled = busy.has('wave') || Boolean(status.moving || suspended);
  $('jump-button').disabled = busy.has('jump') || Boolean(status.moving || suspended);
  $('home-button').disabled = busy.has('home') || Boolean(suspended || !status.moving);
  $('pause-button').disabled = busy.has('pause') || suspended;
  const ratio = Math.max(0, Math.min(1, Number(status.travelRatio) || 0));
  actor.style.left = `${40 + ratio * 24}%`;
  actor.classList.toggle('stationary', !status.moving);
  scene.setState({ ...status, paused: Boolean(settings.paused) });
  if (state.version) $('version').textContent = `v${String(state.version).replace(/^v/, '')}`;
}

async function save(key, value) {
  if (!bridge) {
    render({ ...state, settings: { ...state.settings, [key]: value } });
    message('演示模式 · 更改未保存', 'pending');
    return;
  }
  const sequence = ++saveSequence;
  saving += 1;
  message('记下来了，正在保存…', 'pending');
  try {
    const result = await bridge.saveSettings({ [key]: value });
    if (sequence === saveSequence) {
      state = result || state;
      message('已经记住了。');
    }
  } catch (error) {
    message(`未能保存：${error?.message || '请稍后重试'}`, 'error');
    if (!drawer.open) feedback('这次设置没能保存，请打开设置查看。', 'error');
  } finally {
    saving -= 1;
    if (saving === 0) render(state, true);
  }
}

for (const [key, element] of Object.entries(elements)) {
  element.addEventListener('change', () => {
    if (!element.checkValidity()) { element.reportValidity(); return; }
    const value = element.type === 'checkbox' ? element.checked : element.type === 'range' || element.type === 'number' ? Number(element.value) : element.value;
    void save(key, value);
  });
}
elements.petHeight.addEventListener('input', updateLabels);
elements.speed.addEventListener('input', updateLabels);

async function perform(name) {
  if (busy.has(name)) return;
  if (!bridge) {
    if (name === 'wave' || name === 'jump') scene.playExpression(name === 'wave' ? 'waving' : 'jumping');
    feedback('这是动作演示，没有控制桌面的她。');
    return;
  }
  busy.add(name);
  render(state);
  try {
    const result = await bridge.action(name);
    if (result) render(result);
    if (name === 'wave' || name === 'jump') {
      if (state.status?.moving || state.status?.phase === 'suspended') feedback('等她回来，再打个招呼吧。');
      else {
        scene.playExpression(name === 'wave' ? 'waving' : 'jumping');
        feedback(name === 'wave' ? '嗯，看到你了。' : '轻轻跳一下。');
      }
    } else if (name === 'walk') feedback('去走一小圈，一会儿回来。');
    else if (name === 'home') feedback('好，这就回家。');
    else feedback(state.settings.paused ? '先安静待一会儿。' : '继续陪你。');
  } catch (error) {
    feedback(`没能完成：${error?.message || '请稍后再试'}`, 'error');
  } finally {
    busy.delete(name);
    render(state);
  }
}
for (const name of ['walk', 'wave', 'jump', 'home', 'pause']) $(`${name}-button`).addEventListener('click', () => void perform(name));

render(demo);
if (!bridge) {
  $('demo-banner').hidden = false;
  message('演示模式 · 更改未保存', 'pending');
} else {
  const unsubscribe = bridge.onState((payload) => render(payload));
  window.addEventListener('unload', () => unsubscribe?.(), { once: true });
  bridge.getState().then((payload) => render(payload, true)).catch((error) => {
    message(`无法读取设置：${error?.message || '请重新打开设置'}`, 'error');
    feedback('暂时没有读到她的状态，请重新打开设置。', 'error');
  });
}
window.addEventListener('unload', () => { clearTimeout(feedbackTimer); scene.destroy(); }, { once: true });
