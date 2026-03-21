// netlify/functions/_utils/email.js
// Resend.com integration — free tier: 3,000 emails/month, no credit card
// Setup: resend.com → Create API Key → add RESEND_API_KEY env var in Netlify

const FROM   = 'SwitchCash <noreply@switchcash.net>';
const BASE   = 'https://switchcash.net';
const SUPPORT = 'support@switchcash.net';

async function send(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[email] RESEND_API_KEY not set — skipping email to', to); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    if (!r.ok) console.error('[email] Resend error', r.status, await r.text());
    return r.ok;
  } catch (e) { console.error('[email] fetch error', e.message); return false; }
}

const base = (content) => `
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:0;background:#0d1f1b;font-family:-apple-system,sans-serif}
a{color:#00c9b1}hr{border:none;border-top:1px solid rgba(255,255,255,.08)}</style></head>
<body><div style="max-width:520px;margin:0 auto;padding:32px 20px">
<div style="text-align:center;margin-bottom:28px">
  <span style="font-size:20px;font-weight:700;color:#00c9b1">SwitchCash</span>
  <span style="font-size:12px;color:#4d8a80;margin-left:8px">MonCash ↔ NatCash</span>
</div>
${content}
<hr style="margin:28px 0"/>
<p style="font-size:11px;color:#3d6b63;line-height:1.6;text-align:center">
  Questions? <a href="mailto:${SUPPORT}">${SUPPORT}</a><br>
  © 2026 SwitchCash. All rights reserved.
</p>
</div></body></html>`;

const btn = (href, label) =>
  `<a href="${href}" style="display:inline-block;background:#00c9b1;color:#0d1f1b;padding:12px 28px;border-radius:99px;text-decoration:none;font-weight:700;font-size:14px;margin-top:4px">${label}</a>`;

const card = (content) =>
  `<div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:18px 20px;margin:16px 0">${content}</div>`;

export function sendWelcomeEmail(to, name) {
  return send(to, 'Welcome to SwitchCash!', base(`
    <h2 style="color:#fff;margin:0 0 12px">Welcome, ${name || 'there'}! 👋</h2>
    <p style="color:#7aada7;line-height:1.7;margin:0 0 20px">Your account is ready. Transfer money between MonCash and NatCash instantly with a flat 5% fee — no bank required.</p>
    ${btn(`${BASE}/dashboard`, 'Go to Dashboard')}
    ${card(`<p style="margin:0;color:#4d8a80;font-size:13px">Need help? Reply to this email or visit our <a href="${BASE}/support.html">support page</a>.</p>`)}
  `));
}

export function sendPasswordResetEmail(to, token) {
  const link = `${BASE}/reset-password.html?token=${token}`;
  return send(to, 'Reset your SwitchCash password', base(`
    <h2 style="color:#fff;margin:0 0 12px">Reset your password</h2>
    <p style="color:#7aada7;line-height:1.7;margin:0 0 20px">We received a request to reset your password. This link expires in <strong style="color:#fff">15 minutes</strong>.</p>
    ${btn(link, 'Reset Password')}
    ${card(`<p style="font-size:12px;color:#3d6b63;margin:0;word-break:break-all">Or copy: ${link}</p>`)}
    <p style="font-size:12px;color:#3d6b63;margin-top:16px">If you didn't request this, you can safely ignore this email.</p>
  `));
}

export function sendTransferEmail(to, name, amount, direction) {
  const fmt = (n) => Number(n).toLocaleString('fr-HT');
  return send(to, `Transfer of ${fmt(amount)} HTG confirmed`, base(`
    <h2 style="color:#fff;margin:0 0 16px">Transfer confirmed</h2>
    ${card(`<div style="text-align:center">
      <div style="font-size:30px;font-weight:700;color:#00c9b1">${fmt(amount)} HTG</div>
      <div style="color:#4d8a80;font-size:13px;margin-top:4px">${direction}</div>
    </div>`)}
    <p style="color:#7aada7;line-height:1.7">Hi ${name || 'there'}, your transfer was processed successfully.</p>
    ${btn(`${BASE}/dashboard`, 'View Dashboard')}
  `));
}

export function sendDepositConfirmedEmail(to, name, amount) {
  const fmt = (n) => Number(n).toLocaleString('fr-HT');
  return send(to, `Deposit of ${fmt(amount)} HTG credited to your wallet`, base(`
    <h2 style="color:#fff;margin:0 0 16px">Deposit confirmed!</h2>
    ${card(`<div style="text-align:center">
      <div style="font-size:30px;font-weight:700;color:#22c55e">+${fmt(amount)} HTG</div>
      <div style="color:#4d8a80;font-size:13px;margin-top:4px">credited to your SwitchCash wallet</div>
    </div>`)}
    <p style="color:#7aada7;line-height:1.7">Hi ${name || 'there'}, your deposit has been confirmed and added to your wallet.</p>
    ${btn(`${BASE}/dashboard`, 'View Balance')}
  `));
}

export function sendWithdrawalEmail(to, name, amount, toWallet, phone) {
  const fmt = (n) => Number(n).toLocaleString('fr-HT');
  return send(to, `Withdrawal of ${fmt(amount)} HTG processed`, base(`
    <h2 style="color:#fff;margin:0 0 16px">Withdrawal sent!</h2>
    ${card(`<div style="text-align:center">
      <div style="font-size:30px;font-weight:700;color:#f59e0b">${fmt(amount)} HTG</div>
      <div style="color:#4d8a80;font-size:13px;margin-top:4px">sent to ${toWallet} • ${phone}</div>
    </div>`)}
    <p style="color:#7aada7;line-height:1.7">Hi ${name || 'there'}, your withdrawal has been sent to your ${toWallet} account.</p>
    <p style="font-size:12px;color:#3d6b63;margin-top:8px">Didn't request this? Contact support immediately at <a href="mailto:${SUPPORT}">${SUPPORT}</a></p>
  `));
}

export function sendKycSubmissionEmail(opts = {}) {
  const { userName, userEmail, idType, submissionId } = opts;
  return send(process.env.SUPPORT_EMAIL || 'support@switchcash.net',
    `KYC Submission — ${userName || userEmail}`,
    base(`
    <h2 style="color:#fff;margin:0 0 16px">New KYC Submission</h2>
    ${card(`
      <div style="font-size:14px;color:#7aada7;line-height:1.9">
        <div><strong style="color:#cce4de">Name:</strong> ${userName || '—'}</div>
        <div><strong style="color:#cce4de">Email:</strong> ${userEmail || '—'}</div>
        <div><strong style="color:#cce4de">ID Type:</strong> ${idType || '—'}</div>
        <div><strong style="color:#cce4de">Submission ID:</strong> ${submissionId || '—'}</div>
      </div>
    `)}
    ${btn(`${BASE}/admin`, 'Review in Admin Panel')}
  `));
}

export function sendKycApprovedEmail(opts = {}) {
  const { userName, userEmail } = opts;
  return send(userEmail, 'Your identity has been verified ✓', base(`
    <h2 style="color:#fff;margin:0 0 16px">Identity Verified!</h2>
    ${card(`<div style="text-align:center">
      <div style="font-size:48px;margin-bottom:8px">✓</div>
      <div style="font-size:20px;font-weight:700;color:#22c55e">Verification Approved</div>
      <div style="color:#4d8a80;font-size:13px;margin-top:4px">Transfer limit raised to 200,000 HTG</div>
    </div>`)}
    <p style="color:#7aada7;line-height:1.7">Hi ${userName || 'there'}, your identity has been verified. You can now transfer up to 200,000 HTG per transaction.</p>
    ${btn(`${BASE}/dashboard`, 'Start Transferring')}
  `));
}

export function sendKycRejectedEmail(opts = {}) {
  const { userName, userEmail, reason } = opts;
  return send(userEmail, 'Action required — KYC verification', base(`
    <h2 style="color:#fff;margin:0 0 16px">Verification Update</h2>
    ${card(`
      <p style="color:#7aada7;line-height:1.7">Hi ${userName || 'there'}, we were unable to verify your identity with the documents provided.</p>
      <div style="background:rgba(240,64,64,.1);border:1px solid rgba(240,64,64,.2);border-radius:8px;padding:12px 16px;margin-top:12px">
        <div style="font-size:12px;font-weight:700;color:#f04040;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Reason</div>
        <div style="color:#cce4de;font-size:14px">${reason || 'Documents could not be verified.'}</div>
      </div>
    `)}
    <p style="color:#7aada7;line-height:1.7;margin-top:16px">Please resubmit with clearer documents. Make sure your ID is fully visible and not blurry.</p>
    ${btn(`${BASE}/dashboard`, 'Resubmit Documents')}
  `));
}

export function sendDepositReceiptEmail(opts = {}) {
  const { userName, userPhone, userEmail, walletType, amount, imageUrl } = opts;
  const fmt = (n) => Number(n || 0).toLocaleString('fr-HT');
  return send(process.env.SUPPORT_EMAIL || 'support@switchcash.net',
    `Deposit Receipt — ${userName || userEmail} — ${fmt(amount)} HTG`,
    base(`
    <h2 style="color:#fff;margin:0 0 16px">New Deposit Receipt</h2>
    ${card(`
      <div style="font-size:14px;color:#7aada7;line-height:1.9">
        <div><strong style="color:#cce4de">User:</strong> ${userName || '—'}</div>
        <div><strong style="color:#cce4de">Email:</strong> ${userEmail || '—'}</div>
        <div><strong style="color:#cce4de">Phone:</strong> ${userPhone || '—'}</div>
        <div><strong style="color:#cce4de">Wallet:</strong> ${(walletType || '').toUpperCase()}</div>
        <div><strong style="color:#cce4de">Amount:</strong> ${fmt(amount)} HTG</div>
      </div>
    `)}
    ${btn(`${BASE}/admin`, 'Review in Admin Panel')}
  `));
}
