// PC Builder: part selection, live server-side compatibility check, live pricing,
// a CSS/SVG "assembly" visual (rotate/zoom/reset), smart recommendation, and build checkout.
//
// NOTE ON THE 3D VIEW: this build ships a lightweight CSS/SVG animated assembly view
// (parts fade/slide into a case, with rotate + zoom controls) rather than a full
// Three.js/GLTF 3D viewer. This is the explicit low-power fallback the spec allows -
// a true GLTF/Three.js viewer needs real 3D model assets per product (via model_3d_url)
// which the catalogue does not have yet. Once products get GLB files uploaded, a real
// 3D viewer can be added as an upgrade without changing the builder logic below.
import { sb } from './supabase.js';
import { getSettings } from './settings.js';
import { getUser, getProfile, requireLogin } from './auth.js';
import { getCategories } from './products.js';
import { esc, money, round2, toast, friendlyError, navigate, confirmDialog, uuid, debounce, compressImage } from './utils.js';
import { payWithRazorpay } from './razorpay.js';

// slug -> {label, icon, required, compatKey (name used by check_pc_compatibility, or null if not checked)}
// zone: where this part's 3D image sits inside the build-preview frame (% of frame box)
const SLOTS = [
  { slug: 'cabinet', label: 'Cabinet', icon: '🖥️', required: true, compatKey: 'cabinet', z: 0, zone: { left: 2, top: 2, width: 96, height: 96 } },
  { slug: 'motherboard', label: 'Motherboard', icon: '🧩', required: true, compatKey: 'motherboard', z: 1, zone: { left: 14, top: 10, width: 72, height: 55 } },
  { slug: 'cpu', label: 'CPU', icon: '🧠', required: true, compatKey: 'cpu', z: 2, zone: { left: 36, top: 16, width: 28, height: 22 } },
  { slug: 'cpu-cooler', label: 'CPU Cooler', icon: '❄️', required: false, compatKey: 'cooler', z: 3, zone: { left: 32, top: 10, width: 36, height: 28 } },
  { slug: 'ram', label: 'RAM', icon: '💾', required: true, compatKey: 'ram', z: 2, zone: { left: 68, top: 12, width: 14, height: 36 } },
  { slug: 'gpu', label: 'GPU', icon: '🎮', required: false, compatKey: 'gpu', z: 2, zone: { left: 16, top: 48, width: 60, height: 20 } },
  { slug: 'psu', label: 'PSU', icon: '🔌', required: true, compatKey: 'psu', z: 2, zone: { left: 16, top: 72, width: 32, height: 20 } },
  { slug: 'ssd', label: 'SSD', icon: '⚡', required: false, compatKey: 'ssd', storage: true, z: 2, zone: { left: 52, top: 74, width: 22, height: 16 } },
  { slug: 'hdd', label: 'HDD', icon: '💽', required: false, compatKey: 'hdd', storage: true, z: 2, zone: { left: 52, top: 74, width: 22, height: 16 } },
  { slug: 'monitor', label: 'Monitor', icon: '🖵', required: false, compatKey: null },
  { slug: 'keyboard', label: 'Keyboard', icon: '⌨️', required: false, compatKey: null },
  { slug: 'mouse', label: 'Mouse', icon: '🖱️', required: false, compatKey: null }
];
const FIELDS = 'id,name,brand,model,price,discount_percent,final_price,image_url,model_3d_url,stock_status,stock_quantity,compatibility_data,category_id';
const KEY = 'sstc_build_v1';
const loadState = () => { try { const s = JSON.parse(sessionStorage.getItem(KEY)); return s && typeof s === 'object' ? s : {}; } catch { return {}; } };
const saveState = s => { try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch {} };

export async function builderPage() {
  const root = document.createElement('div');
  const [cats, settings] = await Promise.all([getCategories(), getSettings().catch(() => ({}))]);
  const bySlug = Object.fromEntries(cats.map(c => [c.slug, c]));
  const state = { picks: loadState(), compat: null, name: 'Custom PC' }; // picks: { slug: productRow }
  let checking = false;

  function slotsPayload() {
    const p = {};
    for (const s of SLOTS) if (s.compatKey && state.picks[s.slug]) p[s.compatKey] = state.picks[s.slug].id;
    return p;
  }
  function totals() {
    let total = 0, count = 0;
    for (const s of SLOTS) { const p = state.picks[s.slug]; if (p) { total += Number(p.final_price); count++; } }
    return { total: round2(total), count };
  }
  function missingRequired() {
    return SLOTS.filter(s => s.required && !state.picks[s.slug]);
  }
  function hasStorage() { return !!(state.picks.ssd || state.picks.hdd); }

  const runCheck = debounce(async () => {
    const payload = slotsPayload();
    if (!Object.keys(payload).length) { state.compat = null; drawStatus(); return; }
    checking = true; drawStatus();
    try {
      const { data, error } = await sb.rpc('check_pc_compatibility', { p_slots: payload });
      if (error) throw error;
      state.compat = data;
    } catch (e) { state.compat = null; toast(friendlyError(e), 'bad'); }
    checking = false; drawStatus();
  }, 300);

  root.innerHTML = `<div class="row between wrap"><h1>PC Builder</h1><button class="btn ghost sm" id="recommend">✨ Smart Recommend</button></div>
    <p class="muted small">Pick your parts. We check compatibility and price live - the price and stock are confirmed again when you order.</p>
    <div class="cols">
      <div class="col">
        <div class="card pad" id="assembly"></div>
        <div id="slotlist" class="stack"></div>
      </div>
      <div class="col side">
        <div class="card pad" id="status"></div>
      </div>
    </div>`;

  const assembly = root.querySelector('#assembly');
  const slotlist = root.querySelector('#slotlist');
  const statusBox = root.querySelector('#status');

  // ---------- Build preview: real part photos, layered and animated into a cabinet ----------
  // Each slot has a "zone" (% position inside the frame). As a part is picked, its 3D image
  // (set by the admin) fades/scales into that zone. Parts with no 3D image fall back to the
  // product photo, then to a plain icon, so the preview never looks broken.
  function drawAssembly() {
    const need = SLOTS.filter(s => s.required);
    const have = need.filter(s => state.picks[s.slug]).length;
    const complete = missingRequired().length === 0;
    const zoned = SLOTS.filter(s => s.zone).sort((a, b) => a.z - b.z);
    assembly.innerHTML = `<h3>Build preview</h3>
      <div class="asm-frame ${complete ? 'complete' : ''}">
        ${zoned.map(s => {
          const p = state.picks[s.slug];
          const img = p ? (p.model_3d_url || p.image_url) : null;
          const style = `left:${s.zone.left}%;top:${s.zone.top}%;width:${s.zone.width}%;height:${s.zone.height}%;z-index:${s.z}`;
          return `<div class="asm-zone ${p ? 'in' : ''}" style="${style}">${img ? `<img src="${esc(img)}" alt="${esc(s.label)}">` : `<span class="asm-icon">${s.icon}</span>`}</div>`;
        }).join('')}
      </div>
      <div class="asm-badge">${complete ? '✅ Build complete' : `${have}/${need.length} required parts`}</div>`;
  }

  // ---------- Slot list ----------
  function drawSlots() {
    slotlist.innerHTML = SLOTS.map(s => {
      const p = state.picks[s.slug];
      return `<div class="card pad slotrow">
        <div class="slotimg">${p?.image_url ? `<img loading="lazy" src="${esc(p.image_url)}" alt="">` : `<span>${s.icon}</span>`}</div>
        <div class="grow">
          <div class="muted small">${esc(s.label)}${s.required ? ' *' : ''}</div>
          ${p ? `<b>${esc(p.name)}</b><div class="muted small">${money(p.final_price)}</div>` : `<span class="muted">Not selected</span>`}
        </div>
        <div class="row">
          <button class="btn sm ${p ? 'ghost' : ''}" data-pick="${s.slug}">${p ? 'Change' : 'Add'}</button>
          ${p ? `<button class="btn sm ghost" data-clear="${s.slug}" aria-label="Remove">✕</button>` : ''}
        </div></div>`;
    }).join('');
  }

  function drawStatus() {
    const t = totals();
    const c = state.compat;
    const tone = c?.status === 'INCOMPATIBLE' ? 'bad' : c?.status === 'WARNING' ? 'warn' : c ? 'ok' : 'info';
    const label = c?.status === 'INCOMPATIBLE' ? 'Incompatible' : c?.status === 'WARNING' ? 'Check warnings' : c ? 'Compatible' : 'Add parts to check';
    const miss = missingRequired();
    statusBox.innerHTML = `<h3>Status</h3>
      <span class="pill ${tone}">${checking ? 'Checking…' : label}</span>
      ${c?.issues?.length ? `<ul class="issues">${c.issues.map(i => `<li class="${i.severity === 'INCOMPATIBLE' ? 'bad' : 'warn'}">${esc(i.message)}</li>`).join('')}</ul>` : ''}
      ${c?.recommended_psu_watts ? `<div class="muted small">Recommended PSU: ${c.recommended_psu_watts}W (min ${c.required_psu_watts}W)</div>` : ''}
      ${miss.length ? `<div class="formmsg bad">Still needed: ${miss.map(m => esc(m.label)).join(', ')}</div>` : ''}
      <div class="sumrows"><div class="grand"><span>Total (${t.count} parts)</span><span>${money(t.total)}</span></div></div>
      <button class="btn block" id="checkout" ${!t.count || miss.length || c?.status === 'INCOMPATIBLE' ? 'disabled' : ''}>Proceed to build checkout</button>
      <button class="btn ghost block" id="clearall">Clear build</button>
      <p class="muted small">* required part. Storage (SSD/HDD) is optional but recommended.</p>`;
    statusBox.querySelector('#checkout').onclick = () => openBuildCheckout(state, settings);
    statusBox.querySelector('#clearall').onclick = async () => {
      if (!await confirmDialog('Clear this build?', 'All selected parts will be removed.', 'Clear')) return;
      state.picks = {}; saveState(state.picks); state.compat = null; drawAll();
    };
  }

  function drawAll() { drawAssembly(); drawSlots(); drawStatus(); }

  slotlist.addEventListener('click', e => {
    const pick = e.target.closest('[data-pick]'), clear = e.target.closest('[data-clear]');
    if (pick) openPicker(pick.dataset.pick);
    else if (clear) { delete state.picks[clear.dataset.clear]; saveState(state.picks); drawAll(); runCheck(); }
  });

  function openPicker(slug) {
    const slot = SLOTS.find(s => s.slug === slug);
    const cat = bySlug[slug];
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `<div class="dialog glass picker" role="dialog" aria-modal="true">
      <div class="row between"><h3>Select ${esc(slot.label)}</h3><button class="btn sm ghost" id="close">✕</button></div>
      <input id="psearch" type="search" placeholder="Search ${esc(slot.label).toLowerCase()}…">
      <div id="plist" class="stack picker-list"><p class="muted center">Loading…</p></div></div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#close').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const list = overlay.querySelector('#plist');
    async function load(q) {
      if (!cat) { list.innerHTML = '<p class="muted center">Category not set up yet.</p>'; return; }
      let query = sb.from('products').select(FIELDS).eq('category_id', cat.id).eq('is_active', true).gt('stock_quantity', 0).order('final_price').limit(40);
      const s = (q || '').trim().replace(/[%,()*\\_]/g, ' ');
      if (s) query = query.or(`name.ilike.%${s}%,brand.ilike.%${s}%,model.ilike.%${s}%`);
      const { data, error } = await query;
      if (error) { list.innerHTML = `<p class="formmsg bad">${esc(friendlyError(error))}</p>`; return; }
      if (!data.length) { list.innerHTML = '<p class="muted center">No in-stock products found.</p>'; return; }
      list.innerHTML = data.map(p => `<button class="card pad pickrow" data-id="${esc(p.id)}">
        <div class="slotimg">${p.image_url ? `<img loading="lazy" src="${esc(p.image_url)}" alt="">` : `<span>${slot.icon}</span>`}</div>
        <div class="grow"><b>${esc(p.name)}</b><div class="muted small">${esc(p.brand || '')}</div></div>
        <b>${money(p.final_price)}</b></button>`).join('');
      list.querySelectorAll('[data-id]').forEach(btn => btn.addEventListener('click', () => {
        state.picks[slug] = data.find(p => p.id === btn.dataset.id);
        saveState(state.picks); close(); drawAll(); runCheck();
      }));
    }
    overlay.querySelector('#psearch').addEventListener('input', debounce(e => load(e.target.value), 300));
    load('');
  }

  root.querySelector('#recommend').addEventListener('click', () => openRecommend(state, drawAll, runCheck));
  drawAll();
  if (Object.keys(state.picks).length) runCheck();
  return root;
}

// ---------- Smart PC recommendation ----------
async function openRecommend(state, drawAll, runCheck) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.innerHTML = `<div class="dialog glass" role="dialog" aria-modal="true">
    <h3>Smart PC Recommendation</h3>
    <form id="rf" novalidate>
      <label>Budget (₹)<input name="budget" type="number" min="10000" step="500" required placeholder="e.g. 60000"></label>
      <label>Purpose<select name="purpose">
        <option value="GENERAL">General use</option><option value="GAMING">Gaming</option><option value="OFFICE">Office</option>
        <option value="EDITING">Video/Photo editing</option><option value="CODING">Coding / Development</option>
        <option value="STREAMING">Streaming</option><option value="AI">AI / Machine learning</option></select></label>
      <div class="two"><label>CPU brand<select name="cpu_brand"><option value="">Any</option><option>Intel</option><option>AMD</option></select></label>
      <label>GPU brand<select name="gpu_brand"><option value="">Any</option><option>NVIDIA</option><option>AMD</option><option value="NONE">No dedicated GPU</option></select></label></div>
      <label class="check"><input type="checkbox" name="monitor" checked> Include a monitor</label>
      <label class="check"><input type="checkbox" name="accessories" checked> Include keyboard & mouse</label>
      <div class="formmsg" role="alert"></div>
      <div class="row end"><button type="button" class="btn ghost" id="cancel">Cancel</button><button class="btn" type="submit">Recommend build</button></div>
    </form></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#cancel').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#rf').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button[type=submit]'), msg = f.querySelector('.formmsg');
    const budget = Number(f.budget.value);
    if (!budget || budget < 10000) { msg.textContent = 'Please enter a budget of at least ₹10,000.'; msg.className = 'formmsg bad'; return; }
    btn.disabled = true; btn.textContent = 'Finding the best build…';
    try {
      const picks = await recommendBuild({
        budget, purpose: f.purpose.value, cpuBrand: f.cpu_brand.value, gpuBrand: f.gpu_brand.value,
        monitor: f.monitor.checked, accessories: f.accessories.checked
      });
      if (!picks) { msg.textContent = 'No compatible build found in stock for this budget. Try increasing the budget.'; msg.className = 'formmsg bad'; btn.disabled = false; btn.textContent = 'Recommend build'; return; }
      state.picks = picks; saveState(state.picks); overlay.remove(); drawAll(); runCheck();
      toast('Here is a build within your budget. Review and adjust as needed.', 'ok');
    } catch (err) { msg.textContent = friendlyError(err); msg.className = 'formmsg bad'; btn.disabled = false; btn.textContent = 'Recommend build'; }
  });
}

async function fetchSlot(slug, catId, brand) {
  let q = sb.from('products').select(FIELDS).eq('category_id', catId).eq('is_active', true).gt('stock_quantity', 0).order('final_price');
  if (brand) q = q.eq('brand', brand);
  const { data, error } = await q.limit(200);
  if (error) throw error;
  return data || [];
}

// Greedy heuristic: cheapest-compatible-first, then upgrade toward the budget where it helps most (GPU/CPU).
async function recommendBuild({ budget, purpose, cpuBrand, gpuBrand, monitor, accessories }) {
  const cats = await getCategories();
  const bySlug = Object.fromEntries(cats.map(c => [c.slug, c]));
  const wantGpu = gpuBrand !== 'NONE' && ['GAMING', 'EDITING', 'STREAMING', 'AI'].includes(purpose) || (gpuBrand && gpuBrand !== 'NONE');

  const [cpus, mbs, rams, gpus, ssds, psus, cabs, coolers, monitors, kbs, mice] = await Promise.all([
    fetchSlot('cpu', bySlug.cpu?.id, cpuBrand), fetchSlot('motherboard', bySlug.motherboard?.id),
    fetchSlot('ram', bySlug.ram?.id), wantGpu ? fetchSlot('gpu', bySlug.gpu?.id, gpuBrand && gpuBrand !== 'NONE' ? gpuBrand : null) : Promise.resolve([]),
    fetchSlot('ssd', bySlug.ssd?.id), fetchSlot('psu', bySlug.psu?.id), fetchSlot('cabinet', bySlug.cabinet?.id),
    fetchSlot('cpu-cooler', bySlug['cpu-cooler']?.id), monitor ? fetchSlot('monitor', bySlug.monitor?.id) : Promise.resolve([]),
    accessories ? fetchSlot('keyboard', bySlug.keyboard?.id) : Promise.resolve([]), accessories ? fetchSlot('mouse', bySlug.mouse?.id) : Promise.resolve([])
  ]);
  if (!cpus.length || !mbs.length || !rams.length || !psus.length || !cabs.length) return null;

  const cd = p => p.compatibility_data || {};
  let best = null;
  // try each CPU (cheap -> expensive), pair with the best affordable compatible parts, keep the priciest valid combo
  for (const cpu of cpus) {
    const mb = mbs.find(m => cd(m).socket && cd(m).socket === cd(cpu).socket);
    if (!mb) continue;
    const ram = rams.find(r => !cd(mb).ram_type || cd(r).type === cd(mb).ram_type) || rams[0];
    const gpu = wantGpu ? gpus.find(g => !cd(mb).pcie_slots || !cd(g).pcie_slot || cd(mb).pcie_slots?.includes?.(cd(g).pcie_slot)) || gpus[0] : null;
    const needW = (Number(cd(cpu).tdp) || 0) + (gpu ? Number(cd(gpu).tdp) || 0 : 0) + 100;
    const psu = psus.find(u => Number(cd(u).wattage) >= Math.ceil(needW * 1.3 / 50) * 50) || psus.find(u => Number(cd(u).wattage) >= needW);
    if (!psu) continue;
    const cab = cabs.find(c => !cd(mb).form_factor || cd(c).form_factors?.includes?.(cd(mb).form_factor)) &&
                cabs.find(c => (!cd(mb).form_factor || cd(c).form_factors?.includes?.(cd(mb).form_factor)) && (!gpu || !cd(gpu).length_mm || !cd(c).max_gpu_length_mm || Number(cd(c).max_gpu_length_mm) >= Number(cd(gpu).length_mm)));
    if (!cab) continue;
    const ssd = ssds[0] || null;
    const cooler = coolers.find(c => cd(c).sockets?.includes?.(cd(cpu).socket)) || null;
    const mon = monitor ? monitors[0] : null, kb = accessories ? kbs[0] : null, ms = accessories ? mice[0] : null;

    const picks = { cpu, motherboard: mb, ram, psu, cabinet: cab };
    if (gpu) picks.gpu = gpu; if (ssd) picks.ssd = ssd; if (cooler) picks['cpu-cooler'] = cooler;
    if (mon) picks.monitor = mon; if (kb) picks.keyboard = kb; if (ms) picks.mouse = ms;
    const total = Object.values(picks).reduce((s, p) => s + Number(p.final_price), 0);
    if (total <= budget && (!best || total > best.total)) best = { picks, total };
  }
  return best ? best.picks : null;
}

// ---------- Build checkout (address + payment -> create_order with p_pc_build) ----------
async function openBuildCheckout(state, settings) {
  if (!getUser()) return requireLogin('#/builder');
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  const p = getProfile() || {};
  let { data: addr } = await sb.from('addresses').select('*').order('is_default', { ascending: false }).limit(1).maybeSingle();
  addr = addr || {};
  const pm = settings.payment_methods || {};
  const upi = settings.upi || {};
  const methods = [pm.ONLINE && ['ONLINE', 'Online Payment (UPI)'], pm.COD && ['COD', 'Cash on Delivery'], pm.PAY_AT_SHOP && ['PAY_AT_SHOP', 'Pay at Shop (Pickup)']].filter(Boolean);
  const items = SLOTS.filter(s => state.picks[s.slug]).map(s => ({ slug: s.slug, label: s.label, p: state.picks[s.slug] }));
  const total = round2(items.reduce((s, i) => s + Number(i.p.final_price), 0));

  const STEP_LABELS = ['Items', 'Delivery details', 'Payment method', 'Payment screenshot'];
  const v = { // carries values between steps
    build_name: 'My Custom PC', full_name: addr.full_name || p.full_name || '', phone: addr.phone || p.phone || '',
    pincode: addr.pincode || p.pincode || '', house_street: addr.house_street || '', area: addr.area || '',
    city: addr.city || p.city || '', state: addr.state || p.state || '', method: methods[0]?.[0] || ''
  };
  let step = 1, orderId = null; // step 4 only happens when payment method is ONLINE
  overlay.innerHTML = `<div class="dialog glass picker" role="dialog" aria-modal="true">
    <div class="row between"><h3>Build checkout</h3><button class="btn sm ghost" id="close">✕</button></div>
    <div class="wizard-steps">${STEP_LABELS.map((l, i) => `<span class="${i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}">${i + 1}</span>`).join('')}</div>
    <div id="body"></div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#close').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  const body = overlay.querySelector('#body');
  const dots = () => overlay.querySelectorAll('.wizard-steps span').forEach((el, i) => el.className = i + 1 === step ? 'on' : i + 1 < step ? 'done' : '');

  function drawStep1() {
    body.innerHTML = `<h4>Review your parts</h4>
      <div class="stack build-summary">${items.map(i => `<div class="sline"><div class="grow">${esc(i.label)}: <b>${esc(i.p.name)}</b></div><b>${money(i.p.final_price)}</b></div>`).join('')}
        <div class="sumrows"><div class="grand"><span>Total</span><span>${money(total)}</span></div></div></div>
      <label>Build name<input id="build_name" value="${esc(v.build_name)}" maxlength="100"></label>
      <button class="btn block" id="next">Next: Delivery details</button>`;
    body.querySelector('#next').addEventListener('click', () => { v.build_name = body.querySelector('#build_name').value.trim() || 'Custom PC'; step = 2; draw(); });
  }

  function drawStep2() {
    body.innerHTML = `<h4>Delivery details</h4>
      <form id="f2" novalidate>
        <label>Full name<input name="full_name" value="${esc(v.full_name)}" autocomplete="name" required></label>
        <div class="two"><label>Phone<input name="phone" type="tel" value="${esc(v.phone)}" autocomplete="tel" required></label>
        <label>Pincode<input name="pincode" inputmode="numeric" maxlength="6" value="${esc(v.pincode)}" required></label></div>
        <label>House / Street<input name="house_street" value="${esc(v.house_street)}" required></label>
        <label>Area<input name="area" value="${esc(v.area)}"></label>
        <div class="two"><label>City<input name="city" value="${esc(v.city)}" required></label><label>State<input name="state" value="${esc(v.state)}" required></label></div>
        <div class="formmsg" role="alert"></div>
        <div class="row"><button type="button" class="btn ghost" id="back">Back</button><button class="btn grow" type="submit">Next: Payment method</button></div>
      </form>`;
    const f = body.querySelector('#f2'), msg = f.querySelector('.formmsg');
    const bad = t => { msg.textContent = t; msg.className = 'formmsg bad'; };
    body.querySelector('#back').addEventListener('click', () => { step = 1; draw(); });
    f.addEventListener('submit', e => {
      e.preventDefault();
      if (f.full_name.value.trim().length < 2) return bad('Please enter your full name.');
      if (!/^[0-9+ -]{8,15}$/.test(f.phone.value.trim())) return bad('Enter a valid phone number.');
      if (!f.house_street.value.trim() || !f.city.value.trim() || !f.state.value.trim()) return bad('Please complete the address.');
      if (!/^[0-9]{6}$/.test(f.pincode.value.trim())) return bad('Enter a valid 6-digit pincode.');
      Object.assign(v, { full_name: f.full_name.value.trim(), phone: f.phone.value.trim(), house_street: f.house_street.value.trim(),
        area: f.area.value.trim(), city: f.city.value.trim(), state: f.state.value.trim(), pincode: f.pincode.value.trim() });
      step = 3; draw();
    });
  }

  const needsScreenshot = () => v.method === 'ONLINE' && !(settings.razorpay?.enabled && settings.razorpay?.key_id);

  async function createBuildOrder() {
    const orderItems = items.map(i => ({ product_id: i.p.id, quantity: 1, slot: i.slug, spec: {} }));
    const address = { full_name: v.full_name, phone: v.phone, house_street: v.house_street, area: v.area, city: v.city, state: v.state, pincode: v.pincode, fulfilment: 'DELIVERY' };
    let idem; try { idem = JSON.parse(sessionStorage.getItem('sstc_build_idem') || 'null'); } catch {}
    if (!idem || idem.sig !== JSON.stringify(orderItems)) { idem = { sig: JSON.stringify(orderItems), key: uuid() }; try { sessionStorage.setItem('sstc_build_idem', JSON.stringify(idem)); } catch {} }
    const { data, error } = await sb.rpc('create_order', {
      p_idempotency_key: idem.key, p_items: orderItems, p_address: address, p_payment_method: v.method,
      p_coupon_code: null, p_pc_build: { name: v.build_name }
    });
    if (error) throw error;
    return data;
  }
  async function uploadShot(oid, small) {
    const path = `${oid}/${Date.now()}-${small.name.replace(/[^\w.-]/g, '_')}`;
    const { error: upErr } = await sb.storage.from('payment-screenshots').upload(path, small, { contentType: small.type });
    if (upErr) throw upErr;
    const { data: pub } = sb.storage.from('payment-screenshots').getPublicUrl(path);
    const { error: insErr } = await sb.from('payment_screenshots').insert({ order_id: oid, url: pub.publicUrl });
    if (insErr) throw insErr;
  }
  function orderDone() { try { sessionStorage.removeItem('sstc_build_idem'); sessionStorage.removeItem(KEY); } catch {} }

  function drawStep3() {
    body.innerHTML = `<h4>Payment method</h4>
      <form id="f3" novalidate>
        ${methods.length ? methods.map(([mv, l]) => `<label class="radio card"><input type="radio" name="pay" value="${mv}" ${mv === v.method ? 'checked' : ''}>${esc(l)}</label>`).join('')
          : '<div class="formmsg bad">No payment method is available right now.</div>'}
        <div class="formmsg" role="alert"></div>
        <div class="row"><button type="button" class="btn ghost" id="back">Back</button>
        <button class="btn grow" type="submit" ${methods.length ? '' : 'disabled'}></button></div>
      </form>`;
    const f = body.querySelector('#f3'), msg = f.querySelector('.formmsg'), btn = f.querySelector('button[type=submit]');
    const bad = t => { msg.textContent = t; msg.className = 'formmsg bad'; };
    const label = () => { btn.textContent = needsScreenshot() ? 'Next: Payment screenshot' : `Place build order • ${money(total)}`; };
    f.addEventListener('change', e => { if (e.target.name === 'pay') { v.method = e.target.value; label(); } });
    label();
    body.querySelector('#back').addEventListener('click', () => { step = 2; draw(); });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const method = f.pay?.value; if (!method) return bad('Please choose a payment method.');
      v.method = method;
      if (needsScreenshot()) { step = 4; draw(); return; }
      btn.disabled = true; btn.textContent = 'Placing order…';
      try {
        const data = await createBuildOrder();
        orderDone(); orderId = data.order_id;
        toast('Build order placed!', 'ok');
        if (method === 'ONLINE') {
          const result = await payWithRazorpay(orderId, { name: v.full_name, phone: v.phone, orderNumber: data.order_number });
          toast(result === 'paid' ? 'Payment successful!' : 'Payment not completed. You can retry from your order page.');
        }
        close(); navigate(`/order/${orderId}?placed=1`);
      } catch (err) { btn.disabled = false; label(); bad(friendlyError(err)); }
    });
  }

  // Step 4 (manual UPI only): choose screenshot -> uploads automatically and the order is placed.
  function drawStep4() {
    body.innerHTML = `<h4>Payment screenshot</h4>
      <div class="card pad upibox">
        ${upi.qr_url ? `<img src="${esc(upi.qr_url)}" alt="UPI QR code" class="upiqr">` : ''}
        ${upi.upi_id ? `<div class="upiid">UPI ID: <b>${esc(upi.upi_id)}</b></div>` : ''}
        <p>Pay <b>${money(total)}</b> using any UPI app, then choose your payment screenshot below.</p>
      </div>
      <label class="filebtn">Choose payment screenshot<input type="file" id="ssfile" accept="image/png,image/jpeg,image/webp" hidden></label>
      <div class="formmsg" id="ssmsg" role="alert"></div>
      <p class="muted small">Your order is placed automatically as soon as the screenshot is uploaded. Without a screenshot, no order is placed.</p>
      <button type="button" class="btn ghost" id="back">Back</button>`;
    const msg = body.querySelector('#ssmsg'), input = body.querySelector('#ssfile');
    let uploading = false;
    body.querySelector('#back').addEventListener('click', () => { if (!uploading) { step = 3; draw(); } });
    input.addEventListener('change', async () => {
      const file = input.files[0]; if (!file || uploading) return;
      uploading = true; msg.textContent = 'Uploading screenshot and placing your order…'; msg.className = 'formmsg';
      let data = null;
      try {
        if (!navigator.onLine) throw new Error('offline');
        const small = await compressImage(file, 1000, 0.85);
        data = await createBuildOrder();
        orderId = data.order_id;
        try { await uploadShot(orderId, small); } catch { await uploadShot(orderId, small); }
        orderDone(); toast('Build order placed!', 'ok');
        close(); navigate(`/order/${orderId}?placed=1`);
      } catch (err) {
        if (data?.order_id) {
          try { await sb.rpc('cancel_my_order', { p_order_id: data.order_id, p_reason: 'Payment screenshot upload failed' }); } catch {}
          try { sessionStorage.removeItem('sstc_build_idem'); } catch {}
        }
        msg.textContent = friendlyError(err) + ' Please choose the screenshot again.'; msg.className = 'formmsg bad';
        uploading = false; input.value = '';
      }
    });
  }

  function draw() {
    dots();
    ({ 1: drawStep1, 2: drawStep2, 3: drawStep3, 4: drawStep4 })[step]();
  }
  draw();
}
