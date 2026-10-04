// Small shared helpers: escaping, formatting, toasts, dialogs, friendly errors.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Escape ALL dynamic text before putting it into HTML (XSS protection).
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export function money(n) {
  const v = Number(n || 0);
  return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
}
export function fmtDate(d) {
  return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function debounce(fn, ms = 350) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}
export const navigate = path => { location.hash = '#' + path; };

export function toast(msg, type = 'info') {
  const box = document.getElementById('toasts'); if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg; t.setAttribute('role', 'status');
  box.appendChild(t);
  setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 300); }, 3500);
}

export function confirmDialog(title, text, okLabel = 'Confirm') {
  return new Promise(res => {
    const o = document.createElement('div');
    o.className = 'modal';
    o.innerHTML = `<div class="dialog glass" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>
      <div class="row end"><button class="btn ghost" data-x="0">Cancel</button><button class="btn pink" data-x="1">${esc(okLabel)}</button></div></div>`;
    o.addEventListener('click', e => {
      const b = e.target.closest('[data-x]');
      if (b || e.target === o) { o.remove(); res(b?.dataset.x === '1'); }
    });
    document.body.appendChild(o);
    o.querySelector('[data-x="0"]').focus();
  });
}

export const ORDER_STATUS = {
  ORDER_RECEIVED: 'Order Received', CONFIRMED: 'Confirmed', PC_BUILDING: 'PC Building', READY: 'Ready',
  OUT_FOR_DELIVERY: 'Out for Delivery', DELIVERED: 'Delivered', CANCELLED: 'Cancelled',
  RETURN_REQUESTED: 'Return Requested', RETURNED: 'Returned', REFUNDED: 'Refunded'
};
export const PAY_STATUS = {
  PENDING: 'Payment Pending', PAID: 'Paid', FAILED: 'Failed', CANCELLED: 'Cancelled', REFUNDED: 'Refunded', COD_PENDING: 'Pay on Delivery'
};
export const PAY_METHOD = { ONLINE: 'Online Payment', COD: 'Cash on Delivery', PAY_AT_SHOP: 'Pay at Shop' };

const CAT_ICONS = {
  cpu: '🧠', motherboard: '🧩', ram: '💾', gpu: '🎮', ssd: '⚡', hdd: '💽', psu: '🔌', cabinet: '🖥️',
  'cpu-cooler': '❄️', monitor: '🖥️', keyboard: '⌨️', mouse: '🖱️', headset: '🎧', speakers: '🔊',
  'wifi-adapter': '📶', ups: '🔋', accessories: '🧰', 'other-parts': '🛠️'
};
export const catIcon = slug => CAT_ICONS[slug] || '📦';

export function stockBadge(s) {
  const m = { IN_STOCK: ['In stock', 'ok'], LOW_STOCK: ['Few left', 'warn'], OUT_OF_STOCK: ['Out of stock', 'bad'], DISABLED: ['Unavailable', 'bad'] }[s] || ['', ''];
  return m[0] ? `<span class="pill ${m[1]}">${m[0]}</span>` : '';
}

const CODES = {
  AUTH_REQUIRED: 'Please login to continue.',
  ACCOUNT_DISABLED: 'Your account is disabled. Please contact support.',
  INVALID_IDEMPOTENCY_KEY: 'Something went wrong. Please try again.',
  MAINTENANCE: 'The shop is under maintenance. Please try again later.',
  PAYMENT_METHOD_DISABLED: 'This payment method is not available right now.',
  INVALID_ITEMS: 'Your cart has invalid items. Please review your cart.',
  INVALID_QUANTITY: 'Invalid quantity. Please review your cart.',
  INVALID_ADDRESS: 'Please check your address details.',
  INCOMPATIBLE_BUILD: 'This PC build has incompatible parts.',
  PRODUCT_UNAVAILABLE: 'Product is currently unavailable.',
  INSUFFICIENT_STOCK: 'Stock changed. Please review your cart.',
  COUPON_INVALID: 'Coupon could not be applied.',
  PINCODE_NOT_SERVICEABLE: 'Sorry, we do not deliver to this pincode yet.',
  ORDER_NOT_FOUND: 'Order not found.',
  CANNOT_CANCEL: 'This order can no longer be cancelled.',
  FORBIDDEN: 'You do not have permission for this action.'
};
// Turns ANY error into a customer-friendly message (raw DB errors are only logged to console).
export function friendlyError(err) {
  const msg = String(err?.message || err || '');
  if (!navigator.onLine || /failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return 'No internet connection.';
  const m = msg.match(/\b([A-Z][A-Z_]{5,})\b(?::\s*(.+))?/);
  if (m && CODES[m[1]]) {
    const d = (m[2] || '').trim();
    if (m[1] === 'COUPON_INVALID' && d) return d;
    if ((m[1] === 'INSUFFICIENT_STOCK' || m[1] === 'PRODUCT_UNAVAILABLE') && d) return `${CODES[m[1]]} (${d})`;
    if (m[1] === 'INVALID_ADDRESS' && d) return `Please check your address: ${d}`;
    return CODES[m[1]];
  }
  if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (/already registered|already been registered/i.test(msg)) return 'This email is already registered. Please login.';
  if (/profiles_phone_uniq|duplicate key.*phone/i.test(msg)) return 'This phone number is already registered. Please login instead (or use Phone OTP login).';
  if (/email not confirmed/i.test(msg)) return 'Please verify your email first (check your inbox).';
  if (/password should be at least|weak password/i.test(msg)) return 'Password is too weak. Use at least 8 characters.';
  if (/rate limit|too many|over_email_send|over_sms_send/i.test(msg)) return 'Too many attempts. Please wait a minute and try again.';
  if (/sms.*(not.*enabled|disabled)|phone.*provider|unsupported phone/i.test(msg)) return 'Phone login is not set up yet. Please use email login, or contact support.';
  if (/token has expired|invalid.*otp|invalid.*token|otp.*expired/i.test(msg)) return 'That OTP is invalid or expired. Please request a new one.';
  console.error('[app error]', err);
  return 'Something went wrong. Please try again.';
}

// ---- Admin: CSV export ----
export function downloadBlob(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function toCSV(rows) {
  if (!rows || !rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc1 = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc1(r[c])).join(','))].join('\r\n');
}
export function exportCSV(filename, rows) { downloadBlob(filename, toCSV(rows), 'text/csv;charset=utf-8'); }

// ---- Image compression (client-side, before upload) ----
// Resizes to maxDim px and re-encodes as JPEG so phone-camera photos (often 5-15MB)
// upload fast and stay under storage limits. Falls back to the original file
// if the browser can't decode it (e.g. some HEIC photos).
export function compressImage(file, maxDim = 1280, quality = 0.82) {
  return new Promise(resolve => {
    if (!file || !file.type?.startsWith('image/')) return resolve(file);
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale); height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        if (!blob) return resolve(file);
        resolve(new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}
