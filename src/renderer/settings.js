'use strict';

(() => {
  const bridge = window.hare;
  const $ = (id) => document.getElementById(id);
  const elements = {
    idleMinutes: $('idle-minutes'), petHeight: $('pet-height'), speed: $('speed'),
    displayId: $('display'), alwaysOnTop: $('always-on-top'),
    clickThrough: $('click-through'), launchAtLogin: $('launch-at-login'),
  };
  const demo = {
    settings: { idleMinutes: 10, petHeight: 156, speed: 70, displayId: 'primary', alwaysOnTop: true, clickThrough: false, launchAtLogin: false, paused: false },
    status: { phase: 'idle', idleSeconds: 0, remainingSeconds: 600, moving: false, consumedIdle: false },
    displays: [{ id: 'primary', label: '主显示器', primary: true }], version: '0.1.0', loginAvailable: true,
  };
  let state = demo;
  let displaySignature = '';
  let saving = 0;
  let updateSequence = 0;
  let statusTimer;

  function message(text, type = '') {
    clearTimeout(statusTimer);
    $('save-status').textContent = text;
    $('save-status').className = type;
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Math.ceil(Number(seconds) || 0));
    if (value < 60) return `${value} 秒`;
    return `${Math.floor(value / 60)} 分 ${String(value % 60).padStart(2, '0')} 秒`;
  }

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
    const loginUnavailable = state.loginAvailable === false;
    elements.launchAtLogin.disabled = loginUnavailable;
    $('login-help').textContent = loginUnavailable ? '安装版支持；当前版本请手动启动' : '随 Windows 登录自动启动';
    const phaseLabels = { idle: '正在安静陪伴', 'to-left': '正朝左边出发', outbound: '正在散步，去看看右边', returning: '正在慢慢回家', paused: '正在休息', suspended: '等待你回来' };
    $('phase-label').textContent = phaseLabels[status.phase] || '正在安静陪伴';
    $('state-dot').className = `state-dot${settings.paused ? ' paused' : status.moving ? ' moving' : ''}`;
    $('pause-button').textContent = settings.paused ? '继续陪伴' : '暂停陪伴';
    $('pause-button').setAttribute('aria-pressed', String(Boolean(settings.paused)));
    $('walk-button').disabled = Boolean(settings.paused || status.phase === 'suspended');
    if (settings.paused) $('idle-status').textContent = '休息一下，随时可以继续';
    else if (status.phase === 'suspended') $('idle-status').textContent = '电脑休息时，她也会暂停活动';
    else if (status.moving) $('idle-status').textContent = '沿着任务栏走一小圈';
    else if (status.consumedIdle) $('idle-status').textContent = '已经散过步了，安静等你回来';
    else $('idle-status').textContent = `再闲置 ${formatDuration(status.remainingSeconds ?? settings.idleMinutes * 60)} 后出发`;
    if (state.version) $('version').textContent = `v${String(state.version).replace(/^v/, '')}`;
  }

  async function save(key, value) {
    if (!bridge) {
      render({ ...state, settings: { ...state.settings, [key]: value } });
      message('预览模式 · 更改未保存', 'pending');
      return;
    }
    const sequence = ++updateSequence;
    saving += 1;
    message('正在保存…', 'pending');
    try {
      const result = await bridge.saveSettings({ [key]: value });
      if (sequence === updateSequence) {
        state = result || state;
        message('已保存', '');
      }
    } catch (error) {
      message(`未能保存：${error?.message || '请稍后重试'}`, 'error');
    } finally {
      saving -= 1;
      if (saving === 0) render(state, true);
    }
  }

  for (const [key, element] of Object.entries(elements)) {
    element.addEventListener('change', () => {
      if (!element.checkValidity()) {
        element.reportValidity();
        return;
      }
      const value = element.type === 'checkbox' ? element.checked : element.type === 'range' || element.type === 'number' ? Number(element.value) : element.value;
      void save(key, value);
    });
  }
  elements.petHeight.addEventListener('input', updateLabels);
  elements.speed.addEventListener('input', updateLabels);

  async function perform(name, button) {
    if (!bridge) {
      message('预览模式 · 请在桌宠程序中体验', 'pending');
      return;
    }
    button.disabled = true;
    try {
      const result = await bridge.action(name);
      if (result) render(result);
      message(name === 'walk' ? '小钩晴出发了' : name === 'home' ? '正在回到停靠点' : '陪伴状态已更新');
    } catch (error) {
      message(`操作未完成：${error?.message || '请稍后重试'}`, 'error');
    } finally {
      button.disabled = false;
      render(state);
    }
  }
  $('walk-button').addEventListener('click', () => void perform('walk', $('walk-button')));
  $('home-button').addEventListener('click', () => void perform('home', $('home-button')));
  $('pause-button').addEventListener('click', () => void perform('pause', $('pause-button')));

  render(demo);
  if (!bridge) {
    $('demo-banner').hidden = false;
    message('预览模式 · 更改未保存', 'pending');
  } else {
    const unsubscribe = bridge.onState((payload) => render(payload));
    window.addEventListener('unload', () => unsubscribe?.(), { once: true });
    bridge.getState().then((payload) => render(payload, true)).catch((error) => message(`无法读取设置：${error?.message || '请重新打开设置'}`, 'error'));
  }
})();
