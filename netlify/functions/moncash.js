// netlify/functions/moncash.js
// MonCash MerchantApi integration — direct payment initiation
import { getDb, getDbDirect, getSession, response, errorResponse, parseBody, sanitize } from './_utils/db.js';

const IS_SANDBOX    = process.env.MONCASH_MODE !== 'live';
const API_HOST      = IS_SANDBOX
  ? 'https://sandbox.moncashbutton.digicelgroup.com/MerChantApi'
  : 'https://moncashbutton.digicelgroup.com/MerChantApi';
const GW_BASE       = IS_SANDBOX
  ? 'https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware'
  : 'https://moncashbutton.digicelgroup.com/Moncash-middleware';

const CLIENT_ID     = process.env.MONCASH_CLIENT_ID;
const CLIENT_SECRET = process.env.MONCASH_CLIENT_SECRET;
const SITE_URL      = process.env.URL || 'https://switchcash.net';

// ── Get OAuth token ──────────────────────────────────────────
async function getMoncashToken() {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${API_HOST}/oauth/token`, {
    method: 'POST',
    headers: {
      'Accept':        'application/json',
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: 'scope=read,write&grant_type=client_credentials',
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`MonCash auth failed: ${res.status} — ${body}`);
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('MonCash auth bad JSON: ' + body); }
  if (!data.access_token) throw new Error('No access_token: ' + body);
  return data.access_token;
}

// ── Initiate Payment (push to user phone) ───────────────────
// reference = our unique order ID
// account   = user's MonCash phone number
// amount    = HTG amount
async function initiatePayment(token, reference, account, amount) {
  const res = await fetch(`${API_HOST}/V1/InitiatePayment`, {
    method: 'POST',
    headers: {
      'Accept':        'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ reference, account, amount: Number(amount) }),
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`InitiatePayment failed: ${res.status} — ${body}`);
  return JSON.parse(body);
}

// ── Payment (initiate + auto-poll, waits up to 2 min) ───────
async function createPayment(token, reference, account, amount) {
  const res = await fetch(`${API_HOST}/V1/Payment`, {
    method: 'POST',
    headers: {
      'Accept':        'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ reference, account, amount: Number(amount) }),
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`Payment failed: ${res.status} — ${body}`);
  return JSON.parse(body);
}

// ── Check payment status ─────────────────────────────────────
async function checkPayment(token, reference) {
  const res = await fetch(`${API_HOST}/V1/CheckPayment`, {
    method: 'POST',
    headers: {
      'Accept':        'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ reference }),
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`CheckPayment failed: ${res.status} — ${body}`);
  return JSON.parse(body);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});

  if (!CLIENT_ID || !CLIENT_SECRET)
    return errorResponse(503, 'MonCash not configured.');

  const url      = new URL(req.url);
  const segments = url.pathname.replace('/api/moncash', '').split('/').filter(Boolean);
  const resource = segments[0];
  const sql      = getDb();

  // ── INITIATE DEPOSIT ────────────────────────────────────────
  // POST /api/moncash/initiate
  // Body: { amount, phone }  — phone = user's MonCash number
  if (req.method === 'POST' && resource === 'initiate') {
    const session = await getSession(req, sql);
    if (!session) return errorResponse(401, 'Please log in first.');

    const body  = await parseBody(req);
    const amount = parseFloat(body?.amount);
    const phone  = body?.phone?.trim();

    if (!amount || amount < 100)  return errorResponse(400, 'Minimum deposit is 100 HTG');
    if (amount > 500000)          return errorResponse(400, 'Maximum deposit is 500,000 HTG');
    if (!phone)                   return errorResponse(400, 'MonCash phone number required');

    try {
      const reference = `SC-${session.user_id.slice(0,8)}-${Date.now()}`;

      // Ensure columns exist (DDL on unpooled)
      const sqlDirect = getDbDirect();
      try {
        await sqlDirect`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS moncash_order_id TEXT`;
        await sqlDirect`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS reference TEXT`;
        await sqlDirect`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`;
        await sqlDirect`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS wallet_type TEXT`;
        await sqlDirect`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS amount NUMERIC(18,2)`;
        await sqlDirect`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT 'moncash-auto'`;
        await sqlDirect`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS upload_method TEXT DEFAULT 'dashboard'`;
        await sqlDirect`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS notified_admin_at TIMESTAMPTZ`;
        await sqlDirect`ALTER TABLE deposit_receipts DROP CONSTRAINT IF EXISTS deposit_receipts_upload_method_check`;
      } catch { /* columns already exist */ }

      // Save pending deposit
      await sql`
        INSERT INTO deposit_receipts
          (user_id, image_url, wallet_type, amount, reference, moncash_order_id, status, upload_method)
        VALUES
          (${session.user_id}, 'moncash-auto', 'moncash', ${amount}, ${reference}, ${reference}, 'initiated', 'moncash_api')
      `;

      // Get MonCash token
      const mcToken = await getMoncashToken();

      // Use InitiatePayment — sends push notification to user's phone
      // User approves on their phone, we poll for status
      const result = await initiatePayment(mcToken, reference, phone, amount);

      return response(200, {
        reference,
        status:  result.status ?? 'initiated',
        message: result.message ?? 'Check your MonCash app and approve the payment.',
        poll_url: `/api/moncash/status?reference=${reference}`,
      });

    } catch (err) {
      console.error('MonCash initiate error:', err.message, err.stack);
      return errorResponse(500, 'Could not initiate MonCash payment: ' + err.message);
    }
  }

  // ── CHECK STATUS ────────────────────────────────────────────
  // GET /api/moncash/status?reference=SC-xxx
  if (req.method === 'GET' && resource === 'status') {
    const session = await getSession(req, sql);
    if (!session) return errorResponse(401, 'Please log in first.');

    const reference = url.searchParams.get('reference');
    if (!reference) return errorResponse(400, 'reference required');

    try {
      // Check our DB first
      const [deposit] = await sql`
        SELECT status, amount, moncash_order_id
        FROM deposit_receipts
        WHERE moncash_order_id = ${reference} AND user_id = ${session.user_id}
        LIMIT 1
      `;
      if (!deposit) return errorResponse(404, 'Deposit not found');

      // Already confirmed — return immediately
      if (deposit.status === 'confirmed')
        return response(200, { status: 'confirmed', amount: deposit.amount });

      // Check with MonCash
      const mcToken = await getMoncashToken();
      const result  = await checkPayment(mcToken, reference);

      // If MonCash says successful — credit wallet
      if (result?.status === 'OK' || result?.message?.toLowerCase() === 'successful') {
        const sqlDirect = getDbDirect();
        try {
          await sqlDirect`BEGIN`;
          await sqlDirect`
            UPDATE deposit_receipts SET status='confirmed', notified_admin_at=NOW()
            WHERE moncash_order_id=${reference} AND status != 'confirmed'
          `;
          const [wallet] = await sqlDirect`
            SELECT id FROM wallets WHERE user_id=${session.user_id} AND currency='HTG' LIMIT 1
          `;
          if (wallet) {
            await sqlDirect`UPDATE wallets SET balance=balance+${deposit.amount} WHERE id=${wallet.id}`;
            await sqlDirect`
              INSERT INTO transactions
                (receiver_id, wallet_id, type, amount, currency, status, description, completed_at)
              VALUES
                (${session.user_id}, ${wallet.id}, 'deposit', ${deposit.amount}, 'HTG', 'completed',
                 ${'MonCash deposit — ref: ' + reference}, NOW())
            `;
          }
          await sqlDirect`COMMIT`;
        } catch(e) {
          await sqlDirect`ROLLBACK`;
          throw e;
        }
        return response(200, { status: 'confirmed', amount: deposit.amount });
      }

      return response(200, {
        status:  deposit.status,
        mc_status: result?.status,
        message: result?.message,
      });

    } catch(err) {
      return errorResponse(500, 'Status check error: ' + err.message);
    }
  }

  return errorResponse(404, 'Unknown moncash resource');
};

export const config = { path: '/api/moncash/:resource*' };
