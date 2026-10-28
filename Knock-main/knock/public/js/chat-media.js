import { h, icon, openModal } from './common.js';

export const PICK_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_PICK = 10 * 1024 * 1024; // the file the person picks; it is shrunk before sending
const MAX_SIDE = 1280;

// Shrinks a picked picture to at most 1280 px on its longest side and re-encodes it as JPEG. That keeps uploads small
// and drops anything hidden in the original (location data in photos, animation frames, odd formats).
// Throws { code } with 'invalid_image' (not a picture we can use) or 'image_too_big' (over 10 MB).
export async function prepareChatImage(file) {
  if (!PICK_TYPES.includes(file.type)) throw Object.assign(new Error('invalid_image'), { code: 'invalid_image' });
  if (file.size > MAX_PICK) throw Object.assign(new Error('image_too_big'), { code: 'image_too_big' });
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw Object.assign(new Error('invalid_image'), { code: 'invalid_image' }); }
  try {
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const hgt = Math.max(1, Math.round(bmp.height * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNGs get a white background instead of black
    ctx.fillRect(0, 0, w, hgt);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, hgt);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw Object.assign(new Error('invalid_image'), { code: 'invalid_image' });
    return blob;
  } finally { bmp.close?.(); }
}

export const imageErrorText = (e) => (e?.code === 'image_too_big' ? 'That picture is over 10 MB. Pick a smaller one.' : e?.code === 'invalid_image' ? 'Pick a PNG, JPG, WebP or GIF picture.' : null);

// Sends raw picture bytes (POST for chat pictures, PUT for group pictures) (not JSON) and returns the parsed reply.
export async function uploadChatImage(url, blob, method = 'POST') {
  const res = await fetch(url, { method, headers: { 'Content-Type': blob.type }, body: blob, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: res.status, code: data.error });
  return data;
}

// The little picture button next to the message box. `onPick(file)` gets the chosen file.
export function imagePicker(onPick) {
  const file = h('input', { type: 'file', accept: PICK_TYPES.join(','), hidden: true, 'aria-label': 'Choose a picture to send' });
  const btn = h('button', { class: 'icon-btn chat-img-btn', type: 'button', 'aria-label': 'Send a picture', title: 'Send a picture', onclick: () => file.click() }, icon('image', 18));
  file.addEventListener('change', () => { const f = file.files[0]; file.value = ''; if (f) onPick(f); });
  return [btn, file];
}

// Full-size view of a picture from a chat.
export function openImageViewer(src) {
  const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close picture', onclick: () => m.close() }, icon('x', 16));
  const m = openModal({ label: 'Picture', wide: true }, h('div', { class: 'pop-head' }, h('span', { class: 'grow' }), closeBtn), h('img', { class: 'viewer-img', src, alt: 'Picture from the chat' }));
}
