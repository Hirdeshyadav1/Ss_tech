// My Orders: list, details (price snapshot), live status timeline, build media, cancel.
import { sb } from './supabase.js';
import { getUser } from './auth.js';
import { getSettings } from './settings.js';
import { esc, money, fmtDate, toast, friendlyError, confirmDialog, compressImage, ORDER_STATUS, PAY_STATUS, PAY_METHOD, navigate } from './utils.js';
import { payWithRazorpay } from './razorpay.js';

const PAGE = 10;
const tone = s => ({ DELIVERED: 'ok', CANCELLED: 'bad', RETURNED: 'warn', REFUNDED: 'warn', RETURN_REQUESTED: 'warn' }[s] || 'info');
const SLOT = { cpu: 'CPU', motherboard: 'Motherboard', ram: 'RAM', gpu: 'GPU', ssd: 'SSD', hdd: 'HDD', psu: 'PSU', cabinet: 'Cabinet', cooler: 'CPU Cooler', monitor: 'Monitor', keyboard: 'Keyboard', mouse: 'Mouse' };

export async function ordersPage() {
  const root = document.createElement('div');
  root.innerHTML = `<h1>My Orders</h1><div id="list" class="stack"></div><div class="center"><button class="btn ghost" id="more" hidden>Load more</button></div>`;
  const list = root.querySelector('#list'), more = root.querySelector('#more');
  let page = 0;
  async function load() {
    const { data, count, error } = await sb.from('orders')
      .select('id,order_number,created_at,total,order_status,payment_status,payment_method', { count: 'exact' })
      .order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw error;
    if (!page && !data.length) { list.innerHTML = `<div class="empty"><div class="big">📦</div><h2>No orders yet</h2><a class="btn" href="#/shop">Start shopping</a></div>`; return; }
    list.insertAdjacentHTML('beforeend', data.map(o => `<a class="card pad orderrow" href="#/order/${esc(o.id)}">
      <div class="row between"><b>${esc(o.order_number)}</b><span class="pill ${tone(o.order_status)}">${esc(ORDER_STATUS[o.order_status] || o.order_status)}</span></div>
      <div class="muted small">${esc(fmtDate(o.created_at))}</div>
      <div class="row between"><span class="muted small">${esc(PAY_METHOD[o.payment_method] || '')} • ${esc(PAY_STATUS[o.payment_status] || '')}</span><b>${money(o.total)}</b></div></a>`).join(''));
    page++; more.hidden = page * PAGE >= (count || 0);
  }
  more.addEventListener('click', () => load().catch(e => toast(friendlyError(e), 'bad')));
  await load();
  return root;
}

export async function orderPage({ params, query }) {
  const id = params[0], root = document.createElement('div');
  const settings = await getSettings().catch(() => ({}));
  const upi = settings.upi || {};
  const razorpay = settings.razorpay || {};
  const RANK = { ORDER_RECEIVED: 0, CONFIRMED: 1, PC_BUILDING: 2, READY: 3, OUT_FOR_DELIVERY: 4, DELIVERED: 5 };

  async function draw() {
    const [{ data: o, error }, tr, media, screenshots, payRes] = await Promise.all([
      sb.from('orders').select('*, order_items(*)').eq('id', id).maybeSingle(),
      sb.rpc('get_order_tracking', { p_order_id: id }),
      sb.from('build_media').select('*').eq('order_id', id).order('created_at'),
      sb.from('payment_screenshots').select('*').eq('order_id', id).order('created_at', { ascending: false }),
      sb.from('payments').select('status,paid_at,transaction_id').eq('order_id', id).maybeSingle()
    ]);
    if (error) throw error;
    if (!o) { root.innerHTML = `<div class="empty"><div class="big">😕</div><h2>Order not found</h2><a class="btn" href="#/orders">My orders</a></div>`; return; }
    const track = tr.data || { delivery: null, timeline: [] };
    const hist = track.timeline || [];
    const d = track.delivery;
    const pay = payRes.data;
    const a = o.address_snapshot || {};
    const items = (o.order_items || []).sort((x, y) => x.created_at.localeCompare(y.created_at));
    const isPickup = o.fulfilment_type === 'PICKUP';

    // product photos (best-effort, not part of the permanent price snapshot)
    const pids = [...new Set(items.map(i => i.product_id).filter(Boolean))];
    let imgMap = new Map();
    if (pids.length) {
      const { data: imgs } = await sb.from('products').select('id,image_url').in('id', pids);
      imgMap = new Map((imgs || []).map(p => [p.id, p.image_url]));
    }
    const thumb = i => { const u = imgMap.get(i.product_id); return u ? `<img loading="lazy" src="${esc(u)}" alt="">` : `<div class="noimg">🖥️</div>`; };

    // build photos / videos / notes uploaded by the shop
    const mediaItems = (await Promise.all((media.data || []).map(async m => {
      if (!m.bucket || !m.storage_path) return m.note ? { type: 'NOTE', note: m.note } : null;
      const { data: sg } = await sb.storage.from(m.bucket).createSignedUrl(m.storage_path, 3600);
      return sg ? { type: m.media_type, url: sg.signedUrl, note: m.note } : null;
    }))).filter(Boolean);
    const visuals = mediaItems.filter(m => m.type === 'IMAGE' || m.type === 'VIDEO');
    const latest = visuals[visuals.length - 1];
    const latestHtml = latest ? (latest.type === 'VIDEO'
      ? `<video controls preload="metadata" playsinline src="${esc(latest.url)}"></video>`
      : `<img loading="lazy" src="${esc(latest.url)}" alt="Build photo">`) : '';

    // ---------- hero card for the CURRENT stage ----------
    const st = o.order_status;
    const partCount = items.filter(i => i.component_slot).length || items.length;
    const hero = {
      ORDER_RECEIVED: { i: '✅', c: 'ok', t: query.get('placed') ? 'Order Placed Successfully!' : 'Order Received', x: 'Your order has been received. We will confirm it shortly.' },
      CONFIRMED: { i: '📦', c: 'info', t: 'Order Confirmed', x: 'Your parts are confirmed and reserved for you.' },
      PC_BUILDING: { i: '🛠️', c: 'info', t: 'PC Build in Progress', x: 'Our team is assembling and testing your PC with the selected parts.' },
      READY: { i: isPickup ? '🏬' : '📦', c: 'info', t: isPickup ? 'Ready for Pickup' : 'Ready for Delivery', x: isPickup ? 'Your order is packed. Please collect it from our shop.' : 'Your order is packed and ready to be delivered safely.' },
      OUT_FOR_DELIVERY: { i: '🚚', c: 'info', t: 'Out for Delivery', x: 'Your order is with our delivery partner and on the way to you.' },
      DELIVERED: { i: '✅', c: 'ok', t: 'Delivered', x: 'Your order has been delivered successfully!' },
      CANCELLED: { i: '❌', c: 'bad', t: 'Order Cancelled', x: 'This order was cancelled.' },
      RETURN_REQUESTED: { i: '↩️', c: 'warn', t: 'Return Requested', x: 'We received your return request.' },
      RETURNED: { i: '↩️', c: 'warn', t: 'Returned', x: 'Your return has been received.' },
      REFUNDED: { i: '💸', c: 'warn', t: 'Refunded', x: 'Your refund has been processed.' }
    }[st] || { i: '📦', c: 'info', t: ORDER_STATUS[st] || st, x: '' };

    let heroExtra = '';
    if (st === 'ORDER_RECEIVED') heroExtra = `<div class="idbox"><div><span class="muted small">Order ID</span><b>${esc(o.order_number)}</b></div><div><span class="muted small">Date</span><b>${esc(fmtDate(o.created_at))}</b></div></div>`;
    if (st === 'PC_BUILDING') heroExtra = `<div class="pbar"><i></i></div><div class="muted small">Building ${partCount} part${partCount > 1 ? 's' : ''} into your PC</div>${latestHtml}`;
    if (st === 'READY') heroExtra = `${latestHtml}${d?.tracking_id ? `<div class="idbox"><div><span class="muted small">Tracking number</span><b>${esc(d.tracking_id)}</b></div></div>` : ''}`;
    if (st === 'OUT_FOR_DELIVERY') heroExtra = `<div class="idbox col1">
        ${d?.person_name ? `<div><span class="muted small">Delivery partner</span><b>${esc(d.person_name)}</b></div>` : ''}
        ${d?.service_name ? `<div><span class="muted small">Service</span><b>${esc(d.service_name)}</b></div>` : ''}
        ${d?.tracking_id ? `<div><span class="muted small">Tracking number</span><b>${esc(d.tracking_id)}</b></div>` : ''}</div>
        ${d?.person_phone ? `<a class="btn block" href="tel:${esc(d.person_phone)}">📞 Call ${esc(d.person_phone)}</a>` : ''}`;
    if (st === 'DELIVERED') heroExtra = `${latestHtml}<div class="idbox"><div><span class="muted small">Delivered on</span><b>${esc(fmtDate(o.delivered_at || d?.delivered_at || hist[hist.length - 1]?.at || o.updated_at))}</b></div>${d?.person_name ? `<div><span class="muted small">Delivered by</span><b>${esc(d.person_name)}</b></div>` : ''}</div>`;

    // ---------- status timeline ----------
    let stepsHtml = '';
    if (st in RANK) {
      const at = k => hist.find(h => h.status === k)?.at;
      const cur = RANK[st];
      const S = [{ label: 'Order Placed', at: o.created_at, done: true }];
      if (o.payment_method === 'ONLINE') S.push({ label: 'Payment Confirmed', at: pay?.paid_at, done: o.payment_status === 'PAID' });
      S.push({ label: 'Order Confirmed', at: at('CONFIRMED'), done: cur >= 1 });
      if (o.has_pc_build) S.push({ label: 'PC Build & Testing', at: at('PC_BUILDING'), done: cur >= 2 });
      S.push({ label: isPickup ? 'Ready for Pickup' : 'Ready for Delivery', at: at('READY'), done: cur >= 3 });
      if (!isPickup) S.push({ label: 'Out for Delivery', at: at('OUT_FOR_DELIVERY'), done: cur >= 4 });
      S.push({ label: 'Delivered', at: at('DELIVERED'), done: cur >= 5 });
      let lastDone = -1; S.forEach((s, i) => { if (s.done) lastDone = i; });
      stepsHtml = S.map((s, i) => `<li class="${s.done ? 'done' : ''} ${i === lastDone ? 'active' : ''}"><span class="dot">${s.done ? '✓' : ''}</span><div><b>${esc(s.label)}</b>${s.at ? `<div class="muted small">${esc(fmtDate(s.at))}</div>` : ''}</div></li>`).join('');
    } else {
      stepsHtml = hist.map((h, i) => `<li class="done ${i === hist.length - 1 ? 'active' : ''}"><span class="dot">✓</span><div><b>${esc(ORDER_STATUS[h.status] || h.status)}</b><div class="muted small">${esc(fmtDate(h.at))}</div></div></li>`).join('');
    }

    const canCancel = ['ORDER_RECEIVED', 'CONFIRMED'].includes(st);
    const showPayRetry = o.payment_method === 'ONLINE' && ['PENDING', 'FAILED'].includes(o.payment_status) && razorpay.enabled && razorpay.key_id;
    const showUpi = o.payment_method === 'ONLINE' && o.payment_status === 'PENDING' && !(razorpay.enabled && razorpay.key_id);

    root.innerHTML = `<a href="#/orders" class="muted">← My orders</a>
      <div class="card stagecard ${hero.c}"><div class="stageicon ${hero.c}">${hero.i}</div><h2>${esc(hero.t)}</h2><p class="muted">${esc(hero.x)}</p>${heroExtra}</div>
      <div class="cols"><div class="col">
        <div class="card pad"><h3>Order status</h3><div class="muted small">${esc(o.order_number)} • ${esc(fmtDate(o.created_at))}</div><ol class="otl">${stepsHtml}</ol></div>
        <div class="card pad"><h3>Items</h3>${items.map(i => `<div class="oitem">
          <div class="cthumb sm">${thumb(i)}</div>
          <div class="grow"><b>${esc(i.product_name_snapshot)}</b>
            <div class="muted small">${esc([i.brand_snapshot, i.model_snapshot].filter(Boolean).join(' • '))}${i.component_slot ? ` • ${esc(SLOT[i.component_slot] || i.component_slot)}` : ''}</div>
            <div class="muted small">Qty ${i.quantity} × ${money(i.unit_price_snapshot)}${Number(i.discount_amount_snapshot) ? ` (discount −${money(i.discount_amount_snapshot)})` : ''}</div></div>
          <b>${money(i.total_snapshot)}</b></div>`).join('')}</div>
        ${mediaItems.length ? `<div class="card pad"><h3>Build photos & video</h3><div class="media">${mediaItems.map(m => m.type === 'NOTE' ? `<div class="card pad">${esc(m.note)}</div>` : `<div>${m.type === 'VIDEO' ? `<video controls preload="metadata" playsinline src="${esc(m.url)}"></video>` : `<img loading="lazy" src="${esc(m.url)}" alt="Build photo">`}${m.note ? `<div class="muted small">${esc(m.note)}</div>` : ''}</div>`).join('')}</div></div>` : ''}
        <div class="card pad"><h3>${isPickup ? 'Pickup details' : 'Delivery address'}</h3>
          <div>${esc(a.full_name)} • ${esc(a.phone)}</div><div class="muted">${esc([a.house_street, a.area, a.city, a.state, a.pincode].filter(Boolean).join(', '))}</div>
          ${a.landmark ? `<div class="muted small">Landmark: ${esc(a.landmark)}</div>` : ''}${a.instructions ? `<div class="muted small">Note: ${esc(a.instructions)}</div>` : ''}
          ${d ? `<hr><div class="small">${d.person_name ? `Delivery: <b>${esc(d.person_name)}</b> ${d.person_phone ? `(<a href="tel:${esc(d.person_phone)}">${esc(d.person_phone)}</a>)` : ''}` : ''}${d.service_name ? ` via ${esc(d.service_name)}` : ''}${d.tracking_id ? `<br>Tracking ID: <b>${esc(d.tracking_id)}</b>` : ''}</div>` : ''}</div>
      </div><div class="col side">
        <div class="card pad"><h3>Payment</h3><div>${esc(PAY_METHOD[o.payment_method] || '')}</div><span class="pill ${o.payment_status === 'PAID' ? 'ok' : 'info'}">${esc(PAY_STATUS[o.payment_status] || o.payment_status)}</span>
          ${showPayRetry ? `<div class="upibox"><div class="muted small">Payment was not completed.</div><button class="btn sm" id="retryRzp">Retry payment • ${money(o.total)}</button></div>` : ''}
          ${showUpi ? `<div class="upibox">${upi.qr_url ? `<img src="${esc(upi.qr_url)}" alt="UPI QR code" class="upiqr">` : ''}${upi.upi_id ? `<div class="upiid">UPI ID: <b>${esc(upi.upi_id)}</b></div>` : ''}<div class="muted small">Pay ${money(o.total)} via UPI. We'll confirm your payment shortly.</div></div>` : ''}
          ${o.payment_method === 'ONLINE' ? `<div class="ss-upload"><h4>Payment screenshot</h4>
            ${(screenshots.data || []).length ? `<div class="ss-gallery">${screenshots.data.map(x => `<img src="${esc(x.url)}" alt="Payment screenshot" loading="lazy">`).join('')}</div>` : '<p class="muted small">No screenshot uploaded yet.</p>'}
            <label class="filebtn">Choose screenshot<input type="file" id="ssfile" accept="image/png,image/jpeg,image/webp" hidden></label>
            <div class="formmsg" id="ssmsg" role="alert"></div></div>` : ''}
          <div class="sumrows"><div><span>Subtotal</span><span>${money(o.subtotal)}</span></div>
          ${Number(o.discount) ? `<div class="ok"><span>Discount</span><span>−${money(o.discount)}</span></div>` : ''}
          ${Number(o.coupon_discount) ? `<div class="ok"><span>Coupon ${esc(o.coupon_code || '')}</span><span>−${money(o.coupon_discount)}</span></div>` : ''}
          ${Number(o.tax) ? `<div><span>Tax ${o.tax_inclusive ? '(included)' : ''}</span><span>${money(o.tax)}</span></div>` : ''}
          <div><span>Delivery</span><span>${Number(o.delivery_charge) ? money(o.delivery_charge) : 'Free'}</span></div>
          <div class="grand"><span>Total</span><span>${money(o.total)}</span></div></div>
          <p class="muted small">Prices are locked at the time of order and never change.</p></div>
        ${canCancel ? `<button class="btn ghost block" id="cancel">Cancel order</button>` : ''}
        <a class="btn ghost block" href="#/support?order=${esc(o.id)}">Need help with this order?</a>
      </div></div>`;

    root.querySelector('#cancel')?.addEventListener('click', async () => {
      if (!await confirmDialog('Cancel this order?', 'Stock will be released and any payment will be refunded as per policy.', 'Yes, cancel')) return;
      const { error: e } = await sb.rpc('cancel_my_order', { p_order_id: id, p_reason: 'Cancelled by customer' });
      if (e) return toast(friendlyError(e), 'bad');
      toast('Order cancelled.', 'ok'); draw().catch(() => {});
    });
    root.querySelector('#retryRzp')?.addEventListener('click', async ev => {
      const btn = ev.target; btn.disabled = true; btn.textContent = 'Opening payment…';
      const result = await payWithRazorpay(id, { name: a.full_name, phone: a.phone, email: a.email, orderNumber: o.order_number });
      toast(result === 'paid' ? 'Payment successful!' : 'Payment not completed.', result === 'paid' ? 'ok' : 'info');
      draw().catch(() => {});
    });
    // screenshot uploads automatically as soon as a photo is chosen (no Upload button)
    root.querySelector('#ssfile')?.addEventListener('change', async ev => {
      const file = ev.target.files[0]; if (!file) return;
      const msg = root.querySelector('#ssmsg'); msg.textContent = 'Uploading…'; msg.className = 'formmsg';
      try {
        const small = await compressImage(file, 1000, 0.85);
        const path = `${id}/${Date.now()}-${small.name.replace(/[^\w.-]/g, '_')}`;
        const { error: upErr } = await sb.storage.from('payment-screenshots').upload(path, small, { contentType: small.type });
        if (upErr) throw upErr;
        const { data: pub } = sb.storage.from('payment-screenshots').getPublicUrl(path);
        const { error: insErr } = await sb.from('payment_screenshots').insert({ order_id: id, url: pub.publicUrl });
        if (insErr) throw insErr;
        toast('Screenshot sent. We will confirm your payment shortly.', 'ok');
        draw().catch(() => {});
      } catch (err) { msg.textContent = friendlyError(err); msg.className = 'formmsg bad'; }
    });
  }
  await draw();

  // live updates: status changes appear instantly
  const ch = sb.channel('order-' + id).on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${id}` },
    () => draw().catch(() => {})).subscribe();
  return { el: root, cleanup: () => sb.removeChannel(ch) };
}
