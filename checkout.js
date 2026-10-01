// Checkout: 4 steps (Items -> Delivery details -> Payment method -> Payment screenshot).
// Calls the server function create_order (atomic + duplicate-safe) at the end of step 3.
import { sb } from './supabase.js';
import { getSettings } from './settings.js';
import { getUser, getProfile, requireLogin } from './auth.js';
import { loadLines, calcTotals, summaryHtml, clearCart, getCouponCode, setCouponCode, lineImg } from './cart.js';
import { esc, money, toast, friendlyError, navigate, uuid, compressImage } from './utils.js';
import { payWithRazorpay } from './razorpay.js';

// Idempotency: one key per checkout attempt. Retrying the SAME order re-uses the key, so the
// server returns the existing order instead of creating a duplicate.
function idemKey(sig) {
  try { const s = JSON.parse(sessionStorage.getItem('sstc_idem')); if (s && s.sig === sig) return s.key; } catch {}
  const key = uuid();
  try { sessionStorage.setItem('sstc_idem', JSON.stringify({ sig, key })); } catch {}
  return key;
}

const STEP_LABELS = ['Items', 'Delivery details', 'Payment method', 'Payment screenshot'];

export async function checkoutPage() {
  const user = getUser(); if (!user) { requireLogin('#/checkout'); return document.createElement('div'); }
  const root = document.createElement('div');
  const [settings, lines] = await Promise.all([getSettings().catch(() => ({})), loadLines()]);
  if (!lines.length) { navigate('/cart'); return root; }
  const good = lines.filter(l => l.ok);
  if (good.length !== lines.length) { toast('Please remove unavailable items from your cart.', 'bad'); navigate('/cart'); return root; }

  const pm = settings.payment_methods || {};
  const upi = settings.upi || {};
  const methods = [];
  if (pm.ONLINE) methods.push({ v: 'ONLINE', label: 'Online Payment (UPI)', fulfil: 'DELIVERY', hint: 'Pay via UPI - we will confirm your payment shortly.' });
  if (pm.COD) methods.push({ v: 'COD', label: 'Cash on Delivery', fulfil: 'DELIVERY', hint: 'Pay when your order arrives.' });
  if (pm.PAY_AT_SHOP) methods.push({ v: 'PAY_AT_SHOP', label: 'Pay at Shop (Pickup)', fulfil: 'PICKUP', hint: 'Collect from our shop and pay there.' });

  const p = getProfile() || {};
  let { data: addr } = await sb.from('addresses').select('*').order('is_default', { ascending: false }).order('created_at', { ascending: false }).limit(1).maybeSingle();
  addr = addr || {};
  const v = {
    full_name: addr.full_name || p.full_name || '', phone: addr.phone || p.phone || '', email: user.email || '',
    house_street: addr.house_street || p.address_line || '', area: addr.area || '', city: addr.city || p.city || '',
    state: addr.state || p.state || '', pincode: addr.pincode || p.pincode || '', landmark: addr.landmark || '',
    instructions: '', save: true, method: methods[0]?.v || ''
  };
  const coupon = { code: getCouponCode(), discount: 0 };
  if (coupon.code) {
    const t0 = calcTotals(lines);
    const { data } = await sb.rpc('validate_coupon', { p_code: coupon.code, p_net_amount: t0.base });
    if (data?.valid) coupon.discount = Number(data.discount); else { coupon.code = ''; setCouponCode(''); }
  }

  let step = 1, orderId = null, delivery = { charge: 0, serviceable: true };
  root.innerHTML = `<h1>Checkout</h1>
    <div class="wizard-steps">${STEP_LABELS.map((l, i) => `<span class="${i + 1 === step ? 'on' : ''}" data-dot="${i + 1}">${i + 1}</span>`).join('')}</div>
    <div id="body"></div>`;
  const body = root.querySelector('#body');
  const dots = () => root.querySelectorAll('.wizard-steps span').forEach(el => {
    const i = Number(el.dataset.dot); el.className = i === step ? 'on' : i < step ? 'done' : '';
  });
  const fulfil = () => methods.find(m => m.v === v.method)?.fulfil || 'DELIVERY';

  function drawStep1() {
    const t = calcTotals(lines, { couponDiscount: coupon.discount, tax: settings.tax || {}, delivery: null });
    body.innerHTML = `<div class="card pad">
      ${lines.map(l => `<div class="sline"><div class="cthumb sm">${lineImg(l.p)}</div><div class="grow">${esc(l.p.name)}<div class="muted small">Qty ${l.qty} x ${money(l.p.final_price)}</div></div><b>${money(Number(l.p.final_price) * l.qty)}</b></div>`).join('')}
      ${coupon.code ? `<div class="pill ok">Coupon ${esc(coupon.code)} applied</div>` : ''}
      ${summaryHtml(t, { deliveryLabel: 'Delivery (next step)' })}
      <button class="btn block" id="next">Next: Delivery details</button>
      <p class="muted small">Delivery charge is calculated in the next step using your pincode.</p></div>`;
    body.querySelector('#next').addEventListener('click', () => { step = 2; draw(); });
  }

  function drawStep2() {
    const input = (id, label, val_, attrs = '') => `<label>${label}<input id="${id}" value="${esc(val_)}" ${attrs}></label>`;
    body.innerHTML = `<form id="f2" novalidate class="card pad">
      ${input('full_name', 'Full name', v.full_name, 'autocomplete="name"')}
      <div class="two">${input('phone', 'Phone', v.phone, 'type="tel" inputmode="tel" autocomplete="tel"')}${input('email', 'Email', v.email, 'type="email" readonly')}</div>
      ${input('house_street', 'House / Street', v.house_street, 'autocomplete="address-line1"')}
      ${input('area', 'Area', v.area, 'autocomplete="address-line2"')}
      <div class="two">${input('city', 'City', v.city, 'autocomplete="address-level2"')}${input('state', 'State', v.state, 'autocomplete="address-level1"')}</div>
      <div class="two">${input('pincode', 'Pincode', v.pincode, 'inputmode="numeric" maxlength="6" autocomplete="postal-code"')}${input('landmark', 'Landmark', v.landmark)}</div>
      <label>Delivery instructions<textarea id="instructions" rows="2" maxlength="300">${esc(v.instructions)}</textarea></label>
      <label class="check"><input type="checkbox" id="save" ${v.save ? 'checked' : ''}> Save this address for next time</label>
      <div class="formmsg" role="alert"></div>
      <div class="row"><button type="button" class="btn ghost" id="back">Back</button><button class="btn grow" type="submit">Next: Payment method</button></div>
    </form>`;
    const f = body.querySelector('#f2'), msg = f.querySelector('.formmsg');
    const bad = t => { msg.textContent = t; msg.className = 'formmsg bad'; };
    body.querySelector('#back').addEventListener('click', () => { step = 1; draw(); });
    f.addEventListener('submit', e => {
      e.preventDefault();
      const g = id => f.querySelector('#' + id).value.trim();
      if (g('full_name').length < 2) return bad('Please enter your full name.');
      if (!/^[0-9+ -]{8,15}$/.test(g('phone'))) return bad('Please enter a valid phone number.');
      if (!g('house_street')) return bad('Please enter house / street.');
      if (!g('city') || !g('state')) return bad('Please enter city and state.');
      if (!/^[0-9]{6}$/.test(g('pincode'))) return bad('Please enter a valid 6-digit pincode.');
      Object.assign(v, {
        full_name: g('full_name'), phone: g('phone'), house_street: g('house_street'), area: g('area'),
        city: g('city'), state: g('state'), pincode: g('pincode'), landmark: g('landmark'),
        instructions: g('instructions'), save: f.querySelector('#save').checked
      });
      step = 3; draw();
    });
  }

  // Manual UPI (no Razorpay): the order is placed ONLY together with a payment screenshot.
  const needsScreenshot = () => v.method === 'ONLINE' && !(settings.razorpay?.enabled && settings.razorpay?.key_id);
  const currentTotal = () => calcTotals(lines, { couponDiscount: coupon.discount, tax: settings.tax || {}, delivery: fulfil() === 'PICKUP' ? 0 : (delivery.serviceable ? Number(delivery.charge) : 0) });

  async function createOrder() {
    const address = {
      full_name: v.full_name, phone: v.phone, email: v.email, house_street: v.house_street, area: v.area,
      city: v.city, state: v.state, pincode: v.pincode, landmark: v.landmark, instructions: v.instructions, fulfilment: fulfil()
    };
    const items = lines.map(l => ({ product_id: l.id, quantity: l.qty }));
    const sig = JSON.stringify([items, v.method, coupon.code, address.pincode, address.house_street, address.fulfilment]);
    const { data, error } = await sb.rpc('create_order', {
      p_idempotency_key: idemKey(sig), p_items: items, p_address: address, p_payment_method: v.method, p_coupon_code: coupon.code || null
    });
    if (error) throw error;
    return data;
  }
  function finishOrder() {
    if (v.save) {
      sb.from('addresses').insert({ user_id: user.id, label: 'Home', full_name: v.full_name, phone: v.phone, house_street: v.house_street,
        area: v.area || null, city: v.city, state: v.state, pincode: v.pincode, landmark: v.landmark || null, is_default: true }).then(() => {});
    }
    try { sessionStorage.removeItem('sstc_idem'); } catch {}
    clearCart();
  }
  async function uploadShot(oid, small) {
    const path = `${oid}/${Date.now()}-${small.name.replace(/[^\w.-]/g, '_')}`;
    const { error: upErr } = await sb.storage.from('payment-screenshots').upload(path, small, { contentType: small.type });
    if (upErr) throw upErr;
    const { data: pub } = sb.storage.from('payment-screenshots').getPublicUrl(path);
    const { error: insErr } = await sb.from('payment_screenshots').insert({ order_id: oid, url: pub.publicUrl });
    if (insErr) throw insErr;
  }

  function drawStep3() {
    body.innerHTML = `<form id="f3" novalidate class="card pad">
      ${methods.length ? methods.map((m, i) => `<label class="radio card"><input type="radio" name="pay" value="${m.v}" ${m.v === v.method ? 'checked' : ''}><span><b>${esc(m.label)}</b><br><span class="muted small">${esc(m.hint)}</span></span></label>`).join('')
        : '<div class="formmsg bad">No payment method is available right now. Please contact support.</div>'}
      <div id="sum"></div>
      <div class="formmsg" id="msg" role="alert"></div>
      <div class="row"><button type="button" class="btn ghost" id="back">Back</button></div>
    </form>`;
    const f = body.querySelector('#f3'), msg = body.querySelector('#msg');
    const bad = t => { msg.textContent = t; msg.className = 'formmsg bad'; msg.scrollIntoView({ block: 'center' }); };
    let busy = false;

    function drawSummary() {
      const t = currentTotal();
      const blocked = fulfil() === 'DELIVERY' && !delivery.serviceable;
      body.querySelector('#sum').innerHTML = `${summaryHtml(t, { deliveryLabel: fulfil() === 'PICKUP' ? 'Pickup' : 'Delivery' })}
        ${blocked ? '<div class="formmsg bad">We do not deliver to this pincode yet.</div>' : ''}
        <button class="btn block" id="place" ${busy || blocked || !v.method ? 'disabled' : ''}>${busy ? 'Placing order...' : needsScreenshot() ? 'Next: Payment screenshot' : `Place order - ${money(t.total)}`}</button>
        <p class="muted small">${needsScreenshot() ? 'Your order is placed after you upload your UPI payment screenshot.' : 'Prices, stock and delivery are re-checked securely when you place the order.'}</p>`;
      body.querySelector('#place')?.addEventListener('click', placeOrder);
    }
    async function updateDelivery() {
      if (fulfil() === 'PICKUP') { delivery = { charge: 0, serviceable: true }; return drawSummary(); }
      const base = calcTotals(lines, { couponDiscount: coupon.discount }).base;
      const { data, error } = await sb.rpc('calc_delivery_charge', { p_amount: base, p_pincode: v.pincode });
      if (!error && data) delivery = data;
      drawSummary();
    }
    body.querySelector('#back').addEventListener('click', () => { step = 2; draw(); });
    f.addEventListener('change', e => { if (e.target.name === 'pay') { v.method = e.target.value; updateDelivery(); } });
    f.addEventListener('submit', e => e.preventDefault());

    async function placeOrder() {
      if (busy) return;
      if (!navigator.onLine) return bad('No internet connection.');
      if (!v.method) return bad('Please choose a payment method.');
      if (needsScreenshot()) { step = 4; draw(); return; }
      busy = true; drawSummary();
      try {
        const data = await createOrder();
        finishOrder();
        orderId = data.order_id;
        toast('Order placed!', 'ok');
        if (v.method === 'ONLINE') {
          const result = await payWithRazorpay(orderId, { name: v.full_name, phone: v.phone, email: v.email, orderNumber: data.order_number });
          if (result === 'paid') toast('Payment successful!', 'ok');
          else toast('Payment not completed. You can retry from your order page.');
        }
        navigate(`/order/${orderId}?placed=1`);
      } catch (err) {
        busy = false; drawSummary();
        const text = friendlyError(err);
        bad(text);
        if (/Stock changed|unavailable/i.test(text)) setTimeout(() => navigate('/cart'), 1800);
      }
    }
    updateDelivery();
  }

  // Step 4 (manual UPI only): choose screenshot -> it uploads automatically and the order is placed.
  function drawStep4() {
    const t = currentTotal();
    body.innerHTML = `<div class="card pad">
      <div class="upibox">
        ${upi.qr_url ? `<img src="${esc(upi.qr_url)}" alt="UPI QR code" class="upiqr">` : ''}
        ${upi.upi_id ? `<div class="upiid">UPI ID: <b>${esc(upi.upi_id)}</b></div>` : ''}
        <p>Pay <b>${money(t.total)}</b> using any UPI app, then choose your payment screenshot below.</p>
      </div>
      <label class="filebtn block">Choose payment screenshot<input type="file" id="ssfile" accept="image/png,image/jpeg,image/webp" hidden></label>
      <div class="formmsg" id="ssmsg" role="alert"></div>
      <p class="muted small">Your order is placed automatically as soon as the screenshot is uploaded. Without a screenshot, no order is placed.</p>
      <div class="row"><button type="button" class="btn ghost" id="back">Back</button></div></div>`;
    const msg = body.querySelector('#ssmsg'), input = body.querySelector('#ssfile');
    let uploading = false;
    body.querySelector('#back').addEventListener('click', () => { if (!uploading) { step = 3; draw(); } });
    input.addEventListener('change', async () => {
      const file = input.files[0]; if (!file || uploading) return;
      uploading = true; msg.textContent = 'Uploading screenshot and placing your order...'; msg.className = 'formmsg';
      let data = null;
      try {
        if (!navigator.onLine) throw new Error('offline');
        const small = await compressImage(file, 1000, 0.85);
        data = await createOrder();
        orderId = data.order_id;
        try { await uploadShot(orderId, small); } catch { await uploadShot(orderId, small); } // one retry
        finishOrder();
        toast('Order placed!', 'ok');
        navigate(`/order/${orderId}?placed=1`);
      } catch (err) {
        if (data?.order_id) { // never leave an order without a screenshot: cancel it
          try { await sb.rpc('cancel_my_order', { p_order_id: data.order_id, p_reason: 'Payment screenshot upload failed' }); } catch {}
          try { sessionStorage.removeItem('sstc_idem'); } catch {}
        }
        msg.textContent = friendlyError(err) + ' Please choose the screenshot again.'; msg.className = 'formmsg bad';
        uploading = false; input.value = '';
      }
    });
  }

  function draw() {
    dots();
    ({ 1: drawStep1, 2: drawStep2, 3: drawStep3, 4: drawStep4 })[step]();
    scrollTo(0, 0);
  }
  draw();
  return root;
}
