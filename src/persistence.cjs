const fs = require('node:fs');
const path = require('node:path');
const { normalizeSettings } = require('./core/settings.cjs');

function readSettings(file) {
  try { return { settings: normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8'))), firstRun: false }; }
  catch (error) {
    if (error.code !== 'ENOENT') console.warn('Settings could not be read; using defaults:', error.message);
    return { settings: normalizeSettings({}), firstRun: true };
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(normalizeSettings(settings), null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

module.exports = { readSettings, writeSettings };
