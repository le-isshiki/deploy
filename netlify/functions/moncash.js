// netlify/functions/moncash.js
// MonCash Merchant API integration — handles deposit initiation + return callback
import { getDb, getDbDirect, getSession, response, errorResponse, parseBody, sanitize } from './_utils/db.js';

const IS_SANDBOX  = process.env.MONCASH_MODE !== 'live';
const API_HOST    = IS_SANDBOX
  ? 'https://sandbox.moncashbutton.digicelgroup.com/Api'
  : 'https://moncashbutton.digicelgroup.com/Api';
const GW_BASE     = IS_SANDBOX
  ? 'https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware'
  : 'https://moncashbutton.digicelgroup.com/Moncash-middleware';

const CLIENT_ID     = process.env.MONCASH_CLIENT_ID;
const CLIENT_SECRET = process.env.MONCASH_CLIENT_SECRET;
const SITE_URL      = process.env.URL || 'https://switchcash.net';

// ── Get OAuth token from MonCash ─────────────────────────────
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
  if (!res.ok) throw new Error('MonCash auth failed: ' + res.status);
  const data = await res.json();
  return data.access_token;
}

// ── Create a MonCash payment order ──────────────────────────
async function createMoncashPayment(token, amount, orderId) {
  const res = await fetch(`${API_HOST}/v1/CreatePayment`, {
    method: 'POST',
    headers: {
      'Accept':        'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ amount, orderId }),
  });
  if (!res.ok) throw new Error('MonCash CreatePayment failed: ' + res.status);
  return res.json();
}

// ── Verify a payment by orderId ──────────────────────────────
async function verifyMoncashPayment(token, orderId) {
  const res = await fetch(`${API_HOST}/v1/RetrieveOrderPayment`, {
    method: 'POST',
    headers: {
      'Accept':        'application/json',
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ orderId }),
  });
  if (!res.ok) throw new Error('MonCash verify failed: ' + res.status);
  return res.json();
}

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return errorResponse(503, 'MonCash not configured. Add MONCASH_CLIENT_ID and MONCASH_CLIENT_SECRET env vars.');
  }

  const url      = new URL(req.url);
  const segments = url.pathname.replace('/api/moncash', '').split('/').filter(Boolean);
  const resource = segments[0];
  const sql      = getDb();

  // ── INITIATE DEPOSIT ────────────────────────────────────────
  // POST /api/moncash/initiate
  // Auth required — user must be logged in
  // Body: { amount }
  // Returns: { redirect_url } — frontend redirects user there
  if (req.method === 'POST' && resource === 'initiate') {
    const session = await getSession(req, sql);
    if (!session) return errorResponse(401, 'Please log in first.');

    const body   = await parseBody(req);
    const amount = parseFloat(body?.amount);
    if (!amount || amount < 100) return errorResponse(400, 'Minimum deposit is 100 HTG');
    if (amount > 500000)         return errorResponse(400, 'Maximum deposit is 500,000 HTG');

    try {
      // Create a unique orderId tied to this user + timestamp
      const orderId = `SC-${session.user_id.slice(0,8)}-${Date.now()}`;

      // Store pending deposit in DB before redirecting
      await sql`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS moncash_order_id TEXT`;
      await sql`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS reference TEXT`;
      await sql`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`;
      await sql`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS wallet_type TEXT`;
      await sql`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS amount NUMERIC(18,2)`;
      await sql`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT 'moncash-auto'`;
      await sql`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS upload_method TEXT DEFAULT 'dashboard'`;
      await sql`ALTER TABLE deposit_receipts ADD COLUMN IF NOT EXISTS notified_admin_at TIMESTAMPTZ`;
      // Drop restrictive check constraint so moncash_api and other methods are allowed
      await sql`ALTER TABLE deposit_receipts DROP CONSTRAINT IF EXISTS deposit_receipts_upload_method_check`;

      await sql`
        INSERT INTO deposit_receipts
          (user_id, image_url, wallet_type, amount, reference, moncash_order_id, status, upload_method)
        VALUES
          (${session.user_id}, 'moncash-auto', 'moncash', ${amount}, ${orderId}, ${orderId}, 'initiated', 'moncash_api')
      `;

      // Get MonCash token and create payment
      const mcToken  = await getMoncashToken();
      const mcResult = await createMoncashPayment(mcToken, amount, orderId);

      const paymentToken = mcResult?.payment_token?.token;
      if (!paymentToken) throw new Error('No payment token received from MonCash');

      const redirectUrl = `${GW_BASE}/Payment/Redirect?token=${paymentToken}`;

      return response(200, {
        redirect_url: redirectUrl,
        order_id:     orderId,
        amount,
      });
    } catch (err) {
      console.error('MonCash initiate error:', err.message);
      return errorResponse(500, 'Could not initiate MonCash payment: ' + err.message);
    }
  }

  // ── RETURN CALLBACK ─────────────────────────────────────────
  // GET /api/moncash/return?transactionId=xxx&orderId=xxx
  // MonCash redirects user here after payment (success or failure)
  // No auth — verify payment server-side and credit wallet
  if (req.method === 'GET' && resource === 'return') {
    const transactionId = url.searchParams.get('transactionId');
    const orderId       = url.searchParams.get('orderId');

    if (!orderId) {
      return Response.redirect(`${SITE_URL}/dashboard.html?deposit=failed&reason=missing_order`, 302);
    }

    try {
      // Find the pending deposit in our DB
      const [deposit] = await sql`
        SELECT dr.*, p.email, p.full_name
        FROM deposit_receipts dr
        JOIN profiles p ON p.id = dr.user_id
        WHERE dr.moncash_order_id = ${orderId}
        LIMIT 1
      `;

      if (!deposit) {
        return Response.redirect(`${SITE_URL}/dashboard.html?deposit=failed&reason=not_found`, 302);
      }

      // Already processed — don't double-credit
      if (deposit.status === 'confirmed') {
        return Response.redirect(`${SITE_URL}/dashboard.html?deposit=already_done`, 302);
      }

      // Verify with MonCash server-side
      const mcToken = await getMoncashToken();
      const payment = await verifyMoncashPayment(mcToken, orderId);

      const paidAmount = parseFloat(payment?.payment?.amount ?? 0);
      const mcStatus   = payment?.payment?.message ?? '';

      if (mcStatus.toLowerCase() !== 'successful' || paidAmount < parseFloat(deposit.amount)) {
        // Payment failed or cancelled — mark as rejected
        await sql`UPDATE deposit_receipts SET status='rejected' WHERE moncash_order_id=${orderId}`;
        return Response.redirect(`${SITE_URL}/dashboard.html?deposit=failed&reason=payment_unsuccessful`, 302);
      }

      // Payment confirmed — credit wallet atomically
      const sqlDirect = getDbDirect();
      try {
        await sqlDirect`BEGIN`;

        await sqlDirect`
          UPDATE deposit_receipts
          SET status='confirmed', reference=${transactionId || orderId}, notified_admin_at=NOW()
          WHERE moncash_order_id=${orderId} AND status != 'confirmed'
        `;

        // Credit the user's HTG wallet
        const [wallet] = await sqlDirect`
          SELECT id FROM wallets WHERE user_id=${deposit.user_id} AND currency='HTG' LIMIT 1
        `;

        if (wallet) {
          await sqlDirect`UPDATE wallets SET balance=balance+${paidAmount} WHERE id=${wallet.id}`;
          await sqlDirect`
            INSERT INTO transactions
              (receiver_id, wallet_id, type, amount, currency, status, description, completed_at)
            VALUES
              (${deposit.user_id}, ${wallet.id}, 'deposit', ${paidAmount}, 'HTG', 'completed',
               ${'MonCash deposit confirmed — ref: ' + (transactionId || orderId)}, NOW())
          `;
        }

        await sqlDirect`COMMIT`;
      } catch (err) {
        await sqlDirect`ROLLBACK`;
        throw err;
      }

      // Redirect to dashboard with success
      return Response.redirect(
        `${SITE_URL}/dashboard.html?deposit=success&amount=${paidAmount}`,
        302
      );
    } catch (err) {
      console.error('MonCash return error:', err.message);
      return Response.redirect(
        `${SITE_URL}/dashboard.html?deposit=failed&reason=server_error`,
        302
      );
    }
  }

  // ── CHECK STATUS ────────────────────────────────────────────
  // GET /api/moncash/status?order_id=xxx
  // Frontend polls this to know if a deposit was confirmed
  if (req.method === 'GET' && resource === 'status') {
    const session = await getSession(req, sql);
    if (!session) return errorResponse(401, 'Please log in first.');

    const orderId = url.searchParams.get('order_id');
    if (!orderId) return errorResponse(400, 'order_id required');

    const [deposit] = await sql`
      SELECT status, amount, reference FROM deposit_receipts
      WHERE moncash_order_id=${orderId} AND user_id=${session.user_id}
      LIMIT 1
    `;
    if (!deposit) return errorResponse(404, 'Order not found');
    return response(200, { status: deposit.status, amount: deposit.amount, reference: deposit.reference });
  }

  return errorResponse(404, 'Unknown moncash resource');
};

export const config = { path: '/api/moncash/:resource*' };
