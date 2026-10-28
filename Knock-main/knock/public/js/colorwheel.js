// A real colour wheel: hue goes around the circle, saturation runs from the centre (white) to the rim,
// and a slider sets brightness. Works with mouse, touch and the keyboard, and has a hex box for exact colours.
import { h } from './common.js';
import { isHex } from './theme-core.js';

const SIZE = 220;
const toHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
export function hsv2rgb(hue, s, v) {
  const f = (n) => { const k = (n + hue / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}
export function hex2hsv(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let hue = 0;
  if (d) hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: hue * 60, s: max ? d / max : 0, v: max };
}

/** @param {string} initial hex colour  @param {(hex:string)=>void} onChange called only when the person changes it */
export function ColorWheel(initial, onChange, { label = 'Colour' } = {}) {
  let { h: hue, s: sat, v: val } = hex2hsv(initial);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = h('canvas', { class: 'wheel', width: SIZE * dpr, height: SIZE * dpr, tabindex: '0', role: 'application',
    'aria-label': `${label} wheel. Left and right arrows change the colour, up and down change how strong it is.` });
  const ctx = canvas.getContext('2d');
  const R = (SIZE * dpr) / 2 - 2 * dpr;
  const C = (SIZE * dpr) / 2;

  const bright = h('input', { type: 'range', min: '0', max: '100', 'aria-label': `${label} brightness`, class: 'bright' });
  const hexIn = h('input', { type: 'text', maxlength: '7', spellcheck: 'false', autocomplete: 'off', 'aria-label': `${label} hex code`, class: 'hex-in' });
  const swatch = h('span', { class: 'wheel-swatch', 'aria-hidden': 'true' });

  const current = () => toHex(...hsv2rgb(hue, sat, val));

  function draw() {
    const img = ctx.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const dx = x - C, dy = y - C, r = Math.hypot(dx, dy);
        if (r > R + 1) continue;
        const a = Math.min(1, R + 1 - r); // soft edge
        const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        const [rr, gg, bb] = hsv2rgb((ang + 360) % 360, Math.min(1, r / R), val);
        const i = (y * canvas.width + x) * 4;
        img.data[i] = rr; img.data[i + 1] = gg; img.data[i + 2] = bb; img.data[i + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const mx = C + Math.cos((hue * Math.PI) / 180) * sat * R;
    const my = C + Math.sin((hue * Math.PI) / 180) * sat * R;
    ctx.beginPath(); ctx.arc(mx, my, 8 * dpr, 0, Math.PI * 2);
    ctx.lineWidth = 4 * dpr; ctx.strokeStyle = '#000'; ctx.stroke();
    ctx.lineWidth = 2 * dpr; ctx.strokeStyle = '#fff'; ctx.stroke();
  }
  function sync({ redraw = true, hexBox = true } = {}) {
    const hx = current();
    bright.value = String(Math.round(val * 100));
    bright.style.setProperty('--to', toHex(...hsv2rgb(hue, sat, 1)));
    swatch.style.background = hx;
    if (hexBox) hexIn.value = hx;
    if (redraw) draw();
  }
  const emit = () => onChange(current());

  function pick(e) {
    const rect = canvas.getBoundingClientRect();
    const dx = ((e.clientX - rect.left) / rect.width) * SIZE - SIZE / 2;
    const dy = ((e.clientY - rect.top) / rect.height) * SIZE - SIZE / 2;
    hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    sat = Math.min(1, Math.hypot(dx, dy) / (R / dpr));
    sync({ redraw: true }); emit();
  }
  let down = false;
  canvas.addEventListener('pointerdown', (e) => { down = true; canvas.setPointerCapture(e.pointerId); canvas.focus(); pick(e); });
  canvas.addEventListener('pointermove', (e) => { if (down) pick(e); });
  canvas.addEventListener('pointerup', () => { down = false; });
  canvas.addEventListener('pointercancel', () => { down = false; });
  canvas.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') hue = (hue - step + 360) % 360;
    else if (e.key === 'ArrowRight') hue = (hue + step) % 360;
    else if (e.key === 'ArrowUp') sat = Math.min(1, sat + step / 100);
    else if (e.key === 'ArrowDown') sat = Math.max(0, sat - step / 100);
    else return;
    e.preventDefault(); sync(); emit();
  });
  bright.addEventListener('input', () => { val = Number(bright.value) / 100; sync(); emit(); });
  hexIn.addEventListener('input', () => {
    let t = hexIn.value.trim();
    if (t && t[0] !== '#') t = '#' + t;
    if (!isHex(t)) return; // wait until it's a full 6-digit code
    ({ h: hue, s: sat, v: val } = hex2hsv(t.toLowerCase()));
    sync({ hexBox: false }); emit();
  });
  hexIn.addEventListener('blur', () => { hexIn.value = current(); });

  sync();
  const el = h('div', { class: 'wheel-box' }, canvas,
    h('div', { class: 'wheel-side' },
      h('label', { class: 'wheel-lbl' }, 'Brightness', bright),
      h('label', { class: 'wheel-lbl' }, 'Hex code', h('span', { class: 'hex-row' }, swatch, hexIn))));
  return {
    el,
    /** Move the wheel to a colour without firing onChange (used when switching which colour is being edited). */
    set(hex) { ({ h: hue, s: sat, v: val } = hex2hsv(hex)); sync(); },
    get value() { return current(); },
  };
}
