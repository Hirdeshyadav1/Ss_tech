// Cart: stored in localStorage as [{id, qty}] (ids only - prices are ALWAYS re-read from the server).
import { sb } from './supabase.js';
import { getSettings } from './settings.js';
import { isLoggedIn, getProfile } from './auth.js';
import { esc, money, round2, toast, friendlyError, navigate, debounce } from './utils.js';

const KEY = 'sstc_cart_v1', COUPON_KEY = 'sstc_coupon';
export const MAX_QTY = 20;
const FIELDS = 'id,name,brand,model,price,discount_percent,final_price,image_url,stock_status,stock_quantity';

export function getCart() { try { const c = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(c) ? c : []; } catch { return []; } }
function saveCart(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch {} window.dispatchEvent(new Event('sstc:cart')); }
export const cartCount = () => getCart().reduce((n, c) => n + c.qty, 0);
export function addToCart(id, qty = 1) {
  const c = getCart(), l = c.find(x => x.id === id);
  if (l) l.qty = Math.min(MAX_QTY, l.qty + qty); else c.push({ id, qty: Math.min(MAX_QTY, qty) });
  saveCart(c);
}
export function setQty(id, qty) { const c = getCart(); const l = c.find(x => x.id === id); if (l) { l.qty = Math.max(1, Math.min(MAX_QTY, qty)); saveCart(c); } }
export function removeFromCart(id) { saveCart(getCart().filter(x => x.id !== id)); }
export function clearCart() { saveCart([]); clearCoupon(); }
export const getCouponCode = () => sessionStorage.getItem(COUPON_KEY) || '';
export const setCouponCode = c => c ? sessionStorage.setItem(COUPON_KEY, c) : sessionStorage.removeItem(COUPON_KEY);
export const clearCoupon = () => sessionStorage.removeItem(COUPON_KEY);

// Read fresh product data for every cart line. A line is "ok" only if active and in stock.
export async function loadLines() {
  const cart = getCart(); if (!cart.length) return [];
  const { data, error } = await sb.from('products').select(FIELDS).in('id', cart.map(c => c.id));
  if (error) throw error;
  const map = new Map((data || []).map(p => [p.id, p]));
  return cart.map(c => {
    const p = map.get(c.id), stock = p ? Number(p.stock_quantity) : 0;
    const ok = !!p && p.stock_status !== 'OUT_OF_STOCK' && p.stock_status !== 'DISABLED' && stock > 0;
    const qty = ok ? Math.min(c.qty, stock, MAX_QTY) : c.qty;
    return { id: c.id, p, ok, qty, stock, adjusted: ok && qty !== c.qty };
  });
}

// Preview maths (mirrors the server). The server recalculates everything when the order is placed.
export function calcTotals(lines, { couponDiscount = 0, tax = {}, delivery = 0 } = {}) {
  let subtotal = 0, discount = 0;
  for (const l of lines) {
    if (!l.ok) continue;
    const gross = Number(l.p.price) * l.qty;
    subtotal += gross; discount += round2(gross * Number(l.p.discount_percent) / 100);
  }
  subtotal = round2(subtotal); discount = round2(discount);
  const base = round2(subtotal - discount - couponDiscount);
  const pct = Number(tax.percent || 0), incl = !!tax.inclusive;
  let taxAmt = 0;
  if (tax.enabled && pct > 0) taxAmt = incl ? round2(base - base / (1 + pct / 100)) : round2(base * pct / 100);
  return { subtotal, discount, couponDiscount, base, tax: taxAmt, taxIncl: incl, taxOn: !!(tax.enabled && pct > 0), delivery, total: round2(base + (incl ? 0 : taxAmt) + delivery) };
}
export function summaryHtml(t, { deliveryLabel = 'Delivery' } = {}) {
  return `<div class="sumrows">
    <div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
    ${t.discount ? `<div class="ok"><span>Discount</span><span>−${money(t.discount)}</span></div>` : ''}
    ${t.couponDiscount ? `<div class="ok"><span>Coupon</span><span>−${money(t.couponDiscount)}</span></div>` : ''}
    ${t.taxOn ? `<div><span>Tax ${t.taxIncl ? '(included)' : ''}</span><span>${money(t.tax)}</span></div>` : ''}
    <div><span>${esc(deliveryLabel)}</span><span>${t.delivery === null ? '—' : (t.delivery ? money(t.delivery) : 'Free')}</span></div>
    <div class="grand"><span>Total</span><span>${money(t.total)}</span></div></div>`;
}
export function lineImg(p) {
  return p?.image_url ? `<img loading="lazy" decoding="async" src="${esc(p.image_url)}" alt="">` : `<div class="noimg">🖥️</div>`;
}

export async function cartPage() {
  const root = document.createElement('div');
  const settings = await getSettings().catch(() => ({}));
  const taxCfg = settings.tax || {};
  let lines = await loadLines();
  let coupon = { code: getCouponCode(), discount: 0, msg: '', valid: false };
  let est = null; // delivery estimate {charge, serviceable}

  const adjusted = lines.filter(l => l.adjusted);
  if (adjusted.length) { adjusted.forEach(l => setQty(l.id, l.qty)); toast('Some quantities were reduced to available stock.'); }

  async function revalidate() {
    if (!coupon.code) return;
    if (!isLoggedIn()) { coupon.msg = 'Login to apply coupon.'; coupon.valid = false; coupon.discount = 0; return; }
    const t0 = calcTotals(lines);
    const { data, error } = await sb.rpc('validate_coupon', { p_code: coupon.code, p_net_amount: t0.base });
    if (error) { coupon.msg = friendlyError(error); coupon.valid = false; coupon.discount = 0; return; }
    coupon.valid = !!data.valid; coupon.discount = data.valid ? Number(data.discount) : 0; coupon.msg = data.message || '';
    if (!data.valid) { setCouponCode(''); coupon.code = ''; }
  }

  function draw() {
    if (!lines.length) {
      root.innerHTML = `<div class="empty"><div class="big">🛒</div><h2>Your cart is empty</h2><p class="muted">Add some parts to get started.</p><a class="btn" href="#/shop">Shop now</a></div>`;
      return;
    }
    const t = calcTotals(lines, { couponDiscount: coupon.discount, tax: taxCfg, delivery: est && est.serviceable ? Number(est.charge) : 0 });
    const anyBad = lines.some(l => !l.ok);
    root.innerHTML = `<h1>Cart</h1><div class="cols">
      <div class="col">${lines.map(l => `
        <div class="card cartline ${l.ok ? '' : 'dim'}">
          <a class="cthumb" href="#/product/${esc(l.id)}">${lineImg(l.p)}</a>
          <div class="cinfo">
            <a class="pname" href="#/product/${esc(l.id)}">${esc(l.p ? l.p.name : 'Unavailable product')}</a>
            ${l.ok ? `<div class="pprice"><b>${money(l.p.final_price)}</b>${Number(l.p.discount_percent) ? `<s>${money(l.p.price)}</s>` : ''}</div>
              <div class="qty"><button class="btn sm ghost" data-dec="${esc(l.id)}" aria-label="Decrease">−</button><span>${l.qty}</span><button class="btn sm ghost" data-inc="${esc(l.id)}" aria-label="Increase" ${l.qty >= Math.min(l.stock, MAX_QTY) ? 'disabled' : ''}>+</button></div>`
              : `<div class="pill bad">Out of stock / unavailable</div>`}
          </div>
          <button class="btn sm ghost" data-rm="${esc(l.id)}" aria-label="Remove">✕</button>
        </div>`).join('')}</div>
      <div class="col side"><div class="card pad">
        <h3>Coupon</h3>
        <div class="row"><input id="cpn" placeholder="Coupon code" value="${esc(coupon.code)}" autocapitalize="characters"><button class="btn sm" id="applycpn">Apply</button></div>
        <div class="formmsg ${coupon.valid ? 'ok' : 'bad'}">${esc(coupon.msg)}</div>
        <h3>Delivery estimate</h3>
        <div class="row"><input id="pin" inputmode="numeric" maxlength="6" placeholder="Pincode" value="${esc(est?.pin || getProfile()?.pincode || '')}"><button class="btn sm ghost" id="chk">Check</button></div>
        <div class="formmsg ${est && !est.serviceable ? 'bad' : 'ok'}">${est ? (est.serviceable ? `Estimated delivery: ${Number(est.charge) ? money(est.charge) : 'Free'}` : 'We do not deliver to this pincode yet.') : ''}</div>
        ${summaryHtml(t, { deliveryLabel: 'Delivery (estimate)' })}
        ${anyBad ? '<div class="formmsg bad">Remove unavailable items to continue.</div>' : ''}
        <button class="btn block" id="go" ${anyBad ? 'disabled' : ''}>Checkout</button>
        <p class="muted small">Final price, stock and delivery are confirmed by our server when you place the order.</p>
      </div></div></div>`;
  }
  const refresh = debounce(async () => { await revalidate().catch(() => {}); draw(); }, 250);

  root.addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    const find = id => lines.find(l => l.id === id);
    if (t.dataset.inc) { const l = find(t.dataset.inc); if (l && l.qty < Math.min(l.stock, MAX_QTY)) { l.qty++; setQty(l.id, l.qty); draw(); refresh(); } }
    else if (t.dataset.dec) { const l = find(t.dataset.dec); if (l && l.qty > 1) { l.qty--; setQty(l.id, l.qty); draw(); refresh(); } }
    else if (t.dataset.rm) { removeFromCart(t.dataset.rm); lines = lines.filter(l => l.id !== t.dataset.rm); draw(); refresh(); }
    else if (t.id === 'applycpn') {
      const code = root.querySelector('#cpn').value.trim().toUpperCase();
      if (!code) { coupon = { code: '', discount: 0, msg: '', valid: false }; setCouponCode(''); return draw(); }
      if (!isLoggedIn()) { toast('Please login to use a coupon.'); return; }
      coupon.code = code; setCouponCode(code); t.disabled = true;
      await revalidate().catch(err => { coupon.msg = friendlyError(err); });
      draw();
    } else if (t.id === 'chk') {
      const pin = root.querySelector('#pin').value.trim();
      if (!/^[0-9]{6}$/.test(pin)) { toast('Enter a 6-digit pincode.'); return; }
      const t0 = calcTotals(lines, { couponDiscount: coupon.discount });
      const { data, error } = await sb.rpc('calc_delivery_charge', { p_amount: t0.base, p_pincode: pin });
      if (error) { toast(friendlyError(error), 'bad'); return; }
      est = { ...data, pin }; draw();
    } else if (t.id === 'go') navigate('/checkout');
  });
  await revalidate().catch(() => {});
  draw();
  return root;
}
