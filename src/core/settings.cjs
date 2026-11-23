'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  idleMinutes: 10,
  speed: 70,
  petHeight: 156,
  displayId: 'primary',
  homeRatio: 0,
  paused: false,
  clickThrough: false,
  alwaysOnTop: true,
  launchAtLogin: false,
});

function bounded(value, fallback, min, max) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value)) : fallback;
}

// Accept only known, typed fields; persisted configuration and renderer IPC
// use this same boundary. Never coerce strings, null, or objects to numbers.
function normalizeSettings(raw = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {
    idleMinutes: bounded(value.idleMinutes, DEFAULT_SETTINGS.idleMinutes, 1, 120),
    speed: bounded(value.speed, DEFAULT_SETTINGS.speed, 20, 180),
    petHeight: Math.round(bounded(value.petHeight, DEFAULT_SETTINGS.petHeight, 96, 240)),
    displayId: (typeof value.displayId === 'string' && /^(primary|-?\d+)$/.test(value.displayId))
      ? value.displayId : DEFAULT_SETTINGS.displayId,
    homeRatio: bounded(value.homeRatio, DEFAULT_SETTINGS.homeRatio, 0, 1),
  };
  for (const key of ['paused', 'clickThrough', 'alwaysOnTop', 'launchAtLogin']) {
    result[key] = typeof value[key] === 'boolean' ? value[key] : DEFAULT_SETTINGS[key];
  }
  return result;
}

function mergeSettings(current, patch) {
  const clean = normalizeSettings(current);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clean;
  const knownPatch = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.hasOwn(patch, key)) knownPatch[key] = patch[key];
  }
  return normalizeSettings({ ...clean, ...knownPatch });
}

module.exports = { DEFAULT_SETTINGS, normalizeSettings, mergeSettings };
