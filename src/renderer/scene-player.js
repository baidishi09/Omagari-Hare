// Uses the desktop pet's artwork and native travelRatio; no simulated patrol.
export function createScenePlayer(canvas) {
  const context = canvas.getContext('2d');
  const atlas = new Image();
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let manifest;
  let state = { animation: 'idle', moving: false, paused: false };
  let animation = 'idle';
  let animationStarted = performance.now();
  let expression;
  let expressionStarted = 0;
  let timer;
  let lastDraw = '';
  let destroyed = false;
  let hiddenAt = null;

  function chooseFrame(now) {
    let current = animation;
    let started = animationStarted;
    if (state.moving || state.phase === 'suspended') expression = undefined;
    if (expression) {
      const durations = manifest.states[expression]?.durations;
      const total = durations?.reduce((sum, duration) => sum + duration, 0) || 0;
      if (now - expressionStarted < total) { current = expression; started = expressionStarted; }
      else expression = undefined;
    }
    const definition = manifest.states[current] || manifest.states.idle;
    // Pausing patrol keeps the desktop pet's idle breathing. Only suspended or
    // reduced-motion previews stop ambient animation.
    if (!expression && (state.phase === 'suspended' || motionPreference.matches)) return { row: definition.row, column: 0, delay: null };
    const total = definition.durations.reduce((sum, duration) => sum + duration, 0);
    let elapsed = Math.max(0, now - started) % total;
    let column = 0;
    while (column < definition.durations.length - 1 && elapsed >= definition.durations[column]) elapsed -= definition.durations[column++];
    return { row: definition.row, column, delay: Math.max(16, definition.durations[column] - elapsed) };
  }

  function render() {
    clearTimeout(timer);
    if (destroyed || document.hidden || !manifest || !atlas.naturalWidth) return;
    const bounds = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(bounds.width * ratio));
    const height = Math.max(1, Math.round(bounds.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; lastDraw = ''; }
    const frame = chooseFrame(performance.now());
    const signature = `${frame.row}/${frame.column}/${width}/${height}`;
    if (signature !== lastDraw) {
      context.clearRect(0, 0, width, height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(atlas, frame.column * manifest.frameWidth, frame.row * manifest.frameHeight, manifest.frameWidth, manifest.frameHeight, 0, 0, width, height);
      lastDraw = signature;
    }
    if (frame.delay !== null) timer = setTimeout(render, frame.delay);
  }

  function visibilityChanged() {
    if (document.hidden) { hiddenAt = performance.now(); clearTimeout(timer); }
    else {
      if (hiddenAt !== null) {
        const elapsed = performance.now() - hiddenAt;
        animationStarted += elapsed;
        // Explicit actions follow elapsed real time, like the desktop pet.
        // Only pause the ambient cycle while this preview is hidden.
        hiddenAt = null;
      }
      render();
    }
  }

  atlas.onload = () => { lastDraw = ''; render(); };
  atlas.onerror = () => console.error('Unable to load the scene animation atlas');
  atlas.src = '../../assets/hare-atlas.png';
  fetch('../../assets/animations.json').then((response) => {
    if (!response.ok) throw new Error(`Animation manifest: ${response.status}`);
    return response.json();
  }).then((value) => { manifest = value; render(); }).catch((error) => console.error(error));
  const observer = new ResizeObserver(render);
  observer.observe(canvas);
  document.addEventListener('visibilitychange', visibilityChanged);
  motionPreference.addEventListener('change', render);

  return {
    setState(next) {
      state = next;
      const nextAnimation = next.moving ? next.animation || (next.direction === 'left' ? 'running-left' : 'running-right') : 'idle';
      if (nextAnimation !== animation) { animation = nextAnimation; animationStarted = performance.now(); }
      render();
    },
    playExpression(name) {
      if (state.moving || state.phase === 'suspended') return false;
      expression = name;
      expressionStarted = performance.now();
      render();
      return true;
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibilityChanged);
      motionPreference.removeEventListener('change', render);
    },
  };
}
