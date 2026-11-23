'use strict';

const { normalizeSettings } = require('./settings.cjs');
const EPSILON = 0.001;

class PatrolController {
  constructor({ settings, geometry }) {
    this.settings = normalizeSettings(settings);
    this.geometry = geometry;
    this.x = geometry.homeX;
    this.phase = this.settings.paused ? 'paused' : 'idle';
    this.direction = 'right';
    this.consumedIdle = false;
    this.suspended = false;
    this.lastIdleSeconds = null;
    this.idleSeconds = 0;
    this.manualAge = null;
    this.requireFreshInput = false;
  }

  snapshot() {
    const moving = !this.suspended && !this.settings.paused
      && ['to-left', 'outbound', 'returning'].includes(this.phase);
    return {
      x: this.x,
      y: this.geometry.y,
      width: this.geometry.width,
      height: this.geometry.height,
      spriteHeight: this.geometry.spriteHeight,
      phase: this.suspended ? 'suspended' : this.phase,
      direction: this.direction,
      animation: moving ? `running-${this.direction}` : 'idle',
      moving,
      consumedIdle: this.consumedIdle,
      requireFreshInput: this.requireFreshInput,
      remainingSeconds: Math.max(0, this.settings.idleMinutes * 60 - this.idleSeconds),
    };
  }

  startManualWalk() {
    if (this.suspended || this.settings.paused) return this.snapshot();
    this.consumedIdle = true;
    this.requireFreshInput = false;
    this.manualAge = 0;
    this.phase = Math.abs(this.x - this.geometry.left) < EPSILON ? 'outbound' : 'to-left';
    this.direction = this.phase === 'outbound' ? 'right' : 'left';
    return this.snapshot();
  }

  returnHome() {
    this.manualAge = null;
    if (this.settings.paused) {
      this.x = this.geometry.homeX;
      this.phase = 'paused';
    } else if (Math.abs(this.x - this.geometry.homeX) < EPSILON) {
      this.x = this.geometry.homeX;
      this.phase = 'idle';
    } else {
      this.phase = 'returning';
      this.direction = this.x < this.geometry.homeX ? 'right' : 'left';
    }
    return this.snapshot();
  }

  setSettings(settings) {
    const wasPaused = this.settings.paused;
    this.settings = normalizeSettings(settings);
    if (this.settings.paused) {
      this.manualAge = null;
      this.x = this.geometry.homeX;
      this.phase = 'paused';
    } else if (wasPaused) {
      this.phase = 'idle';
      this.consumedIdle = true;
      this.requireFreshInput = true;
    }
    return this.snapshot();
  }

  setGeometry(geometry) {
    const wasResting = ['idle', 'paused'].includes(this.phase);
    this.geometry = geometry;
    this.x = wasResting ? geometry.homeX : Math.max(geometry.left, Math.min(geometry.right, this.x));
    // Discard old targets when a screen disappears, taskbar moves, or size
    // changes. Any active patrol finishes by returning to the new home.
    return this.returnHome();
  }

  setSuspended(suspended) {
    if (Boolean(suspended) === this.suspended) return this.snapshot();
    this.suspended = Boolean(suspended);
    if (!this.suspended) {
      this.consumedIdle = true;
      this.requireFreshInput = true;
      this.returnHome();
    }
    return this.snapshot();
  }

  tick({ dtSeconds, idleSeconds }) {
    // Invalid idle samples must never be mistaken for user input or trigger
    // movement. Capping elapsed time prevents a jump after a blocked loop.
    const dt = Number.isFinite(dtSeconds) ? Math.min(0.25, Math.max(0, dtSeconds)) : 0;
    if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return this.snapshot();
    this.idleSeconds = idleSeconds;
    if (this.suspended) return this.snapshot();
    const idleDropped = this.lastIdleSeconds !== null && idleSeconds < this.lastIdleSeconds;
    const active = idleDropped || idleSeconds < 1;
    this.lastIdleSeconds = idleSeconds;
    if (this.manualAge !== null) this.manualAge += dt;
    // The click which starts a manual walk belongs to that walk's current
    // idle episode. It must not rearm an automatic walk ten minutes later.
    const initiatingManualInput = this.manualAge !== null && this.manualAge <= 1.5;
    if (active && !initiatingManualInput) {
      this.consumedIdle = false;
      this.requireFreshInput = false;
    }
    if (this.settings.paused) return this.snapshot();

    const manual = this.manualAge !== null;
    if (['to-left', 'outbound'].includes(this.phase)
        && (manual ? this.manualAge > 1.5 && active
          : idleSeconds < this.settings.idleMinutes * 60)) {
      this.returnHome();
    }

    if (this.phase === 'idle' && !this.consumedIdle && !this.requireFreshInput
        && idleSeconds >= this.settings.idleMinutes * 60) {
      this.consumedIdle = true;
      this.manualAge = null;
      this.phase = Math.abs(this.x - this.geometry.left) < EPSILON ? 'outbound' : 'to-left';
    }
    if (!['to-left', 'outbound', 'returning'].includes(this.phase)) return this.snapshot();

    const target = this.phase === 'to-left' ? this.geometry.left
      : this.phase === 'outbound' ? this.geometry.right : this.geometry.homeX;
    const distance = target - this.x;
    this.direction = distance < 0 ? 'left' : distance > 0 ? 'right' : this.direction;
    const step = this.settings.speed * dt;
    if (Math.abs(distance) <= step + EPSILON) {
      this.x = target;
      if (this.phase === 'to-left') {
        this.phase = 'outbound';
        this.direction = 'right';
      } else if (this.phase === 'outbound') {
        this.phase = 'returning';
        this.direction = this.x <= this.geometry.homeX ? 'right' : 'left';
      } else {
        this.phase = 'idle';
        this.manualAge = null;
      }
    } else {
      this.x += Math.sign(distance) * step;
    }
    return this.snapshot();
  }
}

module.exports = { PatrolController };
