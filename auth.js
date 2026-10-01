// Authentication (Supabase Auth). Passwords are never handled by our code/tables.
import { sb } from './supabase.js';
import { esc, toast, navigate, friendlyError } from './utils.js';
import { CONFIG } from './config.js';

const state = { session: null, profile: null };
export const getUser = () => state.session?.user || null;
export const getProfile = () => state.profile;
export const isLoggedIn = () => !!state.session;

async function loadProfile() {
  const u = getUser();
  if (!u) { state.profile = null; return; }
  const { data } = await sb.from('profiles').select('*').eq('id', u.id).maybeSingle();
  state.profile = data || null;
}
async function setSession(session) {
  state.session = session || null;
  await loadProfile();
  window.dispatchEvent(new Event('sstc:auth'));
}
export async function refreshProfile() { await loadProfile(); window.dispatchEvent(new Event('sstc:auth')); }

export async function initAuth() {
  const { data } = await sb.auth.getSession();
  await setSession(data.session);
  sb.auth.onAuthStateChange((event, session) => {
    // defer: never await supabase calls directly inside this callback
    setTimeout(async () => {
      await setSession(session);
      if (event === 'PASSWORD_RECOVERY') navigate('/reset');
    }, 0);
  });
}

export function requireLogin(returnTo) {
  try { sessionStorage.setItem('sstc_after_login', returnTo || location.hash || '#/home'); } catch {}
  toast('Please login to continue.');
  navigate('/login');
}
function afterLogin() {
  let to = '#/home';
  try { to = sessionStorage.getItem('sstc_after_login') || '#/home'; sessionStorage.removeItem('sstc_after_login'); } catch {}
  if (to.startsWith('#/login') || to.startsWith('#/register')) to = '#/home';
  location.hash = to;
}
export async function logout() {
  await sb.auth.signOut();
  toast('Logged out.', 'ok');
  navigate('/home');
}

const brand = `<div class="auth-brand"><img class="logo-img" src="logo.png" alt="SS.TECH & Computers" width="86" height="86"><div class="logo-text">SS_TECH_COMPUTER89</div><div class="sub">COMPUTER • PC BUILD • SALES • SERVICE</div></div>`;
const shell = inner => { const d = document.createElement('div'); d.className = 'auth'; d.innerHTML = brand + `<div class="card glass pad">${inner}</div>`; return d; };
const busy = (btn, on, label) => { btn.disabled = on; btn.textContent = on ? 'Please wait…' : label; };
const msg = (root, text, type = 'bad') => { const m = root.querySelector('.formmsg'); m.className = 'formmsg ' + type; m.textContent = text; };

export function loginPage() {
  const root = shell(`
    <h1>Welcome back</h1>
    <form id="f" novalidate>
      <label>Email or username<input type="text" name="email" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
      <div class="formmsg" role="alert"></div>
      <button class="btn block" type="submit">Login</button>
    </form>
    <p class="center"><a href="#/forgot">Forgot password?</a></p>
    <p class="center muted">New here? <a href="#/register">Create account</a></p>
    <a class="btn ghost block" href="#/home">Continue as guest</a>`);
  root.querySelector('#f').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button');
    let email = f.email.value.trim(); const password = f.password.value;
    if (!email || !password) return msg(root, 'Enter email and password.');
    // a username (no @) is only valid for the admin account
    if (!email.includes('@')) {
      if (email.toLowerCase() !== CONFIG.ADMIN_USERNAME.toLowerCase()) return msg(root, 'Incorrect username or password.');
      email = CONFIG.ADMIN_EMAIL;
    }
    busy(btn, true);
    try {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await new Promise(r => setTimeout(r, 200));
      toast('Logged in.', 'ok'); afterLogin();
    } catch (err) { msg(root, friendlyError(err)); busy(btn, false, 'Login'); }
  });
  return root;
}

export function registerPage() {
  const root = shell(`
    <h1>Create account</h1>
    <form id="f" novalidate>
      <label>Full name<input name="name" autocomplete="name" required></label>
      <label>Phone<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="10-digit mobile" required></label>
      <label>Email<input type="email" name="email" autocomplete="email" required></label>
      <label>Password (min 8 characters)<input type="password" name="password" autocomplete="new-password" required></label>
      <label>Confirm password<input type="password" name="password2" autocomplete="new-password" required></label>
      <div class="formmsg" role="alert"></div>
      <button class="btn block" type="submit">Register</button>
    </form>
    <p class="center muted">Already have an account? <a href="#/login">Login</a></p>`);
  root.querySelector('#f').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button');
    const name = f.name.value.trim(), phone = f.phone.value.trim(), email = f.email.value.trim();
    if (name.length < 2) return msg(root, 'Please enter your name.');
    if (!/^[0-9+ -]{8,15}$/.test(phone)) return msg(root, 'Enter a valid phone number.');
    if (!/^\S+@\S+\.\S+$/.test(email)) return msg(root, 'Enter a valid email.');
    if (f.password.value.length < 8) return msg(root, 'Password must be at least 8 characters.');
    if (f.password.value !== f.password2.value) return msg(root, 'Passwords do not match.');
    busy(btn, true);
    try {
      // Check first so an already-registered email/phone sends the person to Login
      // instead of a confusing signUp error. This check is optional (best-effort):
      // if the database function isn't set up yet, we just skip straight to signUp
      // instead of blocking registration entirely.
      try {
        const { data: existing, error: checkErr } = await sb.rpc('check_account_exists', { p_email: email, p_phone: phone });
        if (checkErr) throw checkErr;
        if (existing?.email_taken) {
          msg(root, 'This email is already registered. Taking you to login…', 'ok');
          setTimeout(() => navigate('/login'), 1500);
          return;
        }
        if (existing?.phone_taken) {
          msg(root, 'This phone number is already registered. Taking you to login…', 'ok');
          setTimeout(() => navigate('/login'), 1500);
          return;
        }
      } catch (checkErr) { console.warn('[check_account_exists unavailable, continuing]', checkErr); }
      const { data, error } = await sb.auth.signUp({
        email, password: f.password.value,
        options: { data: { full_name: name, phone }, emailRedirectTo: location.origin + location.pathname }
      });
      if (error) throw error;
      if (data.session) { toast('Account created.', 'ok'); afterLogin(); }
      else { msg(root, 'Account created! Check your email and verify it, then login.', 'ok'); busy(btn, false, 'Register'); }
    } catch (err) {
      const text = friendlyError(err);
      msg(root, text);
      if (/already registered/i.test(text)) setTimeout(() => navigate('/login'), 1500);
      busy(btn, false, 'Register');
    }
  });
  return root;
}

export function forgotPage() {
  const root = shell(`
    <h1>Forgot password</h1>
    <p class="muted">Enter your email. We will send a reset link.</p>
    <form id="f" novalidate>
      <label>Email<input type="email" name="email" autocomplete="email" required></label>
      <div class="formmsg" role="alert"></div>
      <button class="btn block" type="submit">Send reset link</button>
    </form>
    <p class="center"><a href="#/login">Back to login</a></p>`);
  root.querySelector('#f').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button'), email = f.email.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return msg(root, 'Enter a valid email.');
    busy(btn, true);
    try {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) throw error;
      msg(root, 'If this email is registered, a reset link has been sent.', 'ok');
    } catch (err) { msg(root, friendlyError(err)); }
    busy(btn, false, 'Send reset link');
  });
  return root;
}

export function resetPage() {
  const root = shell(`
    <h1>Set new password</h1>
    <form id="f" novalidate>
      <label>New password (min 8 characters)<input type="password" name="p1" autocomplete="new-password" required></label>
      <label>Confirm password<input type="password" name="p2" autocomplete="new-password" required></label>
      <div class="formmsg" role="alert"></div>
      <button class="btn block" type="submit">Update password</button>
    </form>`);
  root.querySelector('#f').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button');
    if (!isLoggedIn()) return msg(root, 'Reset link expired. Please request a new one.');
    if (f.p1.value.length < 8) return msg(root, 'Password must be at least 8 characters.');
    if (f.p1.value !== f.p2.value) return msg(root, 'Passwords do not match.');
    busy(btn, true);
    try {
      const { error } = await sb.auth.updateUser({ password: f.p1.value });
      if (error) throw error;
      toast('Password updated.', 'ok'); navigate('/home');
    } catch (err) { msg(root, friendlyError(err)); busy(btn, false, 'Update password'); }
  });
  return root;
}

// ---- Phone OTP login/register (one phone = one account, no password needed) ----
export function phoneAuthPage() {
  const root = shell(`
    <h1>Continue with phone</h1>
    <form id="f1" novalidate>
      <label>Full name<input name="name" autocomplete="name" required></label>
      <label>Mobile number<div class="phonefield"><span>+91</span><input name="phone" type="tel" inputmode="numeric" maxlength="10" placeholder="10-digit mobile" autocomplete="tel" required></div></label>
      <div class="formmsg" role="alert"></div>
      <button class="btn block" type="submit">Send OTP</button>
    </form>
    <form id="f2" novalidate hidden>
      <p class="muted">Enter the 6-digit code sent to <b id="shownPhone"></b>.</p>
      <label>OTP<input name="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></label>
      <div class="formmsg" role="alert"></div>
      <button class="btn block" type="submit">Verify & Continue</button>
      <button type="button" class="btn ghost block" id="resend" disabled>Resend OTP (<span id="cd">30</span>s)</button>
      <button type="button" class="btn ghost block" id="changeNum">Change number</button>
    </form>
    <p class="center muted"><a href="#/login">Back to email login</a></p>`);

  const f1 = root.querySelector('#f1'), f2 = root.querySelector('#f2');
  let fullPhone = '', timer = null;

  function startCooldown() {
    const btn = f2.querySelector('#resend'), cd = f2.querySelector('#cd');
    let s = 30; btn.disabled = true;
    clearInterval(timer);
    timer = setInterval(() => {
      s--; cd.textContent = s;
      if (s <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = 'Resend OTP'; }
    }, 1000);
  }

  async function sendOtp(name, phone) {
    fullPhone = '+91' + phone;
    const { error } = await sb.auth.signInWithOtp({ phone: fullPhone, options: { data: { full_name: name, phone: fullPhone } } });
    if (error) throw error;
  }

  f1.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button');
    const name = f.name.value.trim(), phone = f.phone.value.trim();
    if (name.length < 2) return msg(f1, 'Please enter your name.');
    if (!/^[6-9][0-9]{9}$/.test(phone)) return msg(f1, 'Enter a valid 10-digit Indian mobile number.');
    busy(btn, true);
    try {
      await sendOtp(name, phone);
      f1.hidden = true; f2.hidden = false;
      f2.querySelector('#shownPhone').textContent = fullPhone;
      f2.querySelector('input[name=otp]').focus();
      startCooldown();
    } catch (err) { msg(f1, friendlyError(err)); busy(btn, false, 'Send OTP'); }
  });

  f2.querySelector('#changeNum').addEventListener('click', () => { clearInterval(timer); f2.hidden = true; f1.hidden = false; });
  f2.querySelector('#resend').addEventListener('click', async () => {
    const btn = f2.querySelector('#resend');
    btn.disabled = true; btn.textContent = 'Sending…';
    try { await sendOtp(f1.name.value.trim(), f1.phone.value.trim()); toast('OTP sent again.', 'ok'); startCooldown(); }
    catch (err) { msg(f2, friendlyError(err)); btn.disabled = false; btn.textContent = 'Resend OTP'; }
  });

  f2.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button[type=submit]');
    const otp = f.otp.value.trim();
    if (!/^[0-9]{6}$/.test(otp)) return msg(f2, 'Enter the 6-digit OTP.');
    busy(btn, true);
    try {
      const { error } = await sb.auth.verifyOtp({ phone: fullPhone, token: otp, type: 'sms' });
      if (error) throw error;
      clearInterval(timer);
      toast('Logged in.', 'ok');
      let to = '#/home';
      try { to = sessionStorage.getItem('sstc_after_login') || '#/home'; sessionStorage.removeItem('sstc_after_login'); } catch {}
      location.hash = to.startsWith('#/login') || to.startsWith('#/register') || to.startsWith('#/phone') ? '#/home' : to;
    } catch (err) { msg(f2, friendlyError(err)); busy(btn, false, 'Verify & Continue'); }
  });
  return root;
}
