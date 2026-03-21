// api.js — SwitchCash shared API client
// All pages load this via <script src="api.js"></script>

const API_BASE = '/api';

const SC = {
  getToken:  () => localStorage.getItem('sc_token'),
  setToken:  (t) => localStorage.setItem('sc_token', t),
  getUser:   () => { try { return JSON.parse(localStorage.getItem('sc_user') || 'null'); } catch { return null; } },
  setUser:   (u) => localStorage.setItem('sc_user', JSON.stringify(u)),
  clear:     () => { localStorage.removeItem('sc_token'); localStorage.removeItem('sc_user'); },
  isAuthed:  () => !!localStorage.getItem('sc_token'),
};

SC.requireAuth = function(redirectTo = 'login.html') {
  if (!SC.isAuthed()) { window.location.href = redirectTo; return false; }
  return true;
};

SC.redirectIfAuthed = function(redirectTo = 'dashboard.html') {
  if (SC.isAuthed()) { window.location.href = redirectTo; return true; }
  return false;
};

SC.fetch = async function(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token   = SC.getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res  = await fetch(API_BASE + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));

  // Auto-logout on 401 — token expired or invalid
  if (res.status === 401) {
    SC.clear();
    window.location.href = 'login.html';
    throw new Error('Session expired. Please log in again.');
  }

  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
};

// ── Auth ──────────────────────────────────────────────────────
SC.signup = (email, password, full_name, phone) =>
  SC.fetch('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, full_name, phone }) });

SC.login = async (email, password) => {
  const data = await SC.fetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  SC.setToken(data.access_token);
  SC.setUser(data.user);
  return data;
};

SC.logout = async () => {
  try { await SC.fetch('/auth/logout', { method: 'POST' }); } catch {}
  SC.clear();
  window.location.href = 'login.html';
};

// ── User ──────────────────────────────────────────────────────
SC.getProfile = async () => {
  const data = await SC.fetch('/user');
  SC.setUser(data.user);
  return data.user;
};

SC.updateProfile = async (updates) => {
  const data = await SC.fetch('/user', { method: 'PUT', body: JSON.stringify(updates) });
  SC.setUser(data.user);
  return data.user;
};

// ── Wallet ────────────────────────────────────────────────────
SC.getWallet = () => SC.fetch('/wallet');

// ── Transactions ──────────────────────────────────────────────
SC.getTransactions = (opts = {}) => {
  const params = new URLSearchParams(
    Object.fromEntries(Object.entries(opts).filter(([,v]) => v !== '' && v !== null && v !== undefined))
  ).toString();
  return SC.fetch('/transactions' + (params ? '?' + params : ''));
};

SC.sendMoney = (receiver_phone, amount, currency = 'HTG', description = '') =>
  SC.fetch('/transactions', { method: 'POST', body: JSON.stringify({ receiver_phone, amount, currency, description }) });

// ── Analytics ─────────────────────────────────────────────────
SC.getAnalytics = () => SC.fetch('/analytics');

// ── Formatters ────────────────────────────────────────────────
SC.fmt     = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' HTG';
SC.fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

window.SC = SC;
