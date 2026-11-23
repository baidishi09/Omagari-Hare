'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, normalizeSettings, mergeSettings } = require('../src/core/settings.cjs');
const { getPatrolGeometry } = require('../src/core/geometry.cjs');
const { PatrolController } = require('../src/core/patrol.cjs');

const display = { workArea: { x: 0, y: 0, width: 800, height: 560 }, scaleFactor: 1 };
function controller(patch = {}) {
  const settings = mergeSettings(DEFAULT_SETTINGS, patch);
  return new PatrolController({ settings, geometry: getPatrolGeometry(display, settings) });
}
function advance(pet, seconds, idleStart = 600) {
  let state;
  for (let i = 0; i < Math.ceil(seconds * 20); i++) {
    state = pet.tick({ dtSeconds: 0.05, idleSeconds: idleStart + i / 20 });
  }
  return state;
}

test('settings have ten-minute default and reject malformed values/unknown fields', () => {
  assert.equal(DEFAULT_SETTINGS.idleMinutes, 10);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  const settings = normalizeSettings({ idleMinutes: '1', speed: Infinity, petHeight: -10,
    homeRatio: 8, displayId: '../../bad', paused: 'false', extra: true });
  assert.equal(settings.idleMinutes, 10);
  assert.equal(settings.speed, 70);
  assert.equal(settings.petHeight, 96);
  assert.equal(settings.homeRatio, 1);
  assert.equal(settings.displayId, 'primary');
  assert.equal(settings.paused, false);
  assert.equal('extra' in settings, false);
  assert.equal(mergeSettings({ ...DEFAULT_SETTINGS, speed: 80 }, { idleMinutes: 1200 }).speed, 80);
  assert.equal(normalizeSettings({ idleMinutes: 1200 }).idleMinutes, 120);
  assert.equal(normalizeSettings({ displayId: '-27831' }).displayId, '-27831');
});

test('feet align to workArea bottom without placing the window on taskbar', () => {
  const area = { x: -1920, y: -300, width: 1920, height: 1040 };
  const g = getPatrolGeometry({ workArea: area, scaleFactor: 1.5 }, DEFAULT_SETTINGS);
  assert.equal(g.width, 144);
  assert.equal(g.height, 151);
  assert.equal(g.spriteHeight, 156);
  assert.equal(g.y + g.height, area.y + area.height);
  assert.equal(g.left, -1912);
  assert.equal(g.right, -152);
  assert.equal(g.homeX, g.left);
  assert.equal(getPatrolGeometry({ workArea: area }, { homeRatio: 0.5 }).homeX,
    (g.left + g.right) / 2);
});

test('very small screens remain contained and invalid screen data is rejected', () => {
  const g = getPatrolGeometry({ workArea: { x: -10, y: 3, width: 20, height: 10 } }, DEFAULT_SETTINGS);
  assert.ok(g.width <= 20 && g.height <= 10);
  assert.ok(g.left >= -10 && g.right + g.width <= 10);
  assert.ok(g.y >= 3 && g.y + g.height <= 13);
  assert.throws(() => getPatrolGeometry({ workArea: { x: 0, y: 0, width: 0, height: 0 } }));
});

test('starts exactly at threshold, walks right and returns once per idle episode', () => {
  const pet = controller();
  assert.equal(pet.tick({ dtSeconds: 0.05, idleSeconds: 599 }).phase, 'idle');
  assert.equal(pet.tick({ dtSeconds: 0.05, idleSeconds: 600 }).phase, 'outbound');
  const phases = new Set();
  let state;
  for (let i = 0; i < 800; i++) {
    state = pet.tick({ dtSeconds: 0.05, idleSeconds: 600 + i / 20 });
    phases.add(state.phase);
  }
  assert.ok(phases.has('outbound') && phases.has('returning'));
  assert.equal(state.phase, 'idle');
  assert.equal(state.x, pet.geometry.homeX);
  assert.equal(state.consumedIdle, true);
  assert.equal(advance(pet, 80, 1000).phase, 'idle');
});

test('activity interrupts outbound motion, returns smoothly, and rearms a future idle episode', () => {
  const pet = controller();
  const before = advance(pet, 3);
  const state = pet.tick({ dtSeconds: 0.05, idleSeconds: 0 });
  assert.equal(state.phase, 'returning');
  assert.equal(state.direction, 'left');
  assert.ok(Math.abs(state.x - before.x) <= 3.51);
  assert.equal(advance(pet, 4, 0).phase, 'idle');
  assert.equal(pet.tick({ dtSeconds: 0.05, idleSeconds: 600 }).phase, 'outbound');
});

test('home at the middle visits left, then right, then returns to that home', () => {
  const pet = controller({ homeRatio: 0.5 });
  assert.equal(pet.tick({ dtSeconds: 0.05, idleSeconds: 600 }).phase, 'to-left');
  const visited = new Set();
  for (let i = 0; i < 800; i++) {
    const state = pet.tick({ dtSeconds: 0.05, idleSeconds: 600 + i / 20 });
    if (state.x === pet.geometry.left) visited.add('left');
    if (state.x === pet.geometry.right) visited.add('right');
  }
  assert.deepEqual(visited, new Set(['left', 'right']));
  assert.equal(pet.snapshot().x, pet.geometry.homeX);
});

test('manual walk ignores initiating click but subsequent activity returns home', () => {
  const pet = controller();
  pet.tick({ dtSeconds: 0, idleSeconds: 50 });
  pet.startManualWalk();
  assert.equal(pet.tick({ dtSeconds: 0.05, idleSeconds: 0 }).phase, 'outbound');
  assert.equal(advance(pet, 2, 0.05).phase, 'outbound');
  assert.equal(pet.tick({ dtSeconds: 0.05, idleSeconds: 0 }).phase, 'returning');
});

test('completed manual walk consumes the same idle episode', () => {
  const pet = controller();
  pet.tick({ dtSeconds: 0, idleSeconds: 50 });
  pet.startManualWalk();
  const state = advance(pet, 30, 0);
  assert.equal(state.phase, 'idle');
  assert.equal(state.consumedIdle, true);
  assert.equal(advance(pet, 10, 600).phase, 'idle');
});

test('pause cancels movement; unpause waits for fresh input', () => {
  const pet = controller();
  advance(pet, 2);
  pet.setSettings({ ...DEFAULT_SETTINGS, paused: true });
  assert.equal(pet.snapshot().phase, 'paused');
  assert.equal(pet.snapshot().x, pet.geometry.homeX);
  assert.equal(pet.startManualWalk().phase, 'paused');
  pet.setSettings(DEFAULT_SETTINGS);
  assert.equal(advance(pet, 2, 900).phase, 'idle');
  pet.tick({ dtSeconds: 0.05, idleSeconds: 0 });
  assert.equal(pet.tick({ dtSeconds: 0.05, idleSeconds: 600 }).phase, 'outbound');
});

test('suspend freezes and resume cannot jump or immediately start a new patrol', () => {
  const pet = controller();
  const before = advance(pet, 3);
  pet.setSuspended(true);
  const sleeping = pet.tick({ dtSeconds: 1000, idleSeconds: 9000 });
  assert.equal(sleeping.phase, 'suspended');
  assert.equal(sleeping.x, before.x);
  pet.setSuspended(false);
  const resumed = pet.tick({ dtSeconds: 1000, idleSeconds: 9001 });
  assert.ok(Math.abs(resumed.x - before.x) <= DEFAULT_SETTINGS.speed * 0.25);
  assert.equal(advance(pet, 60, 9002).phase, 'idle');
  assert.equal(pet.snapshot().x, pet.geometry.homeX);
});

test('geometry changes discard stale route and keep pet inside new monitor', () => {
  const pet = controller();
  advance(pet, 4);
  const geometry = getPatrolGeometry({ workArea: { x: -800, y: 0, width: 800, height: 560 } }, DEFAULT_SETTINGS);
  const state = pet.setGeometry(geometry);
  assert.ok(state.x >= geometry.left && state.x <= geometry.right);
  assert.equal(advance(pet, 20, 604).x, geometry.homeX);
});

test('invalid idle samples do not trigger activity or movement; zero elapsed time is stable', () => {
  const pet = controller();
  const before = pet.snapshot();
  assert.deepEqual(pet.tick({ dtSeconds: 1, idleSeconds: NaN }), before);
  assert.deepEqual(pet.tick({ dtSeconds: 1, idleSeconds: -1 }), before);
  pet.startManualWalk();
  assert.equal(pet.tick({ dtSeconds: -1, idleSeconds: 600 }).x, before.x);
});
