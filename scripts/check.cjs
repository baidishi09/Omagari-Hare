const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? walk(path.join(dir, item.name)) : [path.join(dir, item.name)]);
}
for (const file of [...walk(path.join(root, 'src')), ...walk(__dirname)].filter(file => /\.(cjs|js)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets/animations.json')));
const png = fs.readFileSync(path.join(root, 'assets/hare-atlas.png'));
assert.equal(png.readUInt32BE(16), manifest.frameWidth * manifest.columns);
assert.equal(png.readUInt32BE(20), manifest.frameHeight * 11);
for (const [state, animation] of Object.entries(manifest.states)) {
  assert(animation.row >= 0 && animation.row < 9, state);
  assert(animation.durations.length > 0 && animation.durations.length <= manifest.columns, state);
  assert(animation.durations.every(duration => duration > 0 && Number.isFinite(duration)), state);
}
assert.equal(manifest.feetY, 201);
console.log('JavaScript syntax and sprite atlas contracts passed.');
