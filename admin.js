// Admin panel, part 1: shell + Dashboard, Products, Categories, Inventory, Coupons, Settings, Staff, Activity Logs.
// Part 2 (admin2.js) has Orders, Payments, Delivery, Customers, Support, Reports.
// SECURITY NOTE: every write here is still re-checked by Supabase RLS/RPCs (has_permission()).
// This client-side gating only decides what to *show*; it grants no extra power by itself.
import { sb } from './supabase.js';
import { getUser, getProfile } from './auth.js';
import { getCategories } from './products.js';
import { getSettings } from './settings.js';
import { esc, money, fmtDate, toast, friendlyError, navigate, confirmDialog, debounce, exportCSV, compressImage } from './utils.js';
import { ordersTab, paymentsTab, deliveryTab, customersTab, supportTab, reportsTab } from './admin2.js';

const ALL = 'products,inventory,orders,customers,payments,delivery,reports,coupons,settings,notifications,support'.split(',');
let permCache = null;
async function myPermissions() {
  if (permCache) return permCache;
  const p = getProfile();
  if (p?.role === 'ADMIN') return (permCache = new Set(ALL));
  if (p?.role !== 'STAFF') return (permCache = new Set());
  const { data } = await sb.from('staff_permissions').select('permission').eq('user_id', p.id);
  return (permCache = new Set((data || []).map(r => r.permission)));
}

const TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: '📊', perm: 'reports' },
  { key: 'products', label: 'Products', icon: '🖥️', perm: 'products' },
  { key: 'categories', label: 'Categories', icon: '🗂️', perm: 'products' },
  { key: 'inventory', label: 'Inventory', icon: '📦', perm: 'inventory' },
  { key: 'orders', label: 'Orders', icon: '🧾', perm: 'orders' },
  { key: 'customers', label: 'Customers', icon: '👥', perm: 'customers' },
  { key: 'payments', label: 'Payments', icon: '💳', perm: 'payments' },
  { key: 'delivery', label: 'Delivery', icon: '🚚', perm: 'delivery' },
  { key: 'coupons', label: 'Coupons', icon: '🏷️', perm: 'coupons' },
  { key: 'reports', label: 'Reports', icon: '📈', perm: 'reports' },
  { key: 'settings', label: 'Settings', icon: '⚙️', perm: 'settings' },
  { key: 'support', label: 'Support', icon: '💬', perm: 'support' },
  { key: 'staff', label: 'Staff', icon: '🧑‍💼', adminOnly: true },
  { key: 'logs', label: 'Activity Logs', icon: '📜', adminOnly: true }
];

export async function adminPage({ params }) {
  const root = document.createElement('div');
  const user = getUser(), profile = getProfile();
  if (!user || !['ADMIN', 'STAFF'].includes(profile?.role)) {
    root.innerHTML = `<div class="empty"><div class="big">🔒</div><h2>Access denied</h2><p class="muted">This area is for shop staff only.</p><a class="btn" href="#/home">Back to shop</a></div>`;
    return root;
  }
  const perms = await myPermissions();
  const visible = TABS.filter(t => t.adminOnly ? profile.role === 'ADMIN' : perms.has(t.perm));
  if (!visible.length) { root.innerHTML = `<div class="empty"><div class="big">🔒</div><h2>No admin access assigned</h2><a class="btn" href="#/home">Back to shop</a></div>`; return root; }
  const tab = visible.find(t => t.key === params[0]) ? params[0] : visible[0].key;

  root.innerHTML = `<div class="admin">
    <div class="row between wrap"><h1>Admin • ${esc(TABS.find(t => t.key === tab)?.label || '')}</h1>
      <span class="pill info">${esc(profile.role)}${profile.role === 'STAFF' ? ` (${[...perms].join(', ') || 'no permissions'})` : ''}</span></div>
    <nav class="admintabs">${visible.map(t => `<a href="#/admin/${t.key}" class="${t.key === tab ? 'active' : ''}">${t.icon} ${esc(t.label)}</a>`).join('')}</nav>
    <div id="adminview"><div class="skel"><div class="sk h"></div><div class="sk"></div></div></div></div>`;
  const view = root.querySelector('#adminview');
  try {
    const renderers = { dashboard: dashboardTab, products: productsTab, categories: categoriesTab, inventory: inventoryTab,
      orders: ordersTab, customers: customersTab, payments: paymentsTab, delivery: deliveryTab, coupons: couponsTab,
      reports: reportsTab, settings: settingsTab, support: supportTab, staff: staffTab, logs: logsTab };
    const el = await renderers[tab]();
    view.replaceChildren(el);
  } catch (e) {
    view.innerHTML = `<div class="formmsg bad">${esc(friendlyError(e))}</div>`;
  }
  return root;
}

// ============================= DASHBOARD =============================
async function dashboardTab() {
  const root = document.createElement('div');
  const today = new Date(), from7 = new Date(today.getTime() - 6 * 86400000);
  const iso = d => d.toISOString().slice(0, 10);
  const [{ data: s, error }, { data: daily }] = await Promise.all([
    sb.rpc('admin_dashboard_stats'),
    sb.rpc('report_sales_daily', { p_from: iso(from7), p_to: iso(today) })
  ]);
  if (error) throw error;
  const cards = [
    ["Today's orders", s.today_orders], ["Today's sales", money(s.today_sales)], ["Monthly sales", money(s.month_sales)],
    ['Pending orders', s.pending_orders], ['Completed orders', s.completed_orders], ['Cancelled orders', s.cancelled_orders],
    ['Pending payments', s.pending_payments], ['COD orders', s.cod_orders], ['Online orders', s.online_orders],
    ['Out for delivery', s.delivery_orders], ['PC builds', s.pc_builds], ['Customers', s.customers],
    ['Low stock', s.low_stock_products], ['Out of stock', s.out_of_stock_products]
  ];
  const max = Math.max(1, ...(daily || []).map(d => Number(d.revenue)));
  const byDate = Object.fromEntries((daily || []).map(d => [d.sale_date, d]));
  const days = [...Array(7)].map((_, i) => iso(new Date(from7.getTime() + i * 86400000)));
  root.innerHTML = `<div class="statgrid">${cards.map(([l, v]) => `<div class="card pad stat ${/low|out of/i.test(l) && v > 0 ? 'warn' : ''}"><div class="muted small">${esc(l)}</div><b>${v}</b></div>`).join('')}</div>
    <div class="card pad"><h3>Sales — last 7 days</h3><div class="bars">${days.map(d => {
      const r = byDate[d]; const h = r ? Math.max(4, Math.round(Number(r.revenue) / max * 90)) : 4;
      return `<div class="bar-col"><div class="bar" style="height:${h}px" title="${money(r?.revenue || 0)}"></div><span class="muted small">${d.slice(5)}</span></div>`;
    }).join('')}</div></div>`;
  return root;
}

// ============================= PRODUCTS =============================
const P_FIELDS = 'id,sku,name,brand,category_id,model,description,specifications,price,discount_percent,final_price,stock_quantity,minimum_stock,stock_status,is_active,image_url,model_3d_url,warranty_months,warranty_text,compatibility_data,created_at';
async function productsTab() {
  const root = document.createElement('div');
  const cats = await getCategories();
  root.innerHTML = `<div class="row between wrap"><button class="btn" id="add">+ Add product</button>
      <input id="q" type="search" placeholder="Search name / SKU / brand…" style="max-width:260px"></div>
    <div id="list" class="stack" style="margin-top:10px"></div>
    <div class="center"><button class="btn ghost" id="more" hidden>Load more</button></div>`;
  const list = root.querySelector('#list'), more = root.querySelector('#more');
  let page = 0, q = '';
  async function load(reset) {
    if (reset) { page = 0; list.innerHTML = ''; }
    let query = sb.from('products').select(P_FIELDS, { count: 'exact' }).order('created_at', { ascending: false });
    if (q) query = query.or(`name.ilike.%${q}%,sku.ilike.%${q}%,brand.ilike.%${q}%`);
    const { data, count, error } = await query.range(page * 20, page * 20 + 19);
    if (error) throw error;
    list.insertAdjacentHTML('beforeend', data.map(p => `<div class="card pad prow">
      <div class="slotimg">${p.image_url ? `<img loading="lazy" src="${esc(p.image_url)}" alt="">` : '<span>🖥️</span>'}</div>
      <div class="grow"><b>${esc(p.name)}</b> ${!p.is_active ? '<span class="pill bad">Inactive</span>' : ''}
        <div class="muted small">${esc(p.sku)} • ${esc(cats.find(c => c.id === p.category_id)?.name || '')}</div>
        <div class="muted small">${money(p.final_price)}${p.discount_percent > 0 ? ` <s>${money(p.price)}</s>` : ''} • Stock ${p.stock_quantity} (${p.stock_status.replace('_', ' ')})</div></div>
      <button class="btn sm ghost" data-edit="${esc(p.id)}">Edit</button></div>`).join(''));
    page++; more.hidden = page * 20 >= (count || 0);
  }
  root.querySelector('#q').addEventListener('input', debounce(e => { q = e.target.value.trim(); load(true); }, 350));
  more.addEventListener('click', () => load(false).catch(e => toast(friendlyError(e), 'bad')));
  root.querySelector('#add').addEventListener('click', () => openProductForm(null, cats, () => load(true)));
  list.addEventListener('click', async e => {
    const b = e.target.closest('[data-edit]'); if (!b) return;
    const { data } = await sb.from('products').select(P_FIELDS).eq('id', b.dataset.edit).single();
    openProductForm(data, cats, () => load(true));
  });
  await load(true);
  return root;
}

async function openProductForm(p, cats, onSaved) {
  const isNew = !p;
  let gallery = [];
  if (!isNew) {
    try {
      const { data } = await sb.from('product_images').select('*').eq('product_id', p.id).order('sort_order');
      gallery = data || [];
    } catch { gallery = []; }
  }
  const STEP_LABELS = ['Basic info', 'Pricing & stock', 'Photos', 'Specifications'];
  const v = {
    sku: p?.sku || '', category_id: p?.category_id || (cats[0]?.id || ''), name: p?.name || '', brand: p?.brand || '',
    model: p?.model || '', description: p?.description || '', price: p?.price ?? '', discount_percent: p?.discount_percent ?? 0,
    stock_quantity: 0, minimum_stock: p?.minimum_stock ?? 5, warranty_months: p?.warranty_months ?? 0, warranty_text: p?.warranty_text || '',
    specifications: JSON.stringify(p?.specifications || {}, null, 0), compatibility_data: JSON.stringify(p?.compatibility_data || {}, null, 0),
    is_active: p?.is_active !== false
  };
  let step = 1;
  const overlay = document.createElement('div'); overlay.className = 'modal';
  overlay.innerHTML = `<div class="dialog glass picker" role="dialog" aria-modal="true">
    <div class="row between"><h3>${isNew ? 'Add product' : 'Edit product'}</h3><button class="btn sm ghost" id="close">✕</button></div>
    <div class="wizard-steps">${STEP_LABELS.map((l, i) => `<span class="${i + 1 === step ? 'on' : ''}" data-dot="${i + 1}">${i + 1}</span>`).join('')}</div>
    <div id="body"></div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#close').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  const body = overlay.querySelector('#body');
  const dots = () => overlay.querySelectorAll('.wizard-steps span').forEach(el => {
    const i = Number(el.dataset.dot); el.className = i === step ? 'on' : i < step ? 'done' : '';
  });

  function drawStep1() {
    body.innerHTML = `<form id="f1" novalidate class="stack">
      <div class="two"><label>SKU<input name="sku" value="${esc(v.sku)}" required></label>
      <label>Category<select name="category_id" required>${cats.map(c => `<option value="${esc(c.id)}" ${c.id === v.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label></div>
      <label>Name<input name="name" value="${esc(v.name)}" required></label>
      <div class="two"><label>Brand<input name="brand" value="${esc(v.brand)}"></label><label>Model<input name="model" value="${esc(v.model)}"></label></div>
      <label>Description<textarea name="description" rows="2">${esc(v.description)}</textarea></label>
      <div class="formmsg" role="alert"></div>
      <button class="btn block" type="submit">Next: Pricing & stock</button>
    </form>`;
    const f = body.querySelector('#f1'), msg = f.querySelector('.formmsg');
    f.addEventListener('submit', e => {
      e.preventDefault();
      if (!f.sku.value.trim() || !f.name.value.trim()) { msg.textContent = 'SKU and name are required.'; msg.className = 'formmsg bad'; return; }
      Object.assign(v, { sku: f.sku.value.trim(), category_id: f.category_id.value, name: f.name.value.trim(),
        brand: f.brand.value.trim(), model: f.model.value.trim(), description: f.description.value.trim() });
      step = 2; draw();
    });
  }

  function drawStep2() {
    body.innerHTML = `<form id="f2" novalidate class="stack">
      <div class="two"><label>Price ₹<input name="price" type="number" min="0" step="0.01" value="${v.price}" required></label>
      <label>Discount %<input name="discount_percent" type="number" min="0" max="100" step="0.1" value="${v.discount_percent}"></label></div>
      ${isNew ? `<label>Opening stock<input name="stock_quantity" type="number" min="0" value="${v.stock_quantity}" required></label>`
        : `<label>Stock<input value="${p.stock_quantity} (${p.stock_status.replace('_', ' ')}) — change from the Inventory tab" disabled></label>`}
      <label>Minimum stock (low-stock alert)<input name="minimum_stock" type="number" min="0" value="${v.minimum_stock}"></label>
      <div class="two"><label>Warranty (months)<input name="warranty_months" type="number" min="0" value="${v.warranty_months}"></label>
      <label>Warranty text<input name="warranty_text" value="${esc(v.warranty_text)}"></label></div>
      <div class="formmsg" role="alert"></div>
      <div class="row"><button type="button" class="btn ghost" id="back">Back</button><button class="btn grow" type="submit">Next: Photos</button></div>
    </form>`;
    const f = body.querySelector('#f2'), msg = f.querySelector('.formmsg');
    body.querySelector('#back').addEventListener('click', () => { step = 1; draw(); });
    f.addEventListener('submit', e => {
      e.preventDefault();
      if (Number(f.price.value) < 0 || f.price.value === '') { msg.textContent = 'Enter a valid price.'; msg.className = 'formmsg bad'; return; }
      Object.assign(v, { price: f.price.value, discount_percent: f.discount_percent.value,
        stock_quantity: isNew ? f.stock_quantity.value : 0, minimum_stock: f.minimum_stock.value,
        warranty_months: f.warranty_months.value, warranty_text: f.warranty_text.value.trim() });
      step = 3; draw();
    });
  }

  function drawStep3() {
    body.innerHTML = `<div class="stack">
      <label>Photos (you can select multiple, first one is used as the main photo)<input type="file" id="image_files" accept="image/png,image/jpeg,image/webp" multiple></label>
      <div id="gallery" class="ss-gallery">${gallery.map(g => `<div class="galitem"><img src="${esc(g.url)}" alt=""><button type="button" class="galdel" data-imgid="${esc(g.id)}" aria-label="Remove photo">✕</button></div>`).join('')}</div>
      ${isNew ? '<p class="muted small">New photos upload once you finish and save on the last step.</p>' : '<p class="muted small">Existing photos can be removed now. New photos upload when you save.</p>'}
      <div class="row"><button type="button" class="btn ghost" id="back">Back</button><button class="btn grow" id="next">Next: Specifications</button></div>
    </div>`;
    body.querySelector('#gallery').addEventListener('click', async e => {
      const b = e.target.closest('[data-imgid]'); if (!b) return;
      if (!await confirmDialog('Remove this photo?', '', 'Remove')) return;
      const { error } = await sb.from('product_images').delete().eq('id', b.dataset.imgid);
      if (error) return toast(friendlyError(error), 'bad');
      gallery = gallery.filter(g => g.id !== b.dataset.imgid);
      b.closest('.galitem').remove();
      await sb.from('products').update({ image_url: gallery[0]?.url || null }).eq('id', p.id);
    });
    body.querySelector('#back').addEventListener('click', () => { step = 2; draw(); });
    body.querySelector('#next').addEventListener('click', () => {
      v.pendingFiles = [...body.querySelector('#image_files').files];
      step = 4; draw();
    });
  }

  function drawStep4() {
    body.innerHTML = `<form id="f4" novalidate class="stack">
      <label>Specifications (JSON)<textarea name="specifications" rows="2" spellcheck="false">${esc(v.specifications)}</textarea></label>
      <label>Compatibility data (JSON — socket, ram_type, wattage…)<textarea name="compatibility_data" rows="2" spellcheck="false">${esc(v.compatibility_data)}</textarea></label>
      <label class="check"><input type="checkbox" name="is_active" ${v.is_active ? 'checked' : ''}> Active (visible to customers)</label>
      <div class="formmsg" role="alert"></div>
      <div class="row between">
        <button type="button" class="btn ghost" id="back">Back</button>
        ${!isNew ? `<button type="button" class="btn ghost" id="deactivate">${p.is_active ? 'Deactivate' : 'Reactivate'}</button>` : ''}
        <button class="btn" type="submit">${isNew ? 'Create product' : 'Save changes'}</button></div>
    </form>`;
    const f = body.querySelector('#f4'), msg = f.querySelector('.formmsg');
    const bad = t => { msg.textContent = t; msg.className = 'formmsg bad'; };
    body.querySelector('#back').addEventListener('click', () => { step = 3; draw(); });

    body.querySelector('#deactivate')?.addEventListener('click', async () => {
      if (!await confirmDialog(p.is_active ? 'Deactivate this product?' : 'Reactivate this product?', 'Existing orders are never affected.', 'Confirm')) return;
      const { error } = await sb.from('products').update({ is_active: !p.is_active }).eq('id', p.id);
      if (error) return toast(friendlyError(error), 'bad');
      toast('Updated.', 'ok'); close(); onSaved();
    });

    f.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      let specs, compat;
      try { specs = JSON.parse(f.specifications.value || '{}'); compat = JSON.parse(f.compatibility_data.value || '{}'); }
      catch { return bad('Specifications / compatibility data must be valid JSON.'); }
      btn.disabled = true; btn.textContent = 'Saving…';
      const payload = {
        sku: v.sku, category_id: v.category_id, name: v.name, brand: v.brand || null, model: v.model || null,
        description: v.description || null, price: Number(v.price), discount_percent: Number(v.discount_percent) || 0,
        minimum_stock: Number(v.minimum_stock) || 0, warranty_months: Number(v.warranty_months) || 0,
        warranty_text: v.warranty_text || null, specifications: specs, compatibility_data: compat,
        is_active: f.is_active.checked
      };
      if (isNew) payload.stock_quantity = Number(v.stock_quantity) || 0;
      try {
        let id = p?.id;
        if (isNew) {
          const { data, error } = await sb.from('products').insert(payload).select('id').single();
          if (error) throw error; id = data.id;
        } else {
          const { error } = await sb.from('products').update(payload).eq('id', id);
          if (error) throw error;
        }
        const files = v.pendingFiles || [];
        if (files.length) {
          try {
            let sort = gallery.length ? Math.max(...gallery.map(g => g.sort_order)) + 1 : 0;
            for (let i = 0; i < files.length; i++) {
              btn.textContent = `Uploading photo ${i + 1}/${files.length}…`;
              const small = await compressImage(files[i]);
              const path = `${id}/${Date.now()}-${sort}-${small.name.replace(/[^\w.-]/g, '_')}`;
              const { error: upErr } = await sb.storage.from('product-images').upload(path, small, { upsert: true, contentType: small.type });
              if (upErr) throw upErr;
              const { data: pub } = sb.storage.from('product-images').getPublicUrl(path);
              const { error: insErr } = await sb.from('product_images').insert({ product_id: id, url: pub.publicUrl, sort_order: sort });
              if (insErr) throw insErr;
              gallery.push({ url: pub.publicUrl, sort_order: sort });
              sort++;
            }
            const primary = [...gallery].sort((a, b) => a.sort_order - b.sort_order)[0];
            if (primary) { const { error: linkErr } = await sb.from('products').update({ image_url: primary.url }).eq('id', id); if (linkErr) throw linkErr; }
          } catch (imgErr) {
            toast(isNew ? 'Product created, but photo upload failed. Edit the product to try again.' : 'Saved, but photo upload failed. Try again with a different photo.', 'bad');
            console.error('[image upload]', imgErr);
            close(); onSaved(); return;
          }
        }
        toast(isNew ? 'Product created.' : 'Product saved.', 'ok'); close(); onSaved();
      } catch (err) { bad(friendlyError(err)); btn.disabled = false; btn.textContent = isNew ? 'Create product' : 'Save changes'; }
    });
  }

  function draw() { dots(); ({ 1: drawStep1, 2: drawStep2, 3: drawStep3, 4: drawStep4 })[step](); }
  draw();
}

// ============================= CATEGORIES =============================
async function categoriesTab() {
  const root = document.createElement('div');
  const { data, error } = await sb.from('categories').select('*').order('sort_order');
  if (error) throw error;
  root.innerHTML = `<button class="btn" id="add">+ Add category</button>
    <div class="stack" style="margin-top:10px">${data.map(c => `<div class="card pad row between">
      <div>${esc(c.icon || '📦')} <b>${esc(c.name)}</b> <span class="muted small">(${esc(c.slug)})</span> ${!c.is_active ? '<span class="pill bad">Inactive</span>' : ''}</div>
      <button class="btn sm ghost" data-edit="${esc(c.id)}">Edit</button></div>`).join('')}</div>`;
  function openForm(cat) {
    const overlay = document.createElement('div'); overlay.className = 'modal';
    overlay.innerHTML = `<div class="dialog glass" role="dialog" aria-modal="true"><h3>${cat ? 'Edit' : 'Add'} category</h3>
      <form id="f" class="stack" novalidate>
        <label>Name<input name="name" value="${esc(cat?.name || '')}" required></label>
        <label>Slug (used in the PC Builder — cpu, motherboard, ram, gpu, ssd, hdd, psu, cabinet, cpu-cooler, monitor, keyboard, mouse, …)<input name="slug" value="${esc(cat?.slug || '')}" required></label>
        <label>Icon (emoji)<input name="icon" value="${esc(cat?.icon || '')}" maxlength="4"></label>
        <label>Sort order<input name="sort_order" type="number" value="${cat?.sort_order ?? 0}"></label>
        <label class="check"><input type="checkbox" name="is_active" ${cat?.is_active !== false ? 'checked' : ''}> Active</label>
        <div class="formmsg" role="alert"></div>
        <div class="row end"><button type="button" class="btn ghost" id="cancel">Cancel</button><button class="btn" type="submit">Save</button></div>
      </form></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#cancel').onclick = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#f').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target, msg = overlay.querySelector('.formmsg');
      const payload = { name: f.name.value.trim(), slug: f.slug.value.trim().toLowerCase(), icon: f.icon.value.trim() || null, sort_order: Number(f.sort_order.value) || 0, is_active: f.is_active.checked };
      if (!payload.name || !payload.slug) { msg.textContent = 'Name and slug are required.'; msg.className = 'formmsg bad'; return; }
      const q = cat ? sb.from('categories').update(payload).eq('id', cat.id) : sb.from('categories').insert(payload);
      const { error } = await q;
      if (error) { msg.textContent = friendlyError(error); msg.className = 'formmsg bad'; return; }
      toast('Saved.', 'ok'); overlay.remove(); categoriesTab().then(el => root.replaceWith(el));
    });
  }
  root.querySelector('#add').addEventListener('click', () => openForm(null));
  root.addEventListener('click', e => { const b = e.target.closest('[data-edit]'); if (b) openForm(data.find(c => c.id === b.dataset.edit)); });
  return root;
}

// ============================= INVENTORY =============================
async function inventoryTab() {
  const root = document.createElement('div');
  root.innerHTML = `<div class="admin-subtabs"><button class="active" data-t="alerts">Low / out of stock</button><button data-t="adjust">Adjust stock</button><button data-t="history">Stock history</button></div><div id="sub"></div>`;
  const sub = root.querySelector('#sub');
  async function alerts() {
    const { data, error } = await sb.from('products').select('id,name,sku,stock_quantity,minimum_stock,stock_status').in('stock_status', ['LOW_STOCK', 'OUT_OF_STOCK']).order('stock_quantity');
    if (error) throw error;
    sub.innerHTML = data.length ? `<div class="stack">${data.map(p => `<div class="card pad row between">
      <div><b>${esc(p.name)}</b> <span class="muted small">${esc(p.sku)}</span></div>
      <span class="pill ${p.stock_status === 'OUT_OF_STOCK' ? 'bad' : 'warn'}">${p.stock_quantity} left</span></div>`).join('')}</div>`
      : '<p class="muted">Nothing low or out of stock. 🎉</p>';
  }
  async function adjust() {
    sub.innerHTML = `<div class="card pad"><form id="f" class="stack" novalidate>
      <label>Product<input id="psearch" placeholder="Search SKU or name…" autocomplete="off"></label>
      <div id="presult" class="stack"></div>
      <input type="hidden" name="product_id">
      <label>Type<select name="type"><option value="PURCHASE">Purchase (stock in)</option><option value="RETURN">Customer return (stock in)</option>
        <option value="DAMAGE">Damaged (stock out)</option><option value="ADJUSTMENT">Manual adjustment (+/-)</option></select></label>
      <label>Quantity<input name="qty" type="number" required placeholder="e.g. 10, or -2 for adjustment"></label>
      <label>Note<input name="note" maxlength="200"></label>
      <div class="formmsg" role="alert"></div>
      <button class="btn block" type="submit">Apply</button></form></div>`;
    const f = sub.querySelector('#f'); let chosen = null;
    sub.querySelector('#psearch').addEventListener('input', debounce(async e => {
      const s = e.target.value.trim(); if (s.length < 2) { sub.querySelector('#presult').innerHTML = ''; return; }
      const { data } = await sb.from('products').select('id,name,sku,stock_quantity').or(`name.ilike.%${s}%,sku.ilike.%${s}%`).limit(6);
      sub.querySelector('#presult').innerHTML = (data || []).map(p => `<button type="button" class="card pad pickrow" data-id="${esc(p.id)}"><div class="grow">${esc(p.name)} <span class="muted small">${esc(p.sku)}</span></div><b>${p.stock_quantity}</b></button>`).join('');
    }, 300));
    sub.querySelector('#presult').addEventListener('click', e => {
      const b = e.target.closest('[data-id]'); if (!b) return;
      chosen = b.dataset.id; f.product_id.value = chosen;
      sub.querySelector('#psearch').value = b.textContent.trim();
      sub.querySelector('#presult').innerHTML = '';
    });
    f.addEventListener('submit', async e => {
      e.preventDefault(); const msg = f.querySelector('.formmsg'), btn = f.querySelector('button');
      if (!chosen) { msg.textContent = 'Please select a product.'; msg.className = 'formmsg bad'; return; }
      const qty = Number(f.qty.value);
      if (!qty) { msg.textContent = 'Enter a non-zero quantity.'; msg.className = 'formmsg bad'; return; }
      btn.disabled = true;
      const { error } = await sb.rpc('admin_adjust_stock', { p_product_id: chosen, p_type: f.type.value, p_delta: qty, p_note: f.note.value.trim() || null });
      btn.disabled = false;
      if (error) { msg.textContent = friendlyError(error); msg.className = 'formmsg bad'; return; }
      toast('Stock updated.', 'ok'); f.reset(); chosen = null;
    });
  }
  async function history() {
    const { data, error } = await sb.from('inventory_transactions').select('*, products(name,sku)').order('created_at', { ascending: false }).limit(80);
    if (error) throw error;
    sub.innerHTML = `<div class="row end"><button class="btn sm ghost" id="exp">Export CSV</button></div>
      <div class="stack">${data.map(t => `<div class="card pad row between">
      <div><b>${esc(t.products?.name || 'Product')}</b> <span class="muted small">${esc(t.products?.sku || '')}</span><div class="muted small">${esc(t.txn_type)} • ${esc(fmtDate(t.created_at))}</div></div>
      <b class="${t.quantity_change > 0 ? 'ok' : 'bad'}">${t.quantity_change > 0 ? '+' : ''}${t.quantity_change}</b></div>`).join('')}</div>`;
    sub.querySelector('#exp').addEventListener('click', () => exportCSV('stock-history.csv', data.map(t => ({ date: t.created_at, product: t.products?.name, sku: t.products?.sku, type: t.txn_type, change: t.quantity_change, before: t.stock_before, after: t.stock_after, note: t.note }))));
  }
  const fns = { alerts, adjust, history };
  root.querySelector('.admin-subtabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    root.querySelectorAll('.admin-subtabs button').forEach(x => x.classList.toggle('active', x === b));
    fns[b.dataset.t]().catch(err => toast(friendlyError(err), 'bad'));
  });
  await alerts();
  return root;
}

// ============================= COUPONS =============================
async function couponsTab() {
  const root = document.createElement('div');
  const { data, error } = await sb.from('coupons').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  root.innerHTML = `<button class="btn" id="add">+ Create coupon</button>
    <div class="stack" style="margin-top:10px">${data.map(c => `<div class="card pad row between wrap">
      <div><b>${esc(c.code)}</b> ${!c.is_active ? '<span class="pill bad">Inactive</span>' : ''} ${c.is_public ? '<span class="pill ok">Public</span>' : ''}
        <div class="muted small">${c.discount_type === 'PERCENT' ? c.discount_value + '% off' : money(c.discount_value) + ' off'} • min ${money(c.min_order_value)} • used ${c.used_count}${c.usage_limit ? '/' + c.usage_limit : ''}</div></div>
      <button class="btn sm ghost" data-edit="${esc(c.id)}">Edit</button></div>`).join('') || '<p class="muted">No coupons yet.</p>'}</div>`;
  function openForm(c) {
    const overlay = document.createElement('div'); overlay.className = 'modal';
    overlay.innerHTML = `<div class="dialog glass picker" role="dialog" aria-modal="true"><h3>${c ? 'Edit' : 'Create'} coupon</h3>
      <form id="f" class="stack" novalidate>
        <label>Code<input name="code" value="${esc(c?.code || '')}" style="text-transform:uppercase" required></label>
        <label>Description<input name="description" value="${esc(c?.description || '')}"></label>
        <div class="two"><label>Type<select name="discount_type"><option value="PERCENT" ${c?.discount_type === 'PERCENT' ? 'selected' : ''}>Percent</option><option value="FIXED" ${c?.discount_type === 'FIXED' ? 'selected' : ''}>Fixed ₹</option></select></label>
        <label>Value<input name="discount_value" type="number" min="0.01" step="0.01" value="${c?.discount_value ?? ''}" required></label></div>
        <div class="two"><label>Min order value ₹<input name="min_order_value" type="number" min="0" value="${c?.min_order_value ?? 0}"></label>
        <label>Max discount ₹ (optional)<input name="max_discount" type="number" min="0" value="${c?.max_discount ?? ''}"></label></div>
        <div class="two"><label>Starts (optional)<input name="starts_at" type="date" value="${c?.starts_at ? c.starts_at.slice(0, 10) : ''}"></label>
        <label>Ends (optional)<input name="ends_at" type="date" value="${c?.ends_at ? c.ends_at.slice(0, 10) : ''}"></label></div>
        <div class="two"><label>Total usage limit<input name="usage_limit" type="number" min="1" value="${c?.usage_limit ?? ''}"></label>
        <label>Per-user limit<input name="per_user_limit" type="number" min="1" value="${c?.per_user_limit ?? ''}"></label></div>
        <label class="check"><input type="checkbox" name="is_public" ${c?.is_public ? 'checked' : ''}> Show on Offers page</label>
        <label class="check"><input type="checkbox" name="is_active" ${c?.is_active !== false ? 'checked' : ''}> Active</label>
        <div class="formmsg" role="alert"></div>
        <div class="row end"><button type="button" class="btn ghost" id="cancel">Cancel</button><button class="btn" type="submit">Save</button></div>
      </form></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#cancel').onclick = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#f').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target, msg = overlay.querySelector('.formmsg');
      if (!f.code.value.trim() || !f.discount_value.value) { msg.textContent = 'Code and value are required.'; msg.className = 'formmsg bad'; return; }
      const payload = {
        code: f.code.value.trim().toUpperCase(), description: f.description.value.trim() || null, discount_type: f.discount_type.value,
        discount_value: Number(f.discount_value.value), min_order_value: Number(f.min_order_value.value) || 0,
        max_discount: f.max_discount.value ? Number(f.max_discount.value) : null,
        starts_at: f.starts_at.value || null, ends_at: f.ends_at.value || null,
        usage_limit: f.usage_limit.value ? Number(f.usage_limit.value) : null, per_user_limit: f.per_user_limit.value ? Number(f.per_user_limit.value) : null,
        is_public: f.is_public.checked, is_active: f.is_active.checked
      };
      const q = c ? sb.from('coupons').update(payload).eq('id', c.id) : sb.from('coupons').insert(payload);
      const { error } = await q;
      if (error) { msg.textContent = friendlyError(error); msg.className = 'formmsg bad'; return; }
      toast('Saved.', 'ok'); overlay.remove(); couponsTab().then(el => root.replaceWith(el));
    });
  }
  root.querySelector('#add').addEventListener('click', () => openForm(null));
  root.addEventListener('click', e => { const b = e.target.closest('[data-edit]'); if (b) openForm(data.find(c => c.id === b.dataset.edit)); });
  return root;
}

// ============================= SETTINGS =============================
async function settingsTab() {
  const root = document.createElement('div');
  const { data, error } = await sb.from('app_settings').select('*');
  if (error) throw error;
  const s = Object.fromEntries(data.map(r => [r.key, r.value]));
  const shop = s.shop || {}, pm = s.payment_methods || {}, tax = s.tax || {}, maint = s.maintenance_mode || {}, upi = s.upi || {}, razorpay = s.razorpay || {};
  const { data: ds } = await sb.from('delivery_settings').select('*').eq('is_active', true).limit(1).maybeSingle();
  const d = ds || {};
  root.innerHTML = `<div class="stack">
    <div class="card pad"><h3>Shop info</h3><form id="fshop" class="stack" novalidate>
      <label>Shop name<input name="name" value="${esc(shop.name || '')}"></label>
      <label>Tagline<input name="tagline" value="${esc(shop.tagline || '')}"></label>
      <div class="two"><label>Phone<input name="phone" value="${esc(shop.phone || '')}"></label><label>Email<input name="email" value="${esc(shop.email || '')}"></label></div>
      <div class="two"><label>WhatsApp<input name="whatsapp" value="${esc(shop.whatsapp || '')}"></label><label>Instagram<input name="instagram" value="${esc(shop.instagram || '')}"></label></div>
      <label>Address<input name="address" value="${esc(shop.address || '')}"></label>
      <label>Business hours<input name="business_hours" value="${esc(shop.business_hours || '')}"></label>
      <label>Description<textarea name="description" rows="2">${esc(shop.description || '')}</textarea></label>
      <button class="btn" type="submit">Save shop info</button></form></div>

    <div class="card pad"><h3>Payment methods</h3><form id="fpay" class="stack" novalidate>
      <label class="check"><input type="checkbox" name="ONLINE" ${pm.ONLINE ? 'checked' : ''}> Online Payment — customer pays via your UPI ID/QR below; you confirm receipt in the Payments tab</label>
      <label class="check"><input type="checkbox" name="COD" ${pm.COD ? 'checked' : ''}> Cash on Delivery</label>
      <label class="check"><input type="checkbox" name="PAY_AT_SHOP" ${pm.PAY_AT_SHOP ? 'checked' : ''}> Pay at Shop</label>
      <button class="btn" type="submit">Save payment methods</button></form></div>

    <div class="card pad"><h3>UPI payment details</h3><form id="fupi" class="stack" novalidate>
      <label>UPI ID<input name="upi_id" value="${esc(upi.upi_id || '')}" placeholder="yourshop@upi"></label>
      <label>QR code image<input type="file" name="qr_file" accept="image/png,image/jpeg,image/webp"></label>
      ${upi.qr_url ? `<img src="${esc(upi.qr_url)}" alt="UPI QR" style="max-height:150px;border-radius:10px">` : ''}
      <div class="formmsg" role="alert"></div>
      <button class="btn" type="submit">Save UPI details</button></form>
      <p class="muted small">Shown to customers at checkout when they choose Online Payment. Orders stay "Payment Pending" until you mark them Paid in the Payments tab after receiving the money.</p></div>

    <div class="card pad"><h3>Razorpay (Card / UPI / Netbanking)</h3><form id="frzp" class="stack" novalidate>
      <label class="check"><input type="checkbox" name="enabled" ${razorpay.enabled ? 'checked' : ''}> Enable real Razorpay checkout for Online Payment</label>
      <label>Razorpay Key Id<input name="key_id" value="${esc(razorpay.key_id || '')}" placeholder="rzp_test_... or rzp_live_..."></label>
      <div class="formmsg" role="alert"></div>
      <button class="btn" type="submit">Save Razorpay settings</button></form>
      <p class="muted small">Only the Key Id goes here - it's safe to be public. The Key Secret is never entered in the app; it's set up separately via a terminal (see supabase/RAZORPAY-SETUP.md). Until that setup is done, turning this on will show an error - keep it off and customers will use the manual UPI QR above instead.</p></div>

    <div class="card pad"><h3>Tax</h3><form id="ftax" class="stack" novalidate>
      <label class="check"><input type="checkbox" name="enabled" ${tax.enabled ? 'checked' : ''}> Enable tax</label>
      <div class="two"><label>Percent<input name="percent" type="number" min="0" step="0.01" value="${tax.percent ?? 0}"></label>
      <label class="check" style="margin-top:22px"><input type="checkbox" name="inclusive" ${tax.inclusive ? 'checked' : ''}> Price includes tax</label></div>
      <button class="btn" type="submit">Save tax settings</button></form></div>

    <div class="card pad"><h3>Delivery</h3><form id="fdel" class="stack" novalidate>
      <label>Mode<select name="mode"><option value="FIXED" ${d.mode === 'FIXED' ? 'selected' : ''}>Fixed</option><option value="FREE" ${d.mode === 'FREE' ? 'selected' : ''}>Free</option><option value="PER_KM" ${d.mode === 'PER_KM' ? 'selected' : ''}>Base + per KM</option></select></label>
      <div class="two"><label>Fixed charge ₹<input name="fixed_charge" type="number" min="0" value="${d.fixed_charge ?? 0}"></label><label>Base charge ₹<input name="base_charge" type="number" min="0" value="${d.base_charge ?? 0}"></label></div>
      <div class="two"><label>Per KM ₹<input name="per_km_charge" type="number" min="0" value="${d.per_km_charge ?? 0}"></label><label>Default distance (km)<input name="default_distance_km" type="number" min="0" value="${d.default_distance_km ?? 5}"></label></div>
      <div class="two"><label>Min charge ₹<input name="min_charge" type="number" min="0" value="${d.min_charge ?? 0}"></label><label>Max charge ₹ (optional)<input name="max_charge" type="number" min="0" value="${d.max_charge ?? ''}"></label></div>
      <label>Free delivery above ₹ (optional)<input name="free_above_amount" type="number" min="0" value="${d.free_above_amount ?? ''}"></label>
      <button class="btn" type="submit">Save delivery settings</button></form></div>

    <div class="card pad"><h3>Maintenance mode</h3><form id="fmaint" class="stack" novalidate>
      <label class="check"><input type="checkbox" name="enabled" ${maint.enabled ? 'checked' : ''}> Put the shop in maintenance mode (blocks new orders)</label>
      <label>Message<input name="message" value="${esc(maint.message || 'We will be back shortly.')}"></label>
      <button class="btn ${maint.enabled ? 'pink' : ''}" type="submit">Save</button></form></div>
  </div>`;

  async function upsertSetting(key, value, isPublic = true) {
    const { error } = await sb.from('app_settings').upsert({ key, value, is_public: isPublic }, { onConflict: 'key' });
    if (error) throw error;
    await getSettings(true); // refresh the cached settings so Checkout/Home see the change immediately, no reload needed
  }
  root.querySelector('#fshop').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    const v = Object.fromEntries(['name', 'tagline', 'phone', 'email', 'whatsapp', 'instagram', 'address', 'business_hours', 'description'].map(k => [k, f[k].value.trim()]));
    try { await upsertSetting('shop', v); toast('Shop info saved.', 'ok'); } catch (err) { toast(friendlyError(err), 'bad'); }
  });
  root.querySelector('#fpay').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    try { await upsertSetting('payment_methods', { ONLINE: f.ONLINE.checked, COD: f.COD.checked, PAY_AT_SHOP: f.PAY_AT_SHOP.checked }); toast('Payment methods saved.', 'ok'); } catch (err) { toast(friendlyError(err), 'bad'); }
  });
  root.querySelector('#fupi').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target, btn = f.querySelector('button'), msg = f.querySelector('.formmsg');
    btn.disabled = true;
    try {
      let qr_url = upi.qr_url || null;
      const file = f.qr_file.files[0];
      if (file) {
        const small = await compressImage(file, 900, 0.9);
        const path = `upi-qr/${Date.now()}-${small.name.replace(/[^\w.-]/g, '_')}`;
        const { error: upErr } = await sb.storage.from('product-images').upload(path, small, { upsert: true, contentType: small.type });
        if (upErr) throw upErr;
        qr_url = sb.storage.from('product-images').getPublicUrl(path).data.publicUrl;
      }
      await upsertSetting('upi', { upi_id: f.upi_id.value.trim(), qr_url });
      msg.textContent = 'Saved.'; msg.className = 'formmsg ok'; toast('UPI details saved.', 'ok');
    } catch (err) { msg.textContent = friendlyError(err); msg.className = 'formmsg bad'; }
    btn.disabled = false;
  });
  root.querySelector('#frzp').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target, btn = f.querySelector('button'), msg = f.querySelector('.formmsg');
    btn.disabled = true;
    try {
      await upsertSetting('razorpay', { enabled: f.enabled.checked, key_id: f.key_id.value.trim() });
      msg.textContent = 'Saved.'; msg.className = 'formmsg ok'; toast('Razorpay settings saved.', 'ok');
    } catch (err) { msg.textContent = friendlyError(err); msg.className = 'formmsg bad'; }
    btn.disabled = false;
  });
  root.querySelector('#ftax').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    try { await upsertSetting('tax', { enabled: f.enabled.checked, percent: Number(f.percent.value) || 0, inclusive: f.inclusive.checked }); toast('Tax settings saved.', 'ok'); } catch (err) { toast(friendlyError(err), 'bad'); }
  });
  root.querySelector('#fmaint').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    try { await upsertSetting('maintenance_mode', { enabled: f.enabled.checked, message: f.message.value.trim() }, false); toast('Saved.', 'ok'); } catch (err) { toast(friendlyError(err), 'bad'); }
  });
  root.querySelector('#fdel').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    const payload = {
      mode: f.mode.value, fixed_charge: Number(f.fixed_charge.value) || 0, base_charge: Number(f.base_charge.value) || 0,
      per_km_charge: Number(f.per_km_charge.value) || 0, default_distance_km: Number(f.default_distance_km.value) || 5,
      min_charge: Number(f.min_charge.value) || 0, max_charge: f.max_charge.value ? Number(f.max_charge.value) : null,
      free_above_amount: f.free_above_amount.value ? Number(f.free_above_amount.value) : null, is_active: true
    };
    try {
      const q = d.id ? sb.from('delivery_settings').update(payload).eq('id', d.id) : sb.from('delivery_settings').insert(payload);
      const { error } = await q; if (error) throw error;
      toast('Delivery settings saved.', 'ok');
    } catch (err) { toast(friendlyError(err), 'bad'); }
  });
  return root;
}

// ============================= STAFF (admin only) =============================
async function staffTab() {
  const root = document.createElement('div');
  const [{ data: staff, error }, { data: perms }] = await Promise.all([
    sb.from('profiles').select('id,full_name,email,phone,is_active').eq('role', 'STAFF').order('created_at', { ascending: false }),
    sb.from('staff_permissions').select('*')
  ]);
  if (error) throw error;
  const byUser = {}; (perms || []).forEach(p => (byUser[p.user_id] ||= []).push(p.permission));
  root.innerHTML = `<p class="muted small">To add a staff member: create their login in Supabase → Authentication → Users, set their role to STAFF in the profiles table, then grant permissions here.</p>
    <div class="stack">${staff.map(s => `<div class="card pad"><div class="row between"><div><b>${esc(s.full_name || s.email)}</b> ${!s.is_active ? '<span class="pill bad">Disabled</span>' : ''}<div class="muted small">${esc(s.email)}</div></div>
      <button class="btn sm ghost" data-toggle="${esc(s.id)}" data-active="${s.is_active}">${s.is_active ? 'Disable' : 'Enable'}</button></div>
      <div class="perm-grid">${ALL.map(p => `<label class="check"><input type="checkbox" data-perm="${esc(s.id)}:${p}" ${byUser[s.id]?.includes(p) ? 'checked' : ''}> ${esc(p)}</label>`).join('')}</div></div>`).join('') || '<p class="muted">No staff accounts yet.</p>'}</div>`;
  root.addEventListener('change', async e => {
    const t = e.target; if (!t.dataset.perm) return;
    const [uid, perm] = t.dataset.perm.split(':');
    const { error } = t.checked ? await sb.from('staff_permissions').insert({ user_id: uid, permission: perm }) : await sb.from('staff_permissions').delete().eq('user_id', uid).eq('permission', perm);
    if (error) { toast(friendlyError(error), 'bad'); t.checked = !t.checked; } else toast('Permission updated.', 'ok');
  });
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-toggle]'); if (!b) return;
    const active = b.dataset.active === 'true';
    const { error } = await sb.from('profiles').update({ is_active: !active }).eq('id', b.dataset.toggle);
    if (error) return toast(friendlyError(error), 'bad');
    toast('Updated.', 'ok'); staffTab().then(el => root.replaceWith(el));
  });
  return root;
}

// ============================= ACTIVITY LOGS (admin only) =============================
async function logsTab() {
  const root = document.createElement('div');
  const { data, error } = await sb.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  root.innerHTML = `<div class="stack">${data.map(l => `<div class="card pad">
    <div class="row between"><b>${esc(l.action)} • ${esc(l.entity)}</b><span class="muted small">${esc(fmtDate(l.created_at))}</span></div>
    ${l.entity_id ? `<div class="muted small">ID: ${esc(l.entity_id)}</div>` : ''}</div>`).join('') || '<p class="muted">No activity yet.</p>'}</div>`;
  return root;
}
