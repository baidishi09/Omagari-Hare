// The scene image uses object-fit: cover and object-position: center bottom.
// Keep the feet on a point inside the illustrated desktop, rather than a fixed
// percentage of the viewport, which changes meaning when the image is cropped.
export function createSceneLayout(room, image, actor) {
  const actions = room.querySelector('.action-bar');
  const sourceFootRatio = 0.84;
  const transparentFootRatio = 7 / 208;
  let disposed = false;

  function update() {
    if (disposed || !image.naturalWidth || !image.naturalHeight) return;
    const scale = Math.max(room.clientWidth / image.naturalWidth, room.clientHeight / image.naturalHeight);
    const sourceBottom = image.naturalHeight * (1 - sourceFootRatio) * scale;
    const actorHeight = actor.clientWidth * 208 / 192;
    room.style.setProperty('--actor-bottom', `${sourceBottom - actorHeight * transparentFootRatio}px`);
    if (actions) room.style.setProperty('--action-bar-height', `${actions.getBoundingClientRect().height}px`);
  }

  const observer = new ResizeObserver(update);
  observer.observe(room);
  observer.observe(actor);
  if (actions) observer.observe(actions);
  image.addEventListener('load', update);
  update();
  return {
    destroy() {
      disposed = true;
      observer.disconnect();
      image.removeEventListener('load', update);
    },
  };
}
