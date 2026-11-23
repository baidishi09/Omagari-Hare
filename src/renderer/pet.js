'use strict';

(() => {
  const bridge = window.hare;
  const canvas = document.getElementById('pet');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const atlas = new Image();
  const idleFallback = new Image();
  let manifest;
  let pet = { animation: 'idle', spriteHeight: 156, moving: false };
  let animation = 'idle';
  let animationStarted = performance.now();
  let expression;
  let expressionStarted = 0;
  let lastExpressionToken;
  let lastDraw = '';
  let lastHit = false;
  let lastPointer;
  let pointerDown;
  let dragging = false;
  let nativeDragAcknowledged = false;
  let singleClickTimer;
  let suppressClickUntil = 0;
  let renderTimer;
  let disposed = false;
  const aliases = { wave: 'waving', jump: 'jumping' };

  function sendHit(hit) {
    if (hit === lastHit) return;
    lastHit = hit;
    bridge?.setHitTest(hit);
  }

  function isOpaque(x, y) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || x < 0 || y < 0 || x >= rect.width || y >= rect.height) return false;
    try {
      return context.getImageData(Math.min(canvas.width - 1, Math.floor(x * canvas.width / rect.width)), Math.min(canvas.height - 1, Math.floor(y * canvas.height / rect.height)), 1, 1).data[3] > 32;
    } catch { return false; }
  }

  function updateHit() {
    if (dragging || pointerDown) return sendHit(true);
    sendHit(Boolean(lastPointer && isOpaque(lastPointer.x, lastPointer.y)));
  }

  function resizeCanvas() {
    const height = Number(pet.spriteHeight) || 156;
    const width = height * 192 / 208;
    const ratio = window.devicePixelRatio || 1;
    // CSS derives height from the native window width; the final seven source
    // pixels lie outside the window, leaving the feet exactly on the work area.
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      lastDraw = '';
    }
  }

  function stateFrame(now) {
    let current = animation;
    let started = animationStarted;
    if (expression && !pet.moving) {
      const durations = manifest.states[expression]?.durations;
      const duration = durations?.reduce((total, value) => total + value, 0) || 0;
      if (now - expressionStarted < duration) { current = expression; started = expressionStarted; }
      else expression = undefined;
    }
    if (pet.moving) expression = undefined;
    // Look frames are discrete gazes. Use eight cardinal/intercardinal poses,
    // preserving the character's fixed hairpin side rather than mirroring.
    if (!expression && current === 'idle' && Number.isFinite(pet.gazeAngle) && manifest.look) {
      const lookIndex = ((Math.round(pet.gazeAngle / 45) * 2) % 16 + 16) % 16;
      return { row: manifest.look.startRow + Math.floor(lookIndex / 8), column: lookIndex % 8, delay: 120 };
    }
    const definition = manifest.states[current] || manifest.states.idle;
    const total = definition.durations.reduce((sum, duration) => sum + duration, 0);
    let elapsed = Math.max(0, now - started) % total;
    let column = 0;
    while (column < definition.durations.length - 1 && elapsed >= definition.durations[column]) elapsed -= definition.durations[column++];
    return { row: definition.row, column, delay: Math.max(16, definition.durations[column] - elapsed) };
  }

  function draw() {
    clearTimeout(renderTimer);
    if (disposed || !manifest) return;
    resizeCanvas();
    const frame = stateFrame(performance.now());
    const signature = `${frame.row}/${frame.column}/${canvas.width}/${canvas.height}`;
    if (lastDraw !== signature) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      if (atlas.complete && atlas.naturalWidth) {
        context.drawImage(atlas, frame.column * manifest.frameWidth, frame.row * manifest.frameHeight, manifest.frameWidth, manifest.frameHeight, 0, 0, canvas.width, canvas.height);
      } else if (idleFallback.complete && idleFallback.naturalWidth) {
        context.drawImage(idleFallback, 0, 0, canvas.width, canvas.height);
      }
      lastDraw = signature;
      updateHit();
    }
    renderTimer = setTimeout(draw, Math.min(frame.delay, 200));
  }

  function updatePet(next) {
    if (!next) return;
    // The native payload omits gazeAngle after the pointer moves away.
    pet = { ...pet, gazeAngle: undefined, ...next };
    // Display changes and locking can end a drag in the native process.
    // Release browser capture as well so a later pointerup cannot greet or
    // accidentally restart a drag. dragEnd is intentionally idempotent.
    if (dragging && next.dragging === true) nativeDragAcknowledged = true;
    if (dragging && nativeDragAcknowledged && next.dragging === false) cancelDrag();
    const nextAnimation = next.animation || 'idle';
    if (nextAnimation !== animation) {
      animation = nextAnimation;
      animationStarted = performance.now();
    }
    if (next.expression && (next.expressionToken !== lastExpressionToken || !expression)) {
      const candidate = aliases[next.expression] || next.expression;
      if (next.expressionToken !== undefined && next.expressionToken === lastExpressionToken) return draw();
      lastExpressionToken = next.expressionToken;
      expression = candidate;
      expressionStarted = performance.now();
    }
    draw();
  }

  function action(name) {
    if (bridge) Promise.resolve(bridge.action(name)).catch((error) => console.error('Pet interaction failed', error));
    else updatePet({ expression: aliases[name] || name, expressionToken: performance.now() });
  }

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    lastPointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // A window move or lost native capture can swallow pointerup. Never keep
    // following the cursor once the primary button is no longer held.
    if (pointerDown && (event.buttons & 1) === 0) cancelDrag();
    if (pointerDown && !dragging && Math.hypot(event.screenX - pointerDown.screenX, event.screenY - pointerDown.screenY) >= 4) {
      dragging = true;
      nativeDragAcknowledged = false;
      clearTimeout(singleClickTimer);
      canvas.classList.add('dragging');
      bridge?.dragStart();
    }
    updateHit();
  });
  canvas.addEventListener('pointerleave', () => { lastPointer = undefined; if (!pointerDown) sendHit(false); });
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !isOpaque(event.offsetX, event.offsetY)) return;
    pointerDown = { screenX: event.screenX, screenY: event.screenY, pointerId: event.pointerId };
    canvas.setPointerCapture(event.pointerId);
    sendHit(true);
  });
  canvas.addEventListener('pointerup', (event) => {
    if (event.button !== 0 || !pointerDown) return;
    const wasDragging = dragging;
    pointerDown = undefined;
    dragging = false;
    nativeDragAcknowledged = false;
    canvas.classList.remove('dragging');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (wasDragging) {
      suppressClickUntil = performance.now() + 550;
      bridge?.dragEnd();
    }
    else {
      clearTimeout(singleClickTimer);
      // The browser dblclick event cancels this pending single-click greeting.
      singleClickTimer = setTimeout(() => action('wave'), 500);
    }
    updateHit();
  });
  function cancelDrag() {
    const wasDragging = dragging;
    const capturedPointer = pointerDown?.pointerId;
    clearTimeout(singleClickTimer);
    pointerDown = undefined;
    dragging = false;
    nativeDragAcknowledged = false;
    suppressClickUntil = performance.now() + 550;
    canvas.classList.remove('dragging');
    if (capturedPointer !== undefined && canvas.hasPointerCapture(capturedPointer)) canvas.releasePointerCapture(capturedPointer);
    if (wasDragging) bridge?.dragEnd();
    updateHit();
  }
  canvas.addEventListener('pointercancel', cancelDrag);
  canvas.addEventListener('lostpointercapture', () => { if (pointerDown) cancelDrag(); });
  canvas.addEventListener('dblclick', (event) => {
    event.preventDefault();
    clearTimeout(singleClickTimer);
    if (!dragging && performance.now() >= suppressClickUntil && isOpaque(event.offsetX, event.offsetY)) action('jump');
  });
  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    clearTimeout(singleClickTimer);
    bridge?.openSettings();
  });
  window.addEventListener('resize', draw);
  window.addEventListener('blur', () => { if (pointerDown || dragging) cancelDrag(); });

  atlas.onload = () => { lastDraw = ''; draw(); };
  atlas.onerror = () => { console.error('Unable to load hare animation atlas'); lastDraw = ''; draw(); };
  idleFallback.onload = () => { lastDraw = ''; draw(); };
  atlas.src = '../../assets/hare-atlas.png';
  idleFallback.src = '../../assets/hare-idle.png';
  fetch('../../assets/animations.json').then((response) => {
    if (!response.ok) throw new Error(`Animation manifest: ${response.status}`);
    return response.json();
  }).then((data) => { manifest = data; draw(); }).catch((error) => {
    console.error(error);
    manifest = { frameWidth: 192, frameHeight: 208, states: { idle: { row: 0, durations: [1680, 660, 660, 840, 840, 1920] } } };
    draw();
  });
  const unsubscribe = bridge?.onPet(updatePet);
  bridge?.getState().then((payload) => updatePet({ ...payload.status, spriteHeight: payload.status?.spriteHeight ?? payload.settings.petHeight })).catch(console.error);
  window.addEventListener('unload', () => {
    disposed = true;
    clearTimeout(renderTimer);
    clearTimeout(singleClickTimer);
    unsubscribe?.();
  }, { once: true });
})();
