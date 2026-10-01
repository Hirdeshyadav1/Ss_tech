// Profile, Support, Notifications.
import { sb } from './supabase.js';
import { getSettings } from './settings.js';
import { getUser, getProfile, refreshProfile, logout, isLoggedIn } from './auth.js';
import { esc, fmtDate, toast, friendlyError, navigate } from './utils.js';

export async function profilePage() {
  const root = document.createElement('div');
  const u = getUser(), p = getProfile() || {};
  root.innerHTML = `<h1>My Profile</h1><div class="cols"><div class="col"><form id="f" class="card pad" novalidate>
    <label>Full name<input name="full_name" value="${esc(p.full_name)}" autocomplete="name"></label>
    <label>Email<input value="${esc(u.email)}" readonly></label>
    <label>Phone<input name="phone" type="tel" value="${esc(p.phone)}" autocomplete="tel"></label>
    <label>Address<input name="address_line" value="${esc(p.address_line)}" autocomplete="street-address"></label>
    <div class="two"><label>City<input name="city" value="${esc(p.city)}"></label><label>State<input name="state" value="${esc(p.state)}"></label></div>
    <label>Pincode<input name="pincode" inputmode="numeric" maxlength="6" value="${esc(p.pincode)}"></label>
    <div class="formmsg" role="alert"></div>
    <button class="btn block" type="submit">Save changes</button></form></div>
    <div class="col side"><div class="card pad"><h3>Account</h3>
      <div class="muted small">Member since ${esc(p.created_at ? fmtDate(p.created_at) : '')}</div>
      <a class="btn ghost block" href="#/orders">My orders</a><a class="btn ghost block" href="#/notifications">Notifications</a><a class="btn ghost block" href="#/support">Support</a>
      ${['ADMIN', 'STAFF'].includes(p.role) ? `<a class="btn pink block" href="#/admin">🛠️ Admin Panel</a>` : ''}
      ${p.role === 'DELIVERY_PERSON' ? `<a class="btn pink block" href="#/deliveries">🚚 My Deliveries</a>` : ''}
      <button class="btn pink block" id="out">Logout</button></div></div></div>`;
  const msg = (t, c = 'bad') => { const m = root.querySelector('.formmsg'); m.textContent = t; m.className = 'formmsg ' + c; };
  root.querySelector('#f').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target, btn = f.querySelector('button');
    const phone = f.phone.value.trim(), pin = f.pincode.value.trim();
    if (f.full_name.value.trim().length < 2) return msg('Please enter your name.');
    if (phone && !/^[0-9+ -]{8,15}$/.test(phone)) return msg('Enter a valid phone number.');
    if (pin && !/^[0-9]{6}$/.test(pin)) return msg('Pincode must be 6 digits.');
    btn.disabled = true;
    try {
      const { error } = await sb.from('profiles').update({
        full_name: f.full_name.value.trim(), phone: phone || null, address_line: f.address_line.value.trim() || null,
        city: f.city.value.trim() || null, state: f.state.value.trim() || null, pincode: pin || null
      }).eq('id', u.id);
      if (error) throw error;
      await refreshProfile(); msg('Profile saved.', 'ok'); toast('Profile saved.', 'ok');
    } catch (err) { msg(friendlyError(err)); }
    btn.disabled = false;
  });
  root.querySelector('#out').addEventListener('click', logout);
  return root;
}

export async function supportPage({ query }) {
  const root = document.createElement('div');
  const settings = await getSettings().catch(() => ({}));
  const shop = settings.shop || {};
  const logged = isLoggedIn();
  let orders = [], tickets = [];
  if (logged) {
    [orders, tickets] = await Promise.all([
      sb.from('orders').select('id,order_number').order('created_at', { ascending: false }).limit(30).then(r => r.data || []),
      sb.from('support_tickets').select('id,subject,status,admin_reply,created_at').order('created_at', { ascending: false }).limit(20).then(r => r.data || [])
    ]);
  }
  const wa = String(shop.whatsapp || '').replace(/[^0-9]/g, '');
  root.innerHTML = `<h1>Support</h1><div class="cols"><div class="col">
    <div class="card pad"><h3>Contact us</h3>
      ${shop.phone ? `<div>📞 <a href="tel:${esc(shop.phone)}">${esc(shop.phone)}</a></div>` : ''}
      ${shop.email ? `<div>✉️ <a href="mailto:${esc(shop.email)}">${esc(shop.email)}</a></div>` : ''}
      ${wa ? `<div>💬 <a href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a></div>` : ''}
      ${shop.instagram ? `<div>📸 <a href="https://instagram.com/${esc(String(shop.instagram).replace(/^@/, ''))}" target="_blank" rel="noopener">@${esc(String(shop.instagram).replace(/^@/, ''))}</a></div>` : ''}
      ${shop.address ? `<div class="muted">📍 ${esc(shop.address)}</div>` : ''}${shop.business_hours ? `<div class="muted small">🕒 ${esc(shop.business_hours)}</div>` : ''}
      ${!shop.phone && !shop.email && !wa && !shop.instagram ? '<p class="muted">Contact details will be shown here once the shop adds them.</p>' : ''}</div>
    ${logged ? `<form id="f" class="card pad" novalidate><h3>Send a request</h3>
      <label>Related order (optional)<select name="order"><option value="">— None —</option>${orders.map(o => `<option value="${esc(o.id)}" ${query.get('order') === o.id ? 'selected' : ''}>${esc(o.order_number)}</option>`).join('')}</select></label>
      <label>Subject<input name="subject" maxlength="200" required></label>
      <label>Message<textarea name="message" rows="4" maxlength="2000" required></textarea></label>
      <div class="formmsg" role="alert"></div><button class="btn block" type="submit">Submit</button></form>`
      : `<div class="card pad"><p>Please login to send a support request.</p><a class="btn" href="#/login">Login</a></div>`}
    </div><div class="col side">${logged ? `<div class="card pad"><h3>My requests</h3>${tickets.length ? tickets.map(t => `<div class="ticket">
      <div class="row between"><b>${esc(t.subject)}</b><span class="pill info">${esc(t.status.replace('_', ' '))}</span></div>
      <div class="muted small">${esc(fmtDate(t.created_at))}</div>${t.admin_reply ? `<div class="reply">${esc(t.admin_reply)}</div>` : ''}</div>`).join('') : '<p class="muted">No requests yet.</p>'}</div>` : ''}</div></div>`;
  root.querySelector('#f')?.addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target, btn = f.querySelector('button'), m = root.querySelector('.formmsg');
    const subject = f.subject.value.trim(), message = f.message.value.trim();
    if (subject.length < 3 || message.length < 10) { m.textContent = 'Please enter a subject and a message (min 10 characters).'; m.className = 'formmsg bad'; return; }
    btn.disabled = true;
    const pr = getProfile() || {};
    const { error } = await sb.from('support_tickets').insert({ user_id: getUser().id, order_id: f.order.value || null, name: pr.full_name || 'Customer', email: getUser().email, phone: pr.phone || null, subject, message });
    btn.disabled = false;
    if (error) { m.textContent = friendlyError(error); m.className = 'formmsg bad'; return; }
    toast('Request submitted. We will get back to you.', 'ok'); f.reset();
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  return root;
}

export async function notificationsPage() {
  const root = document.createElement('div');
  const { data, error } = await sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  root.innerHTML = `<h1>Notifications</h1>${data.length ? `<div class="stack">${data.map(n => {
    const link = n.ref_type === 'order' && n.ref_id ? `#/order/${esc(n.ref_id)}` : '#';
    return `<a class="card pad notif ${n.is_read ? '' : 'unread'}" href="${link}"><b>${esc(n.title)}</b><div class="muted">${esc(n.body)}</div><div class="muted small">${esc(fmtDate(n.created_at))}</div></a>`;
  }).join('')}</div>` : `<div class="empty"><div class="big">🔔</div><h2>No notifications</h2></div>`}`;
  if (data.some(n => !n.is_read)) {
    sb.from('notifications').update({ is_read: true }).eq('user_id', getUser().id).eq('is_read', false)
      .then(() => window.dispatchEvent(new Event('sstc:notif')));
  }
  return root;
}
