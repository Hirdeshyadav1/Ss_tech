// Catalogue: home, shop (search/filter/pagination), product details.
import { sb } from './supabase.js';
import { getSettings } from './settings.js';
import { addToCart } from './cart.js';
import { esc, money, toast, catIcon, stockBadge, navigate, debounce, fmtDate } from './utils.js';

const LIST = 'id,name,brand,model,price,discount_percent,final_price,image_url,stock_status,stock_quantity,category_id';
const PAGE = 12;
let catCache = null;
export async function getCategories() {
  if (!catCache) {
    const { data, error } = await sb.from('categories').select('id,slug,name,sort_order').eq('is_active', true).order('sort_order');
    if (error) throw error; catCache = data || [];
  }
  return catCache;
}
const img = p => p.image_url ? `<img loading="lazy" decoding="async" src="${esc(p.image_url)}" alt="${esc(p.name)}">` : `<div class="noimg">🖥️</div>`;
const isOut = s => s === 'OUT_OF_STOCK' || s === 'DISABLED';

export function productCard(p) {
  const off = Number(p.discount_percent) > 0, out = isOut(p.stock_status);
  return `<article class="pcard card">
    <a href="#/product/${esc(p.id)}" class="pimg">${img(p)}${off ? `<span class="off">-${Number(p.discount_percent)}%</span>` : ''}</a>
    <div class="pbody"><div class="pbrand">${esc(p.brand || '')}</div>
      <a class="pname" href="#/product/${esc(p.id)}">${esc(p.name)}</a>
      <div class="pprice"><b>${money(p.final_price)}</b>${off ? `<s>${money(p.price)}</s>` : ''}</div>
      ${stockBadge(p.stock_status)}
      <button class="btn sm block" data-add="${esc(p.id)}" ${out ? 'disabled' : ''}>${out ? 'Unavailable' : 'Add to cart'}</button></div></article>`;
}
export function bindAdd(root) {
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-add]'); if (!b || b.disabled) return;
    addToCart(b.dataset.add, Number(b.dataset.qty || 1)); toast('Added to cart.', 'ok');
  });
}

export async function homePage() {
  const root = document.createElement('div');
  const [cats, latest, offers, settings] = await Promise.all([
    getCategories(),
    sb.from('products').select(LIST).eq('is_active', true).order('created_at', { ascending: false }).limit(8).then(r => r.data || []),
    sb.from('coupons').select('code,description,discount_type,discount_value,min_order_value,ends_at').eq('is_public', true).eq('is_active', true).limit(6).then(r => r.data || []),
    getSettings().catch(() => ({}))
  ]);
  const shop = settings.shop || {};
  root.innerHTML = `
    <section class="hero glass">
      <img class="logo-img" src="logo.png" alt="SS.TECH & Computers" width="86" height="86">
      <div class="logo-text">SS_TECH_COMPUTER89</div>
      <div class="sub">COMPUTER • PC BUILD • SALES • SERVICE</div>
      ${shop.description ? `<div class="muted small desc">${esc(shop.description)}</div>` : ''}
      <form id="sf" class="searchbar" role="search"><input id="q" type="search" placeholder="Search CPU, GPU, RAM, brand…" aria-label="Search products"><button class="btn" type="submit">Search</button></form>
      <a href="#/builder" class="btn pink block builder-cta">🛠️ Build Your Own PC</a>
      <div class="trust">Quality Parts • Trusted Support • Customer Care</div>
    </section>
    <h2>Categories</h2>
    <div class="cats">${cats.map(c => `<a class="cat card" href="#/shop?cat=${esc(c.slug)}"><span>${catIcon(c.slug)}</span>${esc(c.name)}</a>`).join('')}</div>
    ${offers.length ? `<h2>Offers</h2><div class="offers">${offers.map(o => `<div class="offer card"><div class="code">${esc(o.code)}</div>
      <div>${o.discount_type === 'PERCENT' ? Number(o.discount_value) + '% off' : money(o.discount_value) + ' off'}${Number(o.min_order_value) ? ` on orders above ${money(o.min_order_value)}` : ''}</div>
      ${o.description ? `<div class="muted small">${esc(o.description)}</div>` : ''}${o.ends_at ? `<div class="muted small">Valid till ${esc(fmtDate(o.ends_at))}</div>` : ''}</div>`).join('')}</div>` : ''}
    <div class="row between"><h2>New arrivals</h2><a href="#/shop">View all →</a></div>
    <div class="grid">${latest.length ? latest.map(productCard).join('') : '<p class="muted">No products yet.</p>'}</div>
    <div class="card pad support-strip"><b>Need help?</b> ${shop.phone ? `Call <a href="tel:${esc(shop.phone)}">${esc(shop.phone)}</a> or ` : ''}<a href="#/support">contact support</a>.</div>`;
  root.querySelector('#sf').addEventListener('submit', e => {
    e.preventDefault(); const q = root.querySelector('#q').value.trim();
    navigate('/shop' + (q ? '?q=' + encodeURIComponent(q) : ''));
  });
  bindAdd(root);
  return root;
}

export async function shopPage({ query }) {
  const root = document.createElement('div');
  const cats = await getCategories();
  const { data: brandRows } = await sb.from('products').select('brand').eq('is_active', true).not('brand', 'is', null).limit(1000);
  const brands = [...new Set((brandRows || []).map(r => r.brand).filter(Boolean))].sort();
  const f = { q: query.get('q') || '', cat: query.get('cat') || '', brand: query.get('brand') || '', min: query.get('min') || '', max: query.get('max') || '', stock: query.get('stock') === '1', sort: query.get('sort') || 'new' };
  const cat = cats.find(c => c.slug === f.cat);

  root.innerHTML = `<h1>${cat ? esc(cat.name) : 'Shop'}</h1>
    <form id="ff" class="filters card pad">
      <input id="q" type="search" placeholder="Search products, brands…" value="${esc(f.q)}" aria-label="Search">
      <details ${f.brand || f.min || f.max || f.stock || f.sort !== 'new' ? 'open' : ''}><summary>Filters & sort</summary>
        <div class="two"><label>Category<select id="cat"><option value="">All</option>${cats.map(c => `<option value="${esc(c.slug)}" ${c.slug === f.cat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>Brand<select id="brand"><option value="">All</option>${brands.map(b => `<option ${b === f.brand ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></label></div>
        <div class="two"><label>Min ₹<input id="min" inputmode="numeric" value="${esc(f.min)}"></label><label>Max ₹<input id="max" inputmode="numeric" value="${esc(f.max)}"></label></div>
        <div class="two"><label>Sort<select id="sort">${[['new', 'Newest'], ['low', 'Price: low to high'], ['high', 'Price: high to low'], ['name', 'Name A–Z']].map(([v, l]) => `<option value="${v}" ${v === f.sort ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" id="stock" ${f.stock ? 'checked' : ''}> In stock only</label></div>
      </details><button class="btn block" type="submit">Apply</button></form>
    <div id="count" class="muted small"></div><div class="grid" id="grid"></div>
    <div class="center"><button class="btn ghost" id="more" hidden>Load more</button></div>`;

  root.querySelector('#ff').addEventListener('submit', e => {
    e.preventDefault(); const g = id => root.querySelector('#' + id);
    const p = new URLSearchParams();
    if (g('q').value.trim()) p.set('q', g('q').value.trim());
    if (g('cat').value) p.set('cat', g('cat').value);
    if (g('brand').value) p.set('brand', g('brand').value);
    if (/^\d+$/.test(g('min').value.trim())) p.set('min', g('min').value.trim());
    if (/^\d+$/.test(g('max').value.trim())) p.set('max', g('max').value.trim());
    if (g('stock').checked) p.set('stock', '1');
    if (g('sort').value !== 'new') p.set('sort', g('sort').value);
    navigate('/shop' + (p.toString() ? '?' + p : ''));
  });

  let page = 0, total = 0;
  const grid = root.querySelector('#grid'), more = root.querySelector('#more');
  async function load() {
    more.disabled = true;
    let q = sb.from('products').select(LIST, { count: 'exact' }).eq('is_active', true);
    if (cat) q = q.eq('category_id', cat.id);
    if (f.brand) q = q.eq('brand', f.brand);
    if (f.stock) q = q.gt('stock_quantity', 0);
    if (f.min) q = q.gte('final_price', Number(f.min));
    if (f.max) q = q.lte('final_price', Number(f.max));
    const s = f.q.replace(/[%,()*\\_]/g, ' ').trim();
    if (s) q = q.or(`name.ilike.%${s}%,brand.ilike.%${s}%,model.ilike.%${s}%`);
    q = f.sort === 'low' ? q.order('final_price') : f.sort === 'high' ? q.order('final_price', { ascending: false }) : f.sort === 'name' ? q.order('name') : q.order('created_at', { ascending: false });
    const { data, count, error } = await q.range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw error;
    total = count || 0;
    grid.insertAdjacentHTML('beforeend', (data || []).map(productCard).join(''));
    page++;
    root.querySelector('#count').textContent = total ? `${total} product${total > 1 ? 's' : ''}` : '';
    if (!total) grid.innerHTML = `<div class="empty"><div class="big">🔍</div><h3>No products found</h3><p class="muted">Try different search or filters.</p></div>`;
    more.hidden = page * PAGE >= total; more.disabled = false;
  }
  more.addEventListener('click', () => load().catch(() => toast('Something went wrong. Please try again.', 'bad')));
  bindAdd(root);
  await load();
  return root;
}

export async function productPage({ params }) {
  const root = document.createElement('div');
  const { data: p, error } = await sb.from('products').select('*').eq('id', params[0]).maybeSingle();
  if (error) throw error;
  if (!p) { root.innerHTML = `<div class="empty"><div class="big">😕</div><h2>Product not found</h2><a class="btn" href="#/shop">Back to shop</a></div>`; return root; }
  const { data: cat } = await sb.from('categories').select('name,slug').eq('id', p.category_id).maybeSingle();
  const { data: extra } = await sb.from('product_images').select('url').eq('product_id', p.id).order('sort_order').limit(6);
  const imgs = [p.image_url, ...(extra || []).map(x => x.url)].filter(Boolean);
  const off = Number(p.discount_percent) > 0, out = isOut(p.stock_status);
  const max = Math.max(1, Math.min(20, Number(p.stock_quantity)));
  const specs = Object.entries(p.specifications || {});
  const warranty = p.warranty_text || (p.warranty_months ? `${p.warranty_months} months` : '');
  root.innerHTML = `<a href="#/shop${cat ? '?cat=' + esc(cat.slug) : ''}" class="muted">← ${cat ? esc(cat.name) : 'Shop'}</a>
    <div class="cols pdetail"><div class="col">
      <div class="gallery card">${imgs.length ? `<img id="mainimg" src="${esc(imgs[0])}" alt="${esc(p.name)}">` : '<div class="noimg big">🖥️</div>'}</div>
      ${imgs.length > 1 ? `<div class="thumbs">${imgs.map(u => `<img loading="lazy" src="${esc(u)}" alt="" data-src="${esc(u)}">`).join('')}</div>` : ''}</div>
    <div class="col"><div class="pbrand">${esc(p.brand || '')} ${p.model ? '• ' + esc(p.model) : ''}</div><h1>${esc(p.name)}</h1>
      <div class="pprice big"><b>${money(p.final_price)}</b>${off ? `<s>${money(p.price)}</s><span class="off inline">-${Number(p.discount_percent)}%</span>` : ''}</div>
      ${stockBadge(p.stock_status)}${warranty ? `<div class="pill">Warranty: ${esc(warranty)}</div>` : ''}
      <div class="row buy"><div class="qty"><button class="btn sm ghost" id="dec" aria-label="Decrease">−</button><span id="q">1</span><button class="btn sm ghost" id="inc" aria-label="Increase">+</button></div>
        <button class="btn grow" id="add" ${out ? 'disabled' : ''}>${out ? 'Currently unavailable' : 'Add to cart'}</button></div>
      ${p.description ? `<h3>Description</h3><p class="pre">${esc(p.description)}</p>` : ''}
      ${specs.length ? `<h3>Specifications</h3><table class="specs">${specs.map(([k, v]) => `<tr><th>${esc(k.replace(/_/g, ' '))}</th><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('')}</table>` : ''}
    </div></div>`;
  let qty = 1; const qEl = root.querySelector('#q');
  root.querySelector('#inc').addEventListener('click', () => { if (qty < max) qEl.textContent = ++qty; });
  root.querySelector('#dec').addEventListener('click', () => { if (qty > 1) qEl.textContent = --qty; });
  root.querySelector('#add').addEventListener('click', () => { addToCart(p.id, qty); toast('Added to cart.', 'ok'); });
  root.querySelector('.thumbs')?.addEventListener('click', e => { const t = e.target.closest('[data-src]'); if (t) root.querySelector('#mainimg').src = t.dataset.src; });
  return root;
}
