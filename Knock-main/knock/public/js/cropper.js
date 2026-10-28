import { h, openModal } from './common.js';

const SIZE = 260; // crop square, in CSS pixels
const OUT = 256; // saved picture: 256 x 256, shown as a circle everywhere
const dpr = Math.min(window.devicePixelRatio || 1, 2);

// Opens a crop dialog for an image file. Resolves with a JPEG Blob (256x256) or null if cancelled.
// The picture is drawn inside a circle so people can see exactly what will fit the round profile picture.
export async function cropAvatar(file, { subject = 'picture', hint = 'Move and zoom so your face sits inside the circle. Everything outside it is cut off.' } = {}) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw Object.assign(new Error('unreadable'), { code: 'unreadable' }); }
  if (!bmp.width || !bmp.height) { bmp.close?.(); throw Object.assign(new Error('unreadable'), { code: 'unreadable' }); }

  const cover = Math.max(SIZE / bmp.width, SIZE / bmp.height); // scale at which the image just covers the square
  let zoom = 1;
  let s = cover;
  let ox = (SIZE - bmp.width * s) / 2;
  let oy = (SIZE - bmp.height * s) / 2;

  const canvas = h('canvas', { class: 'crop-canvas', width: SIZE * dpr, height: SIZE * dpr, tabindex: '0', 'aria-label': 'Crop area. Drag to move the picture, or use the arrow keys. Use the zoom slider to resize.' });
  const ctx = canvas.getContext('2d');
  const slider = h('input', { type: 'range', min: '1', max: '4', step: '0.01', value: '1', 'aria-label': 'Zoom' });

  const clamp = () => {
    ox = Math.min(0, Math.max(SIZE - bmp.width * s, ox));
    oy = Math.min(0, Math.max(SIZE - bmp.height * s, oy));
  };
  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(bmp, ox, oy, bmp.width * s, bmp.height * s);
    ctx.beginPath(); // dim everything outside the circle
    ctx.rect(0, 0, SIZE, SIZE);
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(27, 24, 64, 0.62)';
    ctx.fill('evenodd');
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  };
  const setZoom = (z) => {
    const cx = (SIZE / 2 - ox) / s; // keep the picture's centre point where it is
    const cy = (SIZE / 2 - oy) / s;
    zoom = Math.min(4, Math.max(1, z));
    s = cover * zoom;
    ox = SIZE / 2 - cx * s;
    oy = SIZE / 2 - cy * s;
    clamp();
    slider.value = String(zoom);
    draw();
  };
  const nudge = (dx, dy) => { ox += dx; oy += dy; clamp(); draw(); };

  // Drag (mouse, touch and pen all use pointer events)
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const k = SIZE / canvas.getBoundingClientRect().width; // the canvas can be shrunk by CSS on narrow screens
    nudge((e.clientX - drag.x) * k, (e.clientY - drag.y) * k);
    drag = { x: e.clientX, y: e.clientY };
  });
  const stop = () => { drag = null; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 30 : 10;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) { e.preventDefault(); nudge(...moves[e.key]); }
    else if (e.key === '+' || e.key === '=') setZoom(zoom + 0.1);
    else if (e.key === '-') setZoom(zoom - 0.1);
  });
  slider.addEventListener('input', () => setZoom(Number(slider.value)));

  return new Promise((resolve) => {
    let result = null;
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Use this picture');
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel');
    save.addEventListener('click', () => {
      const out = document.createElement('canvas');
      out.width = out.height = OUT;
      const o = out.getContext('2d');
      o.fillStyle = '#fff';
      o.fillRect(0, 0, OUT, OUT);
      o.imageSmoothingQuality = 'high';
      o.drawImage(bmp, -ox / s, -oy / s, SIZE / s, SIZE / s, 0, 0, OUT, OUT);
      out.toBlob((blob) => { result = blob; m.close(); }, 'image/jpeg', 0.9);
    });
    const m = openModal({ label: `Crop your ${subject}`, onClose: () => { bmp.close?.(); resolve(result); } },
      h('h2', { style: 'font-size:1.5rem;margin-top:.4rem' }, `Crop your ${subject}`),
      h('p', { class: 'hint' }, hint),
      h('div', { class: 'crop-wrap' }, canvas),
      h('label', { style: 'margin-top:.6rem' }, 'Zoom', slider),
      h('div', { class: 'dialog-actions' }, cancel, save));
    draw();
    canvas.focus();
  });
}
