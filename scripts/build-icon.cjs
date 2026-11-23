const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

(async () => {
  const { default: pngToIco } = await import('png-to-ico');
  const assets = path.join(__dirname, '..', 'assets');
  const source = PNG.sync.read(fs.readFileSync(path.join(assets, 'hare-idle.png')));
  const size = Math.max(source.width, source.height);
  const square = new PNG({ width: size, height: size, fill: true });
  PNG.bitblt(source, square, 0, 0, source.width, source.height, Math.floor((size - source.width) / 2), Math.floor((size - source.height) / 2));
  const icon = await pngToIco(PNG.sync.write(square));
  fs.writeFileSync(path.join(assets, 'hare.ico'), icon);
  console.log('Windows icon generated from the existing character artwork.');
})().catch(error => { console.error(error); process.exitCode = 1; });
