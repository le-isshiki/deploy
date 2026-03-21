// v2 — rebuilt 2026-03-20
// netlify/functions/wallet.js
import { getDb, getUserId, getSession, response, errorResponse, parseBody, sanitize } from './_utils/db.js';

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});

  const sql    = getDb();
  const userId = await getUserId(req, sql);
  if (!userId) return errorResponse(401, 'Invalid or expired token. Please log in again.');

  const url      = new URL(req.url);
  const segments = url.pathname.replace('/api/wallet', '').split('/').filter(Boolean);
  const resource = segments[0];

  // ── GET /api/wallet — main balance ────────────────────────
  if (req.method === 'GET' && !resource) {
    const wallets = await sql`
      SELECT * FROM wallets WHERE user_id = ${userId} AND is_active = TRUE ORDER BY created_at ASC
    `;
    return response(200, { wallets, primary: wallets[0] ?? null });
  }

  // ── POST /api/wallet/deposit — submit deposit request ─────
  if (req.method === 'POST' && resource === 'deposit') {
    const body = await parseBody(req);
    if (!body) return errorResponse(400, 'Invalid request');

    const amount      = parseFloat(body.amount);
    const from_wallet = body.from_wallet;
    const reference   = sanitize(body.reference ?? '');

    if (!amount || isNaN(amount) || amount <= 0)         return errorResponse(400, 'Invalid amount');
    if (amount > 500000)                                  return errorResponse(400, 'Maximum deposit is 500,000 HTG');
    if (!['moncash','natcash'].includes(from_wallet))     return errorResponse(400, 'from_wallet must be moncash or natcash');

    const [deposit] = await sql`
      INSERT INTO deposit_requests (user_id, amount, currency, from_wallet, reference)
      VALUES (${userId}, ${amount}, 'HTG', ${from_wallet}, ${reference || null})
      RETURNING id, amount, currency, from_wallet, reference, status, created_at
    `;

    return response(201, {
      message: 'Deposit request submitted. An admin will credit your wallet within 15 minutes.',
      deposit,
    });
  }

  // ── POST /api/wallet/withdraw — submit withdrawal request ─
  if (req.method === 'POST' && resource === 'withdraw') {
    const body = await parseBody(req);
    if (!body) return errorResponse(400, 'Invalid request');

    const amount       = parseFloat(body.amount);
    const to_wallet    = body.to_wallet;
    const phone_number = sanitize(body.phone_number ?? '');

    if (!amount || isNaN(amount) || amount <= 0)       return errorResponse(400, 'Invalid amount');
    if (amount < 100)                                   return errorResponse(400, 'Minimum withdrawal is 100 HTG');
    if (!['moncash','natcash'].includes(to_wallet))     return errorResponse(400, 'to_wallet must be moncash or natcash');
    if (!phone_number)                                  return errorResponse(400, 'Phone number is required');

    // Check balance
    const [wallet] = await sql`
      SELECT id, balance FROM wallets WHERE user_id = ${userId} AND currency = 'HTG'
    `;
    if (!wallet || wallet.balance < amount) {
      return errorResponse(400, `Insufficient balance. You have ${wallet?.balance ?? 0} HTG.`);
    }

    // Reserve the funds (deduct immediately, refund if rejected)
    await sql`UPDATE wallets SET balance = balance - ${amount} WHERE id = ${wallet.id}`;

    const [withdrawal] = await sql`
      INSERT INTO withdrawal_requests (user_id, amount, currency, to_wallet, phone_number, status)
      VALUES (${userId}, ${amount}, 'HTG', ${to_wallet}, ${phone_number}, 'pending')
      RETURNING id, amount, currency, to_wallet, phone_number, status, created_at
    `;

    return response(201, {
      message: 'Withdrawal request submitted. Funds will be sent within 30 minutes during business hours.',
      withdrawal,
    });
  }

  // ── GET /api/wallet/deposits — user's deposit history ─────
  if (req.method === 'GET' && resource === 'deposits') {
    const deposits = await sql`
      SELECT * FROM deposit_requests WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT 50
    `;
    return response(200, { deposits });
  }

  // ── GET /api/wallet/withdrawals — user's withdrawal history
  if (req.method === 'GET' && resource === 'withdrawals') {
    const withdrawals = await sql`
      SELECT * FROM withdrawal_requests WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT 50
    `;
    return response(200, { withdrawals });
  }

  return errorResponse(405, 'Method not allowed');
};

export const config = { path: '/api/wallet/:resource?' };
