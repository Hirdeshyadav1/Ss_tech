// Service worker: network-first for our own files (so updates show immediately), cache fallback when offline.
// Supabase API calls are never cached.
const CACHE = 'sstc-shell-v6';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'auth.js', 'cart.js', 'checkout.js', 'products.js', 'builder.js', 'orders.js', 'account.js', 'admin.js', 'admin2.js', 'delivery-app.js', 'razorpay.js', 'splash.js', 'utils.js', 'settings.js', 'supabase.js', 'config.js', 'logo.png', 'logo-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (/\.(mp4|webm)$/i.test(u.pathname)) return;
  e.respondWith(fetch(r).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); return res; }).catch(() => caches.match(r).then(m => m || caches.match('index.html'))));
});
