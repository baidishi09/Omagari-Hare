'use strict';

const { normalizeSettings } = require('./settings.cjs');

const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 208;
const FOOT_Y = 201;

function getPatrolGeometry(display, rawSettings) {
  const settings = normalizeSettings(rawSettings);
  const area = display?.workArea;
  if (!area || ![area.x, area.y, area.width, area.height].every(Number.isFinite)
      || area.width < 1 || area.height < 1) {
    throw new TypeError('A display with a non-empty workArea is required.');
  }
  // Electron screen coordinates are already DIP, including on mixed-DPI
  // monitors. Do not multiply them by display.scaleFactor a second time.
  const scale = Math.min(settings.petHeight / FRAME_HEIGHT,
    area.width / FRAME_WIDTH, area.height / FOOT_Y);
  const spriteHeight = FRAME_HEIGHT * scale;
  const width = Math.max(1, Math.min(Math.floor(area.width), Math.round(FRAME_WIDTH * scale)));
  const height = Math.max(1, Math.min(Math.floor(area.height), Math.round(FOOT_Y * scale)));
  const padding = Math.min(8, Math.floor((area.width - width) / 2));
  const left = Math.round(area.x + padding);
  const right = Math.max(left, Math.round(area.x + area.width - width - padding));
  const homeX = left + (right - left) * settings.homeRatio;
  return {
    left, right, homeX,
    y: Math.round(area.y + area.height - height),
    width, height, spriteHeight, scale,
  };
}

module.exports = { FRAME_WIDTH, FRAME_HEIGHT, FOOT_Y, getPatrolGeometry };
