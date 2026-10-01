// App shell: router, header/nav state, realtime notifications, offline banner, PWA.
import { sb } from './supabase.js';
import { runSplash } from './splash.js';
import { initAuth, getUser, isLoggedIn, requireLogin, loginPage, registerPage, forgotPage, resetPage, phoneAuthPage } from './auth.js';
import { homePage, shopPage, productPage } from './products.js';
import { builderPage } from './builder.js';
import { cartPage, cartCount } from './cart.js';
import { checkoutPage } from './checkout.js';
import { ordersPage, orderPage } from './orders.js';
import { profilePage, supportPage, notificationsPage } from './account.js';
import { adminPage } from './admin.js';
import { deliveryHomePage } from './delivery-app.js';
import { $, $$, esc, friendlyError, toast, navigate } from './utils.js';

const view = $('#view');
// [pattern, handler, requiresLogin]
const routes = [
  [/^\/home$/, homePage, false], [/^\/shop$/, shopPage, false], [/^\/product\/([\w-]+)$/, productPage, false],
  [/^\/builder$/, builderPage, false],
  [/^\/cart$/, cartPage, false], [/^\/checkout$/, checkoutPage, true],
  [/^\/orders$/, ordersPage, true], [/^\/order\/([\w-]+)$/, orderPage, true],
  [/^\/profile$/, profilePage, true], [/^\/support$/, supportPage, false], [/^\/notifications$/, notificationsPage, true],
  [/^\/admin(?:\/([\w-]+))?$/, adminPage, true], [/^\/deliveries$/, deliveryHomePage, true],
  [/^\/login$/, loginPage, false], [/^\/register$/, registerPage, false], [/^\/forgot$/, forgotPage, false], [/^\/reset$/, resetPage, false], [/^\/phone$/, phoneAuthPage, false]
];
let cleanup = null, token = 0;

const skeleton = () => `<div class="skel"><div class="sk h"></div><div class="sk"></div><div class="sk"></div><div class="sk s"></div></div>`;
function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/home';
  const [path, qs] = h.split('?');
  return { path: path || '/home', query: new URLSearchParams(qs || '') };
}

async function route() {
  const my = ++token;
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  const { path, query } = parseHash();
  const hit = routes.find(r => r[0].test(path));
  if (!hit) return navigate('/home');
  if (hit[2] && !isLoggedIn()) return requireLogin('#' + path + (query.toString() ? '?' + query : ''));
  // signed-in users do not need the login/register screens
  if (isLoggedIn() && /^\/(login|register|forgot|phone)$/.test(path)) return navigate('/home');
  view.innerHTML = skeleton();
  try {
    const r = await hit[1]({ params: path.match(hit[0]).slice(1), query });
    if (my !== token) { r?.cleanup?.(); return; }
    const el = r instanceof Node ? r : r.el;
    cleanup = r instanceof Node ? null : r.cleanup || null;
    view.replaceChildren(el);
  } catch (e) {
    if (my !== token) return;
    view.innerHTML = `<div class="empty"><div class="big">⚠️</div><h2>${esc(friendlyError(e))}</h2><button class="btn" id="retry">Try again</button></div>`;
    $('#retry').addEventListener('click', route);
  }
  markNav(path); scrollTo(0, 0);
}
function markNav(path) {
  const key = path.startsWith('/product') || path.startsWith('/shop') ? '/shop' : path.startsWith('/order') ? '/orders' : path === '/login' || path === '/register' ? '/profile' : path === '/builder' ? '/builder' : path;
  $$('#bottomnav a').forEach(a => a.classList.toggle('active', a.dataset.r === key));
}

// ---- header badges / auth state ----
function setBadge(el, n) { el.textContent = n > 99 ? '99+' : n; el.hidden = !n; }
async function refreshNotifBadge() {
  if (!isLoggedIn()) return setBadge($('#notif-badge'), 0);
  const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true }).eq('is_read', false);
  setBadge($('#notif-badge'), count || 0);
}
let notifChannel = null;
function onAuth() {
  const logged = isLoggedIn();
  $('#btn-login').hidden = logged; $('#btn-notif').hidden = !logged;
  $('#nav-profile').href = logged ? '#/profile' : '#/login';
  refreshNotifBadge();
  if (notifChannel) { sb.removeChannel(notifChannel); notifChannel = null; }
  if (logged) {
    notifChannel = sb.channel('notif-' + getUser().id).on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${getUser().id}` },
      p => { toast('🔔 ' + p.new.title); refreshNotifBadge(); }).subscribe();
  }
}
// re-render the page only when the user actually changes (not on token refresh / profile save)
let lastUid;
addEventListener('sstc:auth', () => {
  onAuth();
  const id = getUser()?.id || null;
  if (id !== lastUid) { lastUid = id; route(); }
});
addEventListener('sstc:notif', refreshNotifBadge);
addEventListener('sstc:cart', () => setBadge($('#cart-badge'), cartCount()));
addEventListener('storage', () => setBadge($('#cart-badge'), cartCount()));
addEventListener('hashchange', route);

// ---- offline banner ----
const offline = $('#offline');
const netState = () => { offline.hidden = navigator.onLine; };
addEventListener('online', () => { netState(); toast('Back online.', 'ok'); }); addEventListener('offline', netState); netState();

// ---- start ----
(async function start() {
  setBadge($('#cart-badge'), cartCount());
  const splash = runSplash();
  await initAuth().catch(e => console.error(e));
  // clean ?code=... left by email links (PKCE) so the URL stays tidy
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  await splash;
  if (!location.hash || location.hash === '#') location.hash = isLoggedIn() ? '#/home' : '#/login';
  else route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
