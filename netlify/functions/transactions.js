// v2 — rebuilt 2026-03-20
// netlify/functions/transactions.js
// GET  /api/transactions   — list user's transactions (with optional type/status filters)
// POST /api/transactions   — send money (simple wallet-to-wallet)

import { getDb, getDbDirect, getUserId, response, errorResponse, parseBody, sanitize } from './_utils/db.js';

const FEE_RATE    = 0.05;
const MAX_NC_MC   = 75000;
const DAILY_LIMIT = 200000;

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});

  const sql    = getDb();
  const userId = await getUserId(req, sql);
  if (!userId) return errorResponse(401, 'Invalid or expired token. Please log in again.');

  // ── GET: list transactions ──────────────────────────────────
  if (req.method === 'GET') {
    const url    = new URL(req.url);
    const limit  = Math.min(parseInt(url.searchParams.get('limit')  ?? '20'), 100);
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0'),  0);
    const type   = url.searchParams.get('type')   ?? null;
    const status = url.searchParams.get('status') ?? null;

    // NOTE: @netlify/neon does NOT support nested sql`` fragments.
    // Each filter combination needs its own explicit query.
    let transactions, countRow;

    if (!type && !status) {
      transactions = await sql`
        SELECT t.*, s.full_name AS sender_name, r.full_name AS receiver_name
        FROM transactions t
        LEFT JOIN profiles s ON s.id = t.sender_id
        LEFT JOIN profiles r ON r.id = t.receiver_id
        WHERE (t.sender_id = ${userId} OR t.receiver_id = ${userId})
        ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
      [countRow] = await sql`
        SELECT COUNT(*) FROM transactions
        WHERE sender_id = ${userId} OR receiver_id = ${userId}`;
    } else if (type && !status) {
      transactions = await sql`
        SELECT t.*, s.full_name AS sender_name, r.full_name AS receiver_name
        FROM transactions t
        LEFT JOIN profiles s ON s.id = t.sender_id
        LEFT JOIN profiles r ON r.id = t.receiver_id
        WHERE (t.sender_id = ${userId} OR t.receiver_id = ${userId})
          AND t.type = ${type}
        ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
      [countRow] = await sql`
        SELECT COUNT(*) FROM transactions
        WHERE (sender_id = ${userId} OR receiver_id = ${userId}) AND type = ${type}`;
    } else if (!type && status) {
      transactions = await sql`
        SELECT t.*, s.full_name AS sender_name, r.full_name AS receiver_name
        FROM transactions t
        LEFT JOIN profiles s ON s.id = t.sender_id
        LEFT JOIN profiles r ON r.id = t.receiver_id
        WHERE (t.sender_id = ${userId} OR t.receiver_id = ${userId})
          AND t.status = ${status}
        ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
      [countRow] = await sql`
        SELECT COUNT(*) FROM transactions
        WHERE (sender_id = ${userId} OR receiver_id = ${userId}) AND status = ${status}`;
    } else {
      transactions = await sql`
        SELECT t.*, s.full_name AS sender_name, r.full_name AS receiver_name
        FROM transactions t
        LEFT JOIN profiles s ON s.id = t.sender_id
        LEFT JOIN profiles r ON r.id = t.receiver_id
        WHERE (t.sender_id = ${userId} OR t.receiver_id = ${userId})
          AND t.type = ${type} AND t.status = ${status}
        ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
      [countRow] = await sql`
        SELECT COUNT(*) FROM transactions
        WHERE (sender_id = ${userId} OR receiver_id = ${userId})
          AND type = ${type} AND status = ${status}`;
    }

    return response(200, {
      transactions,
      pagination: { total: parseInt(countRow.count), limit, offset },
    });
  }

  // ── POST: send money ────────────────────────────────────────
  if (req.method === 'POST') {
    const body = await parseBody(req);
    if (!body) return errorResponse(400, 'Invalid JSON body');

    const { receiver_phone, receiver_id, amount, currency = 'HTG', description } = body;
    const amt = parseFloat(amount);

    if (!amt || isNaN(amt) || amt <= 0) return errorResponse(400, 'Invalid amount');
    if (!receiver_phone?.trim() && !receiver_id)
      return errorResponse(400, 'Receiver phone or ID required');

    const [dailyRow] = await sql`
      SELECT COALESCE(SUM(amount), 0) AS total_today
      FROM transactions
      WHERE sender_id = ${userId} AND type = 'send'
        AND status = 'completed' AND created_at >= NOW()::date
    `;
    if (parseFloat(dailyRow.total_today) + amt > DAILY_LIMIT)
      return errorResponse(400, `Daily transfer limit of ${DAILY_LIMIT.toLocaleString()} HTG reached.`);

    // Look up receiver — by ID (P2P) or by phone
    let receiver;
    if (receiver_id) {
      [receiver] = await sql`SELECT id, full_name FROM profiles WHERE id = ${receiver_id}`;
    } else {
      [receiver] = await sql`SELECT id, full_name FROM profiles WHERE phone = ${receiver_phone.trim()}`;
    }
    if (!receiver)              return errorResponse(404, 'No SwitchCash account found');
    if (receiver.id === userId) return errorResponse(400, 'You cannot send money to yourself');

    // P2P (receiver_id) = zero fee; phone/external = 5% fee
    const isP2P     = !!receiver_id;
    const fee       = isP2P ? 0 : parseFloat((amt * FEE_RATE).toFixed(2));
    const totalCost = parseFloat((amt + fee).toFixed(2));

    const sqlDirect = getDbDirect();
    try {
      await sqlDirect`BEGIN`;
      const [wallet] = await sqlDirect`
        SELECT id, balance FROM wallets
        WHERE user_id = ${userId} AND currency = ${currency} FOR UPDATE`;
      if (!wallet)                    { await sqlDirect`ROLLBACK`; return errorResponse(404, 'Wallet not found'); }
      if (wallet.balance < totalCost) { await sqlDirect`ROLLBACK`; return errorResponse(400, `Insufficient balance. Need ${totalCost} HTG, have ${wallet.balance} HTG`); }

      await sqlDirect`UPDATE wallets SET balance = balance - ${totalCost} WHERE id = ${wallet.id}`;
      await sqlDirect`UPDATE wallets SET balance = balance + ${amt} WHERE user_id = ${receiver.id} AND currency = ${currency}`;
      const [tx] = await sqlDirect`
        INSERT INTO transactions (sender_id, receiver_id, wallet_id, type, amount, fee, currency, status, description, completed_at)
        VALUES (${userId}, ${receiver.id}, ${wallet.id}, 'send', ${amt}, ${fee}, ${currency}, 'completed',
                ${sanitize(description ?? (isP2P ? 'P2P transfer' : 'Transfer'), 200)}, NOW())
        RETURNING *`;
      if (fee > 0) {
        await sqlDirect`
          INSERT INTO transactions (sender_id, wallet_id, type, amount, currency, status, description, completed_at)
          VALUES (${userId}, ${wallet.id}, 'fee', ${fee}, ${currency}, 'completed', ${'Fee for ' + tx.reference}, NOW())`;
      }
      await sqlDirect`COMMIT`;
      return response(201, { transaction: tx, fee, is_p2p: isP2P });
    } catch {
      try { await sqlDirect`ROLLBACK`; } catch {}
      return errorResponse(500, 'Transfer failed. No money was moved. Please try again.');
    }
  }


  return errorResponse(405, 'Method not allowed');
};

export const config = { path: '/api/transactions' };
