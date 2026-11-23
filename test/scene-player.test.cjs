const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function createHarness() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/animations.json'), 'utf8'));
  let now = 0;
  let drawnRow;
  let drawnColumn;
  const motion = { matches: false, addEventListener() {}, removeEventListener() {} };
  const listeners = new Map();
  const document = {
    hidden: false,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  };
  const canvas = {
    width: 192, height: 208,
    getBoundingClientRect: () => ({ width: 192, height: 208 }),
    getContext: () => ({ clearRect() {}, drawImage: (_image, x, y) => { drawnRow = y / manifest.frameHeight; drawnColumn = x / manifest.frameWidth; } }),
  };
  const context = vm.createContext({
    document, canvas, console,
    window: { devicePixelRatio: 1, matchMedia: () => motion },
    Image: class { naturalWidth = 1536; set src(_value) { this.onload(); } },
    ResizeObserver: class { observe() {} disconnect() {} },
    performance: { now: () => now },
    fetch: async () => ({ ok: true, json: async () => manifest }),
    setTimeout: () => 1, clearTimeout() {},
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scene-player.js'), 'utf8');
  vm.runInContext(source.replace('export function', 'function'), context);
  const player = vm.runInContext('createScenePlayer(canvas)', context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    manifest, player, motion, row: () => drawnRow, column: () => drawnColumn,
    time: value => { now = value; },
    hidden: value => { document.hidden = value; listeners.get('visibilitychange')(); },
  };
}

test('a hidden preview does not replay an expired explicit action on return', async () => {
  const ui = await createHarness();
  assert.equal(ui.player.playExpression('waving'), true);
  assert.equal(ui.row(), ui.manifest.states.waving.row, 'an explicit wave renders immediately');
  ui.time(100);
  ui.hidden(true);
  ui.time(5000);
  ui.hidden(false);
  assert.equal(ui.row(), ui.manifest.states.idle.row, 'returning after five seconds shows idle, not an expired wave');
  ui.player.destroy();
});

test('patrol pause keeps breathing while suspension and reduced motion remain static', async () => {
  const ui = await createHarness();
  ui.player.setState({ phase: 'paused', paused: true, moving: false });
  assert.equal(ui.column(), 0);
  ui.time(1800);
  ui.player.setState({ phase: 'paused', paused: true, moving: false });
  assert.equal(ui.column(), 1, 'paused patrol advances the idle breathing frame');
  ui.player.setState({ phase: 'suspended', paused: true, moving: false });
  assert.equal(ui.column(), 0, 'suspended preview stays still');
  ui.motion.matches = true;
  ui.player.setState({ phase: 'paused', paused: true, moving: false });
  assert.equal(ui.column(), 0, 'reduced-motion preference remains respected');
  ui.player.destroy();
});
