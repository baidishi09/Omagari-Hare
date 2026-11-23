const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(options = {}) {
  const elements = new Map();
  const calls = [];
  const expressions = [];
  const timers = new Map();
  const lifecycle = new Map();
  let timerId = 0;
  let onState;
  let reads = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', type: id === 'idle-minutes' ? 'number' : 'range', style: {},
      attributes: {}, classList: { toggle() {} }, addEventListener() {},
      setAttribute(name, value) { this.attributes[name] = value; }, replaceChildren() {}, append() {},
    });
    return elements.get(id);
  }
  const state = {
    settings: { idleMinutes: 10, petHeight: 156, speed: 70, displayId: 'primary', paused: false },
    status: { phase: 'idle', remainingSeconds: 600 }, displays: [], loginAvailable: false,
  };
  const context = vm.createContext({
    document: { getElementById: element, querySelector: () => ({}), createElement: () => ({}), activeElement: null },
    window: { hare: {
      saveSettings: patch => new Promise((resolve, reject) => calls.push({ patch, resolve, reject })),
      onState: listener => { onState = listener; },
      getState: () => { reads++; return options.getState ? options.getState() : Promise.resolve(state); },
      action: options.action || (() => Promise.resolve(state)),
    }, addEventListener: (name, listener) => lifecycle.set(name, [...(lifecycle.get(name) || []), listener]) },
    createScenePlayer: () => ({ setState() {}, playExpression: name => expressions.push(name), destroy() {} }),
    createSceneLayout: () => ({ destroy() {} }),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');
  vm.runInContext(source.replace(/^import[^\n]+\n/gm, ''), context);
  return {
    calls, element, state, expressions, emit: payload => onState(payload), reads: () => reads,
    flushFeedback: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); },
    pagehide: () => lifecycle.get('pagehide').forEach(listener => listener()),
    feedback: text => vm.runInContext(`feedback(${JSON.stringify(text)})`, context),
    action: name => vm.runInContext(`perform(${JSON.stringify(name)})`, context),
    save: (key, value) => vm.runInContext(`save(${JSON.stringify(key)}, ${JSON.stringify(value)})`, context),
  };
}

test('an earlier field failure remains visible after a different field succeeds', async () => {
  const ui = harness();
  await Promise.resolve();
  const sizeSave = ui.save('petHeight', 160);
  const idleSave = ui.save('idleMinutes', 12);
  ui.calls[0].reject(new Error('size write failed'));
  await sizeSave;
  ui.calls[1].resolve({ ...ui.state, settings: { ...ui.state.settings, idleMinutes: 12 } });
  await idleSave;
  assert.match(ui.element('save-status').textContent, /角色大小.*size write failed/);
  assert.equal(ui.element('idle-minutes').value, 12);
  assert.equal(ui.element('pet-height').value, 156);
});

test('a stale same-field failure cannot replace the latest successful save', async () => {
  const ui = harness();
  await Promise.resolve();
  const oldSave = ui.save('idleMinutes', 11);
  const newSave = ui.save('idleMinutes', 12);
  ui.calls[1].resolve({ ...ui.state, settings: { ...ui.state.settings, idleMinutes: 12 } });
  await newSave;
  ui.calls[0].reject(new Error('old write failed'));
  await oldSave;
  assert.equal(ui.element('save-status').textContent, '已经记住了。');
  assert.equal(ui.element('idle-minutes').value, 12);
});

test('long save failures remain bounded without exposing IPC wrappers or losing failed fields', async () => {
  const ui = harness();
  await Promise.resolve();
  const size = ui.save('petHeight', 160);
  const idle = ui.save('idleMinutes', 12);
  const wrapper = "Error invoking remote method 'hare:save-settings': Error: ";
  ui.calls[0].reject(new Error(wrapper + '尺寸无法保存。'.repeat(40)));
  await size;
  ui.calls[1].reject(new Error(wrapper + '时间无法保存。'.repeat(40)));
  await idle;
  const status = ui.element('save-status');
  assert(status.textContent.length < 90, 'visible error summary has a bounded length');
  assert.match(status.textContent, /另 1 项未保存/);
  assert.match(status.title, /角色大小.*闲置时间/);
  assert.doesNotMatch(status.textContent + status.title, /Error invoking remote method|hare:save-settings/);
});

test('connection loading and failure stay disabled until a genuine state arrives', async () => {
  let rejectInitial;
  const ui = harness({ getState: () => new Promise((_resolve, reject) => { rejectInitial = reject; }) });
  const fields = ['idle-minutes', 'pet-height', 'speed', 'display', 'always-on-top', 'click-through', 'launch-at-login'];
  const actions = ['walk', 'wave', 'jump', 'home', 'pause'].map(name => `${name}-button`);
  assert.match(ui.element('phase-label').textContent, /正在连接/);
  assert.equal(ui.element('habit-minutes').textContent, '…');
  for (const id of [...fields, ...actions]) assert.equal(ui.element(id).disabled, true, id);
  assert.notEqual(ui.element('close-settings').disabled, true, 'drawer closing remains available');
  rejectInitial(new Error('not connected'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ui.element('idle-status').textContent, /没连上.*托盘重新打开/);
  for (const id of [...fields, ...actions]) assert.equal(ui.element(id).disabled, true, id);
  ui.emit(ui.state);
  assert.equal(ui.element('walk-button').disabled, false);
  assert.equal(ui.element('idle-minutes').disabled, false);
  assert.equal(ui.element('launch-at-login').disabled, true, 'unavailable login setting stays disabled');
  assert.equal(ui.element('habit-minutes').textContent, '10 分钟');
});

test('an initial request failure cannot undo a state received over the live subscription', async () => {
  let rejectInitial;
  const ui = harness({ getState: () => new Promise((_resolve, reject) => { rejectInitial = reject; }) });
  ui.emit({ ...ui.state, settings: { ...ui.state.settings, idleMinutes: 22 } });
  rejectInitial(new Error('late failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.element('habit-minutes').textContent, '22 分钟');
  assert.equal(ui.element('walk-button').disabled, false);
});

test('state precedence keeps headings, descriptions and available actions consistent', async () => {
  const ui = harness();
  await Promise.resolve();
  const rows = [
    { paused: true, status: { phase: 'suspended', moving: true, requireFreshInput: true, consumedIdle: true }, title: '她也在休息。', text: /电脑醒来/, enabled: [] },
    { paused: true, status: { phase: 'returning', moving: true, requireFreshInput: true, consumedIdle: true }, title: '先不走了。', text: /点「继续」/, enabled: ['wave', 'jump', 'pause'] },
    { status: { phase: 'returning', moving: true, requireFreshInput: true, consumedIdle: true }, title: '在往回走。', text: /回到停靠点/, enabled: ['home', 'pause'] },
    { status: { phase: 'outbound', moving: true, requireFreshInput: true, consumedIdle: true }, title: '出去走走了。', text: /任务栏走一小圈/, enabled: ['home', 'pause'] },
    { status: { phase: 'idle', requireFreshInput: true, consumedIdle: true }, title: '我在这里。', text: /重新计算闲置/, enabled: ['walk', 'wave', 'jump', 'pause'] },
    { status: { phase: 'idle', consumedIdle: true }, title: '我在这里。', text: /已经散过步/, enabled: ['walk', 'wave', 'jump', 'pause'] },
    { status: { phase: 'idle', idleSeconds: 0 }, title: '我在这里。', text: /你在用电脑/, enabled: ['walk', 'wave', 'jump', 'pause'] },
    { status: { phase: 'idle', idleSeconds: 73, remainingSeconds: 527 }, title: '我在这里。', text: /已闲置 1 分 13 秒.*8 分 47 秒/, enabled: ['walk', 'wave', 'jump', 'pause'] },
  ];
  for (const row of rows) {
    ui.emit({ ...ui.state, settings: { ...ui.state.settings, paused: Boolean(row.paused) }, status: row.status });
    assert.equal(ui.element('phase-label').textContent, row.title);
    assert.match(ui.element('idle-status').textContent, row.text);
    for (const name of ['walk', 'wave', 'jump', 'home', 'pause']) assert.equal(ui.element(`${name}-button`).disabled, !row.enabled.includes(name), `${row.title}: ${name}`);
    assert.match(ui.element('scene-pet').attributes['aria-label'], new RegExp(row.title));
  }
});

test('missing action payload triggers a state refresh and never invents a confirmed expression', async () => {
  const ui = harness({ action: () => Promise.resolve(undefined) });
  await Promise.resolve();
  await ui.action('wave');
  assert.equal(ui.reads(), 2, 'initial read plus action fallback read');
  assert.deepEqual(ui.expressions, [], 'a fallback snapshot alone does not confirm an expression');
  ui.flushFeedback();
  assert.match(ui.element('interaction-feedback').textContent, /暂未确认/);
  assert.notEqual(ui.element('interaction-feedback').hidden, true);
  ui.flushFeedback();
  assert.equal(ui.element('interaction-feedback').textContent, '', 'persistent live region is cleared instead of hidden');
  assert.notEqual(ui.element('interaction-feedback').hidden, true);
});

test('repeated feedback clears between announcements and newer messages cancel old timers', async () => {
  const ui = harness();
  await Promise.resolve();
  const live = ui.element('interaction-feedback');
  ui.feedback('嗯，看到你了。');
  assert.equal(live.textContent, '', 'announcement begins with an empty live region');
  ui.flushFeedback();
  assert.equal(live.textContent, '嗯，看到你了。');
  ui.feedback('嗯，看到你了。');
  assert.equal(live.textContent, '', 'identical feedback has a distinct empty update');
  ui.flushFeedback();
  assert.equal(live.textContent, '嗯，看到你了。');
  ui.feedback('即将被替换');
  ui.feedback('轻轻跳一下。');
  ui.flushFeedback();
  assert.equal(live.textContent, '轻轻跳一下。', 'only the newest pending feedback is announced');
  ui.flushFeedback();
  assert.equal(live.textContent, '', 'the current message expires normally');
  ui.feedback('不应在离开页面后出现');
  ui.pagehide();
  ui.flushFeedback();
  assert.equal(live.textContent, '', 'page cleanup cancels a pending announcement');
});
