// Admin panel, part 2: Orders, Payments, Delivery, Customers, Support, Reports.
import { sb } from './supabase.js';
import { esc, money, fmtDate, toast, friendlyError, confirmDialog, debounce, exportCSV, ORDER_STATUS, PAY_STATUS, PAY_METHOD } from './utils.js';

const tone = s => ({ DELIVERED: 'ok', CANCELLED: 'bad', RETURNED: 'warn', REFUNDED: 'warn', RETURN_REQUESTED: 'warn', PAID: 'ok', FAILED: 'bad' }[s] || 'info');
const NEXT_STATUS = {
  ORDER_RECEIVED: ['CONFIRMED', 'CANCELLED'], CONFIRMED: ['PC_BUILDING', 'READY', 'CANCELLED'], PC_BUILDING: ['READY', 'CANCELLED'],
  READY: ['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'], OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: ['RETURN_REQUESTED'], RETURN_REQUESTED: ['RETURNED'], RETURNED: ['REFUNDED'], CANCELLED: ['REFUNDED'], REFUNDED: [] };
const PAY_NEXT = { PENDING: ['PAID', 'FAILED', 'CANCELLED'], COD_PENDING: ['PAID', 'CANCELLED'], FAILED: ['PENDING'], PAID: ['REFUNDED'], CANCELLED: [], REFUNDED: [] };

// ============================= ORDERS =============================
export async function ordersTab() {
  const root = document.createElement('div');
  root.innerHTML = `<div class="row wrap admin-filters">
      <input id="q" type="search" placeholder="Search order number…" style="max-width:220px">
      <select id="fstatus"><option value="">All statuses</option>${Object.keys(ORDER_STATUS).map(s => `<option value="${s}">${ORDER_STATUS[s]}</option>`).join('')}</select>
    </div><div id="list" class="stack" style="margin-top:10px"></div>
    <div class="center"><button class="btn ghost" id="more" hidden>Load more</button></div>`;
  const list = root.querySelector('#list'), more = root.querySelector('#more');
  let page = 0, q = '', status = '';
  async function load(reset) {
    if (reset) { page = 0; list.innerHTML = ''; }
    let query = sb.from('orders').select('id,order_number,total,order_status,payment_status,payment_method,fulfilment_type,has_pc_build,created_at,address_snapshot', { count: 'exact' }).order('created_at', { ascending: false });
    if (status) query = query.eq('order_status', status);
    if (q) query = query.ilike('order_number', `%${q}%`);
    const { data, count, error } = await query.range(page * 20, page * 20 + 19);
    if (error) throw error;
    list.insertAdjacentHTML('beforeend', data.map(o => `<button class="card pad row between wrap orow" data-id="${esc(o.id)}">
      <div><b>${esc(o.order_number)}</b> ${o.has_pc_build ? '<span class="pill info">PC Build</span>' : ''}
        <div class="muted small">${esc(o.address_snapshot?.full_name || '')} • ${esc(fmtDate(o.created_at))}</div>
        <div class="muted small">${esc(PAY_METHOD[o.payment_method] || '')} • <span class="pill ${tone(o.payment_status)}">${esc(PAY_STATUS[o.payment_status] || '')}</span></div></div>
      <div class="right"><b>${money(o.total)}</b><br><span class="pill ${tone(o.order_status)}">${esc(ORDER_STATUS[o.order_status] || o.order_status)}</span></div></button>`).join(''));
    page++; more.hidden = page * 20 >= (count || 0);
  }
  root.querySelector('#q').addEventListener('input', debounce(e => { q = e.target.value.trim(); load(true); }, 350));
  root.querySelector('#fstatus').addEventListener('change', e => { status = e.target.value; load(true); });
  more.addEventListener('click', () => load(false).catch(e => toast(friendlyError(e), 'bad')));
  list.addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (b) openOrderDetail(b.dataset.id, () => load(true)); });
  await load(true);
  return root;
}

async function openOrderDetail(id, onChange) {
  const overlay = document.createElement('div'); overlay.className = 'modal';
  overlay.innerHTML = `<div class="dialog glass picker" role="dialog" aria-modal="true"><div id="body"><p class="muted center">Loading...</p></div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  const body = overlay.querySelector('#body');
  const TABS = ['Overview', 'Payment', 'Delivery', 'Media & notes'];
  let tab = 0, data = null;

  async function load() {
    const [{ data: o, error }, { data: dps }, { data: delivery }, { data: media }, { data: screenshots }] = await Promise.all([
      sb.from('orders').select('*, order_items(*), order_pc_builds(*), payments(*)').eq('id', id).single(),
      sb.from('delivery_persons').select('id,name,phone').eq('is_active', true),
      sb.from('deliveries').select('*').eq('order_id', id).maybeSingle(),
      sb.from('build_media').select('*').eq('order_id', id).order('created_at'),
      sb.from('payment_screenshots').select('*').eq('order_id', id).order('created_at', { ascending: false })
    ]);
    if (error) { body.innerHTML = `<div class="formmsg bad">${esc(friendlyError(error))}</div>`; return false; }
    data = { o, dps: dps || [], delivery, media: media || [], screenshots: screenshots || [] };
    return true;
  }

  function frame(inner) {
    const { o } = data;
    body.innerHTML = `<div class="row between"><h3>${esc(o.order_number)}</h3><button class="btn sm ghost" id="close">✕</button></div>
      <div class="row wrap"><span class="pill ${tone(o.order_status)}">${esc(ORDER_STATUS[o.order_status] || o.order_status)}</span>
        <span class="pill ${tone(o.payment_status)}">${esc(PAY_STATUS[o.payment_status] || o.payment_status)}</span></div>
      <div class="admin-subtabs">${TABS.map((l, i) => `<button class="${i === tab ? 'active' : ''}" data-tab="${i}">${esc(l)}</button>`).join('')}</div>
      <div id="tabbody">${inner}</div>
      <div class="formmsg" role="alert"></div>`;
    body.querySelector('#close').onclick = close;
    body.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { tab = Number(b.dataset.tab); render(); }));
  }

  function msgEls() {
    const msg = body.querySelector('.formmsg');
    return { bad: t => { msg.textContent = t; msg.className = 'formmsg bad'; }, ok: t => { msg.textContent = t; msg.className = 'formmsg ok'; } };
  }

  function drawOverview() {
    const { o } = data;
    const a = o.address_snapshot || {};
    frame(`
      <h4>Items</h4>${(o.order_items || []).map(i => `<div class="sline"><div class="grow">${esc(i.product_name_snapshot)}${i.component_slot ? ` <span class="muted small">(${esc(i.component_slot)})</span>` : ''}<div class="muted small">Qty ${i.quantity} x ${money(i.unit_price_snapshot)}</div></div><b>${money(i.total_snapshot)}</b></div>`).join('')}
      <div class="sumrows"><div><span>Subtotal</span><span>${money(o.subtotal)}</span></div>
        ${Number(o.discount) ? `<div class="ok"><span>Discount</span><span>-${money(o.discount)}</span></div>` : ''}
        ${Number(o.tax) ? `<div><span>Tax</span><span>${money(o.tax)}</span></div>` : ''}
        <div><span>Delivery</span><span>${money(o.delivery_charge)}</span></div>
        <div class="grand"><span>Total</span><span>${money(o.total)}</span></div></div>

      <h4>${o.fulfilment_type === 'PICKUP' ? 'Pickup' : 'Delivery'} address</h4>
      <div>${esc(a.full_name)} - <a href="tel:${esc(a.phone)}">${esc(a.phone)}</a></div>
      <div class="muted small">${esc([a.house_street, a.area, a.city, a.state, a.pincode].filter(Boolean).join(', '))}</div>
      ${a.instructions ? `<div class="muted small">Note: ${esc(a.instructions)}</div>` : ''}

      ${o.has_pc_build && o.order_pc_builds?.[0] ? `<h4>PC Build</h4><div class="muted small">${esc(o.order_pc_builds[0].build_name || 'Custom PC')} - Compatibility: ${esc(o.order_pc_builds[0].compatibility_status || '-')}</div>` : ''}

      <h4>Update order status</h4>
      <div class="row wrap">${(NEXT_STATUS[o.order_status] || []).map(s => `<button class="btn sm ${s === 'CANCELLED' ? 'ghost' : ''}" data-status="${s}">${esc(ORDER_STATUS[s])}</button>`).join('') || '<span class="muted small">No further transitions.</span>'}</div>
    `);
    body.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', async () => {
      const { bad, ok } = msgEls();
      if (b.dataset.status === 'CANCELLED' && !await confirmDialog('Cancel this order?', 'Stock will be restored and coupon usage released.', 'Cancel order')) return;
      const { error: e } = await sb.rpc('admin_update_order_status', { p_order_id: id, p_status: b.dataset.status });
      if (e) return bad(friendlyError(e));
      ok('Status updated.'); onChange(); await load(); render();
    }));
  }

  function drawPayment() {
    const { o, screenshots } = data;
    const pay = o.payments?.[0];
    frame(`
      <h4>Payment</h4>
      <div class="muted small">${esc(PAY_METHOD[o.payment_method])} ${pay?.transaction_id ? `- Txn: ${esc(pay.transaction_id)}` : ''}</div>
      ${screenshots.length ? `<div class="ss-gallery">${screenshots.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener"><img src="${esc(s.url)}" alt="Payment screenshot"></a>`).join('')}</div>` : '<p class="muted small">No payment screenshot uploaded.</p>'}
      <div class="row wrap">${(PAY_NEXT[o.payment_status] || []).map(s => `<button class="btn sm ghost" data-pay="${s}">Mark ${esc(PAY_STATUS[s])}</button>`).join('') || '<span class="muted small">No further actions.</span>'}</div>
    `);
    body.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', async () => {
      const { bad, ok } = msgEls();
      const { error: e } = await sb.rpc('admin_set_payment_status', { p_order_id: id, p_status: b.dataset.pay });
      if (e) return bad(friendlyError(e));
      ok('Payment updated.'); onChange(); await load(); render();
    }));
  }

  function drawDelivery() {
    const { dps, delivery } = data;
    frame(`
      <h4>Delivery</h4>
      <form id="fdel" class="stack">
        <select name="person"><option value="">- Unassigned / pickup -</option>${dps.map(p => `<option value="${esc(p.id)}" ${delivery?.delivery_person_id === p.id ? 'selected' : ''}>${esc(p.name)} (${esc(p.phone)})</option>`).join('')}</select>
        <div class="two"><input name="service_name" placeholder="Delivery service name" value="${esc(delivery?.service_name || '')}"><input name="tracking_id" placeholder="Tracking ID" value="${esc(delivery?.tracking_id || '')}"></div>
        <button class="btn sm" type="submit">Save delivery</button></form>
      ${delivery ? `<div class="muted small">Status: ${esc(delivery.status)}</div>` : ''}
    `);
    body.querySelector('#fdel').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target; const { bad, ok } = msgEls();
      const { error: er } = await sb.rpc('admin_assign_delivery', { p_order_id: id, p_delivery_person_id: f.person.value || null, p_service_name: f.service_name.value.trim() || null, p_tracking_id: f.tracking_id.value.trim() || null });
      if (er) return bad(friendlyError(er));
      ok('Delivery saved.'); await load(); render();
    });
  }

  function drawMedia() {
    const { media } = data;
    frame(`
      <h4>Build photos / video</h4>
      <div class="media">${media.length ? '(uploaded - visible to customer on their order page)' : '<span class="muted small">None yet.</span>'}</div>
      <form id="fmedia" class="row"><input type="file" name="file" accept="image/*,video/mp4,video/webm" style="flex:1"><button class="btn sm" type="submit">Upload</button></form>
      <label>Add a note for the customer<textarea id="note" rows="2" placeholder="e.g. Build completed, ready for pickup"></textarea></label>
      <button class="btn sm ghost" id="addnote">Add note</button>
    `);
    body.querySelector('#fmedia').addEventListener('submit', async e => {
      e.preventDefault(); const file = e.target.file.files[0]; const { bad, ok } = msgEls();
      if (!file) return bad('Choose a file first.');
      const isVideo = file.type.startsWith('video/');
      const bucket = isVideo ? 'build-videos' : 'build-images';
      const path = `${id}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
      const { error: upErr } = await sb.storage.from(bucket).upload(path, file);
      if (upErr) return bad(friendlyError(upErr));
      const { error: insErr } = await sb.from('build_media').insert({ order_id: id, media_type: isVideo ? 'VIDEO' : 'IMAGE', bucket, storage_path: path });
      if (insErr) return bad(friendlyError(insErr));
      ok('Uploaded.'); await load(); render();
    });
    body.querySelector('#addnote').addEventListener('click', async () => {
      const note = body.querySelector('#note').value.trim(); if (!note) return;
      const { bad, ok } = msgEls();
      const { error: e } = await sb.from('build_media').insert({ order_id: id, media_type: 'NOTE', note });
      if (e) return bad(friendlyError(e));
      ok('Note added.'); await load(); render();
    });
  }

  function render() { ({ 0: drawOverview, 1: drawPayment, 2: drawDelivery, 3: drawMedia })[tab](); }

  if (await load()) render();
}


// ============================= PAYMENTS =============================
export async function paymentsTab() {
  const root = document.createElement('div');
  const { data, error } = await sb.from('payments').select('*, orders(order_number,address_snapshot)').order('created_at', { ascending: false }).limit(60);
  if (error) throw error;
  root.innerHTML = `<div class="stack">${data.map(p => `<div class="card pad row between wrap">
    <div><b>${esc(p.orders?.order_number || '')}</b> <span class="muted small">${esc(p.orders?.address_snapshot?.full_name || '')}</span>
      <div class="muted small">${esc(PAY_METHOD[p.method] || p.method)} • ${esc(fmtDate(p.created_at))}${p.transaction_id ? ` • Txn ${esc(p.transaction_id)}` : ''}</div></div>
    <div class="right"><b>${money(p.amount)}</b><br><span class="pill ${tone(p.status)}">${esc(PAY_STATUS[p.status] || p.status)}</span></div></div>`).join('') || '<p class="muted">No payments yet.</p>'}</div>`;
  return root;
}

// ============================= DELIVERY =============================
export async function deliveryTab() {
  const root = document.createElement('div');
  root.innerHTML = `<div class="admin-subtabs"><button class="active" data-t="active">Active deliveries</button><button data-t="persons">Delivery persons</button></div><div id="sub"></div>`;
  const sub = root.querySelector('#sub');
  async function active() {
    const { data, error } = await sb.from('deliveries').select('*, orders(order_number,total)').in('status', ['ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY']).order('assigned_at', { ascending: false });
    if (error) throw error;
    sub.innerHTML = data.length ? `<div class="stack">${data.map(d => `<div class="card pad row between wrap">
      <div><b>${esc(d.orders?.order_number || '')}</b><div class="muted small">${esc(d.person_name_snapshot || 'Unassigned')} ${d.service_name ? '• ' + esc(d.service_name) : ''}</div></div>
      <span class="pill info">${esc(d.status.replace('_', ' '))}</span></div>`).join('')}</div>` : '<p class="muted">No active deliveries.</p>';
  }
  async function persons() {
    const { data, error } = await sb.from('delivery_persons').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    sub.innerHTML = `<button class="btn" id="add">+ Add delivery person</button>
      <div class="stack" style="margin-top:10px">${data.map(p => `<div class="card pad row between"><div><b>${esc(p.name)}</b> ${!p.is_active ? '<span class="pill bad">Inactive</span>' : ''}<div class="muted small">${esc(p.phone)}${p.service_name ? ' • ' + esc(p.service_name) : ''}</div></div>
        <button class="btn sm ghost" data-edit="${esc(p.id)}">Edit</button></div>`).join('') || '<p class="muted">None yet.</p>'}</div>`;
    function openForm(dp) {
      const overlay = document.createElement('div'); overlay.className = 'modal';
      overlay.innerHTML = `<div class="dialog glass" role="dialog" aria-modal="true"><h3>${dp ? 'Edit' : 'Add'} delivery person</h3>
        <form id="f" class="stack" novalidate>
          <label>Name<input name="name" value="${esc(dp?.name || '')}" required></label>
          <label>Phone<input name="phone" value="${esc(dp?.phone || '')}" required></label>
          <label>Service / partner name (optional)<input name="service_name" value="${esc(dp?.service_name || '')}"></label>
          <label class="check"><input type="checkbox" name="is_partner" ${dp?.is_partner ? 'checked' : ''}> Third-party courier partner</label>
          <label class="check"><input type="checkbox" name="is_active" ${dp?.is_active !== false ? 'checked' : ''}> Active</label>
          <div class="formmsg" role="alert"></div>
          <div class="row end"><button type="button" class="btn ghost" id="cancel">Cancel</button><button class="btn" type="submit">Save</button></div>
        </form></div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('#cancel').onclick = () => overlay.remove();
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
      overlay.querySelector('#f').addEventListener('submit', async e => {
        e.preventDefault(); const f = e.target, msg = overlay.querySelector('.formmsg');
        const payload = { name: f.name.value.trim(), phone: f.phone.value.trim(), service_name: f.service_name.value.trim() || null, is_partner: f.is_partner.checked, is_active: f.is_active.checked };
        if (!payload.name || !payload.phone) { msg.textContent = 'Name and phone are required.'; msg.className = 'formmsg bad'; return; }
        const q = dp ? sb.from('delivery_persons').update(payload).eq('id', dp.id) : sb.from('delivery_persons').insert(payload);
        const { error: e2 } = await q;
        if (e2) { msg.textContent = friendlyError(e2); msg.className = 'formmsg bad'; return; }
        toast('Saved.', 'ok'); overlay.remove(); persons();
      });
    }
    sub.querySelector('#add').addEventListener('click', () => openForm(null));
    sub.addEventListener('click', e => { const b = e.target.closest('[data-edit]'); if (b) openForm(data.find(x => x.id === b.dataset.edit)); });
  }
  const fns = { active, persons };
  root.querySelector('.admin-subtabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    root.querySelectorAll('.admin-subtabs button').forEach(x => x.classList.toggle('active', x === b));
    fns[b.dataset.t]().catch(err => toast(friendlyError(err), 'bad'));
  });
  await active();
  return root;
}

// ============================= CUSTOMERS =============================
export async function customersTab() {
  const root = document.createElement('div');
  root.innerHTML = `<input id="q" type="search" placeholder="Search name, email, phone…"><div id="list" class="stack" style="margin-top:10px"></div>`;
  const list = root.querySelector('#list');
  async function load(q) {
    let query = sb.from('profiles').select('id,full_name,email,phone,city,created_at,is_active').eq('role', 'CUSTOMER').order('created_at', { ascending: false }).limit(40);
    if (q) query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    list.innerHTML = data.map(c => `<button class="card pad row between" data-id="${esc(c.id)}">
      <div><b>${esc(c.full_name || c.email)}</b> ${!c.is_active ? '<span class="pill bad">Disabled</span>' : ''}<div class="muted small">${esc(c.email)} ${c.phone ? '• ' + esc(c.phone) : ''}</div></div>
      <span class="muted small">${esc(fmtDate(c.created_at))}</span></button>`).join('') || '<p class="muted">No customers found.</p>';
  }
  root.querySelector('#q').addEventListener('input', debounce(e => load(e.target.value.trim()).catch(err => toast(friendlyError(err), 'bad')), 350));
  list.addEventListener('click', async e => {
    const b = e.target.closest('[data-id]'); if (!b) return;
    const { data: orders } = await sb.from('orders').select('order_number,total,order_status,created_at').eq('customer_id', b.dataset.id).order('created_at', { ascending: false }).limit(20);
    const spend = (orders || []).filter(o => !['CANCELLED', 'RETURNED', 'REFUNDED'].includes(o.order_status)).reduce((s, o) => s + Number(o.total), 0);
    const overlay = document.createElement('div'); overlay.className = 'modal';
    overlay.innerHTML = `<div class="dialog glass picker" role="dialog" aria-modal="true"><div class="row between"><h3>Customer orders</h3><button class="btn sm ghost" id="close">✕</button></div>
      <div class="sumrows"><div><span>Total orders</span><span>${orders?.length || 0}</span></div><div><span>Total spend</span><span>${money(spend)}</span></div></div>
      <div class="stack">${(orders || []).map(o => `<div class="sline"><div class="grow">${esc(o.order_number)}<div class="muted small">${esc(fmtDate(o.created_at))} • ${esc(ORDER_STATUS[o.order_status] || o.order_status)}</div></div><b>${money(o.total)}</b></div>`).join('') || '<p class="muted">No orders yet.</p>'}</div></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#close').onclick = () => overlay.remove();
    overlay.addEventListener('click', e2 => { if (e2.target === overlay) overlay.remove(); });
  });
  await load('');
  return root;
}

// ============================= SUPPORT =============================
export async function supportTab() {
  const root = document.createElement('div');
  const { data, error } = await sb.from('support_tickets').select('*').order('created_at', { ascending: false }).limit(60);
  if (error) throw error;
  root.innerHTML = `<div class="stack">${data.map(t => `<div class="card pad" data-t="${esc(t.id)}">
    <div class="row between wrap"><b>${esc(t.subject)}</b><span class="pill ${t.status === 'RESOLVED' || t.status === 'CLOSED' ? 'ok' : 'info'}">${esc(t.status.replace('_', ' '))}</span></div>
    <div class="muted small">${esc(t.name)} ${t.email ? '• ' + esc(t.email) : ''} ${t.phone ? '• ' + esc(t.phone) : ''} • ${esc(fmtDate(t.created_at))}</div>
    <p>${esc(t.message)}</p>
    ${t.admin_reply ? `<div class="reply">${esc(t.admin_reply)}</div>` : ''}
    <form class="reply-form stack" data-id="${esc(t.id)}">
      <textarea name="reply" rows="2" placeholder="Write a reply…">${esc(t.admin_reply || '')}</textarea>
      <div class="row"><select name="status"><option value="OPEN" ${t.status === 'OPEN' ? 'selected' : ''}>Open</option><option value="IN_PROGRESS" ${t.status === 'IN_PROGRESS' ? 'selected' : ''}>In progress</option><option value="RESOLVED" ${t.status === 'RESOLVED' ? 'selected' : ''}>Resolved</option><option value="CLOSED" ${t.status === 'CLOSED' ? 'selected' : ''}>Closed</option></select>
      <button class="btn sm" type="submit">Save</button></div></form></div>`).join('') || '<p class="muted">No support requests.</p>'}</div>`;
  root.querySelectorAll('.reply-form').forEach(f => f.addEventListener('submit', async e => {
    e.preventDefault();
    const { error: er } = await sb.from('support_tickets').update({ admin_reply: f.reply.value.trim() || null, status: f.status.value }).eq('id', f.dataset.id);
    if (er) return toast(friendlyError(er), 'bad');
    toast('Saved.', 'ok');
  }));
  return root;
}

// ============================= REPORTS =============================
export async function reportsTab() {
  const root = document.createElement('div');
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  root.innerHTML = `<div class="card pad"><form id="f" class="row wrap">
      <label>From<input type="date" name="from" value="${monthAgo}"></label>
      <label>To<input type="date" name="to" value="${today}"></label>
      <label>Report<select name="type"><option value="sales">Daily sales</option><option value="products">Product sales</option><option value="inventory">Inventory</option></select></label>
      <button class="btn" type="submit" style="align-self:flex-end">Generate</button></form></div>
    <div id="out" style="margin-top:10px"></div>`;
  const out = root.querySelector('#out');
  root.querySelector('#f').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    out.innerHTML = '<p class="muted center">Loading…</p>';
    try {
      if (f.type.value === 'sales') {
        const { data, error } = await sb.rpc('report_sales_daily', { p_from: f.from.value, p_to: f.to.value });
        if (error) throw error;
        const totalRev = data.reduce((s, r) => s + Number(r.revenue), 0);
        out.innerHTML = `<div class="row between"><b>Total revenue: ${money(totalRev)}</b><button class="btn sm ghost" id="csv">Export CSV</button></div>
          <div class="stack">${data.map(r => `<div class="sline"><div class="grow">${esc(r.sale_date)} <span class="muted small">${r.order_count} orders</span></div><b>${money(r.revenue)}</b></div>`).join('') || '<p class="muted">No sales in this range.</p>'}</div>`;
        out.querySelector('#csv')?.addEventListener('click', () => exportCSV(`sales-${f.from.value}_${f.to.value}.csv`, data));
      } else if (f.type.value === 'products') {
        const { data, error } = await sb.rpc('report_product_sales', { p_from: f.from.value, p_to: f.to.value });
        if (error) throw error;
        out.innerHTML = `<div class="row end"><button class="btn sm ghost" id="csv">Export CSV</button></div>
          <div class="stack">${data.map(r => `<div class="sline"><div class="grow">${esc(r.product_name)} <span class="muted small">${esc(r.sku)} • Qty ${r.quantity_sold}</span></div><b>${money(r.net_amount)}</b></div>`).join('') || '<p class="muted">No sales in this range.</p>'}</div>`;
        out.querySelector('#csv')?.addEventListener('click', () => exportCSV(`product-sales-${f.from.value}_${f.to.value}.csv`, data));
      } else {
        const { data, error } = await sb.rpc('report_inventory', { p_from: f.from.value, p_to: f.to.value });
        if (error) throw error;
        out.innerHTML = `<div class="row end"><button class="btn sm ghost" id="csv">Export CSV</button></div>
          <div class="stack">${data.map(r => `<div class="sline"><div class="grow">${esc(r.product_name)} <span class="muted small">${esc(r.sku)}</span><div class="muted small">Open ${r.opening_stock} + Purchased ${r.purchased_qty} − Sold ${r.sold_qty} + Returned ${r.returned_qty} − Damaged ${r.damaged_qty} ± Adj ${r.adjustment_qty}</div></div><b>${r.closing_stock}</b></div>`).join('') || '<p class="muted">No data.</p>'}</div>`;
        out.querySelector('#csv')?.addEventListener('click', () => exportCSV(`inventory-${f.from.value}_${f.to.value}.csv`, data));
      }
    } catch (err) { out.innerHTML = `<div class="formmsg bad">${esc(friendlyError(err))}</div>`; }
  });
  return root;
}
