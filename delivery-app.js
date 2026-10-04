// Delivery person dashboard. Only useful for accounts with role DELIVERY_PERSON
// (linked via delivery_persons.user_id in Supabase). Shows only that person's
// assigned deliveries with what they need to complete them - nothing else.
import { sb } from './supabase.js';
import { esc, money, fmtDate, toast, friendlyError } from './utils.js';

const NEXT = { ASSIGNED: [['PICKED_UP', 'Mark picked up']], PICKED_UP: [['OUT_FOR_DELIVERY', 'Start delivery']],
  OUT_FOR_DELIVERY: [['DELIVERED', 'Mark delivered'], ['FAILED', 'Delivery failed']] };

export async function deliveryHomePage() {
  const root = document.createElement('div');
  root.innerHTML = `<h1>My Deliveries</h1><div id="list" class="stack"></div>`;
  const list = root.querySelector('#list');
  async function load() {
    const { data, error } = await sb.rpc('delivery_my_orders');
    if (error) { list.innerHTML = `<div class="formmsg bad">${esc(friendlyError(error))}</div>`; return; }
    if (!data.length) { list.innerHTML = `<div class="empty"><div class="big">🚚</div><h2>No deliveries assigned</h2><p class="muted">New assignments will show up here.</p></div>`; return; }
    list.innerHTML = data.map(d => { const c = d.customer || {}; return `<div class="card pad" data-id="${esc(d.delivery_id)}">
      <div class="row between"><b>${esc(d.order_number)}</b><span class="pill info">${esc(d.delivery_status.replace('_', ' '))}</span></div>
      <div class="muted small">${esc(c.full_name || '')} • <a href="tel:${esc(c.phone || '')}">${esc(c.phone || '')}</a></div>
      <div class="muted small">${esc([c.house_street, c.area, c.city, c.state, c.pincode].filter(Boolean).join(', '))}</div>
      ${c.landmark ? `<div class="muted small">Landmark: ${esc(c.landmark)}</div>` : ''}
      <div class="row between" style="margin-top:6px"><span class="muted small">${esc(d.payment_method)} ${Number(d.collect_amount) ? `• Collect ${money(d.collect_amount)}` : '• Paid'}</span></div>
      <div class="row wrap" style="margin-top:8px">${(NEXT[d.delivery_status] || []).map(([s, l]) => `<button class="btn sm" data-status="${s}">${esc(l)}</button>`).join('')}</div>
    </div>`; }).join('');
  }
  list.addEventListener('click', async e => {
    const b = e.target.closest('[data-status]'); if (!b) return;
    const card = e.target.closest('[data-id]');
    b.disabled = true;
    const { error } = await sb.rpc('delivery_update_status', { p_delivery_id: card.dataset.id, p_status: b.dataset.status });
    if (error) { toast(friendlyError(error), 'bad'); b.disabled = false; return; }
    toast('Updated.', 'ok'); load();
  });
  await load();
  return root;
}
