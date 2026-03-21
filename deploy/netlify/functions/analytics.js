// v2 — rebuilt 2026-03-20
// netlify/functions/analytics.js
import { getDb, getUserId, response, errorResponse } from './_utils/db.js';

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});

  const sql    = getDb();
  const userId = await getUserId(req, sql);
  if (!userId) return errorResponse(401, 'Invalid or expired token. Please log in again.');

  if (req.method === 'GET') {
    // Use direct aggregation rather than the VIEW to avoid any schema mismatch
    const [summary] = await sql`
      SELECT
        COUNT(t.id) FILTER (WHERE t.status = 'completed')                                                   AS total_transactions,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'send'    AND t.status = 'completed' AND t.sender_id   = ${userId}), 0) AS total_sent,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'receive' AND t.status = 'completed' AND t.receiver_id = ${userId}), 0) AS total_received,
        COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'deposit' AND t.status = 'completed'), 0)             AS total_deposited,
        COUNT(t.id) FILTER (WHERE t.status IN ('pending','submitted','processing'))                          AS pending_transactions,
        MAX(t.created_at) AS last_transaction_at
      FROM transactions t
      WHERE t.sender_id = ${userId} OR t.receiver_id = ${userId}
    `;

    const monthly = await sql`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') AS month,
        DATE_TRUNC('month', created_at)                       AS month_start,
        COALESCE(SUM(CASE WHEN type = 'send'    AND sender_id   = ${userId} THEN amount ELSE 0 END), 0) AS sent,
        COALESCE(SUM(CASE WHEN type = 'receive' AND receiver_id = ${userId} THEN amount ELSE 0 END), 0) AS received,
        COUNT(*) AS count
      FROM transactions
      WHERE (sender_id = ${userId} OR receiver_id = ${userId})
        AND status = 'completed'
        AND created_at >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month_start ASC
    `;

    return response(200, {
      summary: summary ?? {
        total_transactions:   0,
        total_sent:           0,
        total_received:       0,
        total_deposited:      0,
        pending_transactions: 0,
        last_transaction_at:  null,
      },
      monthly_breakdown: monthly,
    });
  }

  return errorResponse(405, 'Method not allowed');
};

export const config = { path: '/api/analytics' };
