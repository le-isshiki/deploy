// v2 — rebuilt 2026-03-20
// netlify/functions/disputes.js
//
// User routes (require user session token in Authorization: Bearer <token>):
//   POST   /api/disputes                  — open a dispute on a completed transfer
//   GET    /api/disputes                  — list own disputes
//   GET    /api/disputes/:id              — view single dispute
//   POST   /api/disputes/:id/cancel       — cancel own open dispute
//
// Admin routes (require x-admin-token header):
//   GET    /api/disputes/admin/list       — list all disputes, filter by status
//   PUT    /api/disputes/:id/review       — mark under review
//   PUT    /api/disputes/:id/resolve      — resolve (optionally issue refund)
//   PUT    /api/disputes/:id/reject       — reject dispute

import { getDb, getSession, response, errorResponse } from './_utils/db.js';

const DISPUTE_REASONS = ['wrong_amount', 'transfer_not_received', 'duplicate_charge', 'unauthorized_transfer', 'other'];
const DISPUTE_WINDOW_HOURS = 72; // window after completion to file a dispute

function sanitize(str, max = 2000) {
  if (!str) return '';
  return String(str).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

async function parseBody(req) {
  try { return await req.json(); } catch { return null; }
}

async function verifyAdmin(req, sql) {
  const token = req.headers.get('x-admin-token');
  if (!token) return null;
  const [s] = await sql`SELECT id FROM admin_sessions WHERE token = ${token} AND expires_at > NOW()`;
  if (!s) return null;
  const [a] = await sql`SELECT username FROM admin_credentials LIMIT 1`;
  return a ?? { username: 'admin' };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});

  const url      = new URL(req.url);
  const segments = url.pathname.replace(/^\/api\/disputes\/?/, '').split('/').filter(Boolean);
  const seg0     = segments[0]; // first segment: dispute id or 'admin'
  const seg1     = segments[1]; // second segment: action or 'list'
  const sql      = getDb();

  // ── ADMIN ROUTES ────────────────────────────────────────────────────────────

  if (seg0 === 'admin') {
    const admin = await verifyAdmin(req, sql);
    if (!admin) return errorResponse(401, 'Admin authentication required');

    // GET /api/disputes/admin/list?status=open|under_review|resolved|rejected|cancelled|all
    if (req.method === 'GET' && seg1 === 'list') {
      const status = url.searchParams.get('status') ?? 'open';
      const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '100'), 200);
      const offset = parseInt(url.searchParams.get('offset') ?? '0');

      const disputes = status === 'all'
        ? await sql`
            SELECT d.*, p.full_name, p.email, p.phone,
                   t.amount, t.direction, t.recipient_phone, t.reference AS tx_reference, t.status AS transfer_status
            FROM disputes d
            JOIN profiles p ON p.id = d.user_id
            JOIN transactions t ON t.id = d.transaction_id
            ORDER BY d.created_at DESC
            LIMIT ${limit} OFFSET ${offset}`
        : await sql`
            SELECT d.*, p.full_name, p.email, p.phone,
                   t.amount, t.direction, t.recipient_phone, t.reference AS tx_reference, t.status AS transfer_status
            FROM disputes d
            JOIN profiles p ON p.id = d.user_id
            JOIN transactions t ON t.id = d.transaction_id
            WHERE d.status = ${status}
            ORDER BY d.created_at DESC
            LIMIT ${limit} OFFSET ${offset}`;

      const [{ count: open_count }]  = await sql`SELECT COUNT(*) FROM disputes WHERE status = 'open'`;
      const [{ count: total_count }] = await sql`SELECT COUNT(*) FROM disputes`;

      return response(200, {
        disputes,
        open_count:  parseInt(open_count),
        total_count: parseInt(total_count),
      });
    }

    return errorResponse(404, 'Unknown admin disputes route');
  }

  // PUT /api/disputes/:id/review|resolve|reject — admin actions on a specific dispute
  if ((seg1 === 'review' || seg1 === 'resolve' || seg1 === 'reject') && req.method === 'PUT') {
    const admin = await verifyAdmin(req, sql);
    if (!admin) return errorResponse(401, 'Admin authentication required');

    const disputeId = seg0;
    const [dispute] = await sql`SELECT * FROM disputes WHERE id = ${disputeId}`;
    if (!dispute) return errorResponse(404, 'Dispute not found');

    if (dispute.status === 'resolved' || dispute.status === 'rejected') {
      return errorResponse(400, `Dispute is already ${dispute.status}`);
    }
    if (dispute.status === 'cancelled') {
      return errorResponse(400, 'Cannot act on a cancelled dispute');
    }

    if (seg1 === 'review') {
      await sql`
        UPDATE disputes
        SET status = 'under_review', reviewed_by = ${admin.username}, updated_at = NOW()
        WHERE id = ${disputeId}
      `;
      return response(200, { message: 'Dispute marked as under review.' });
    }

    const body         = await parseBody(req);
    const admin_notes  = sanitize(body?.notes ?? body?.admin_notes ?? '', 2000);
    const issue_refund = seg1 === 'resolve' && !!body?.issue_refund;

    await sql`
      UPDATE disputes SET
        status        = ${seg1 === 'resolve' ? 'resolved' : 'rejected'},
        admin_notes   = ${admin_notes},
        reviewed_by   = ${admin.username},
        reviewed_at   = NOW(),
        refund_issued = ${issue_refund},
        updated_at    = NOW()
      WHERE id = ${disputeId}
    `;

    // If resolving with refund — credit the user's HTG wallet
    if (issue_refund) {
      const [tx] = await sql`SELECT amount, sender_id FROM transactions WHERE id = ${dispute.transaction_id}`;
      if (tx) {
        await sql`
          UPDATE wallets SET balance = balance + ${tx.amount}
          WHERE user_id = ${tx.sender_id} AND currency = 'HTG'
        `;
        await sql`
          INSERT INTO transactions (sender_id, receiver_id, type, amount, currency, status, description, completed_at)
          VALUES (NULL, ${tx.sender_id}, 'deposit', ${tx.amount}, 'HTG', 'completed',
                  ${'Dispute refund — case ' + dispute.reference}, NOW())
        `;
      }
    }

    return response(200, {
      message: `Dispute ${seg1 === 'resolve' ? 'resolved' : 'rejected'}.${issue_refund ? ' Refund credited to user wallet.' : ''}`,
    });
  }

  // ── USER ROUTES ─────────────────────────────────────────────────────────────

  const session = await getSession(req, sql);
  if (!session) return errorResponse(401, 'Invalid or expired token. Please log in again.');

  // POST /api/disputes — open a new dispute
  if (req.method === 'POST' && !seg0) {
    const body = await parseBody(req);
    if (!body) return errorResponse(400, 'Invalid request body');

    const { transaction_id, reason, description } = body;

    if (!transaction_id)                     return errorResponse(400, 'transaction_id is required');
    if (!DISPUTE_REASONS.includes(reason))   return errorResponse(400, `reason must be one of: ${DISPUTE_REASONS.join(', ')}`);
    if (!description?.trim())                return errorResponse(400, 'Please describe the issue');
    if (description.trim().length < 20)      return errorResponse(400, 'Description must be at least 20 characters');
    if (description.trim().length > 2000)    return errorResponse(400, 'Description must be under 2000 characters');

    // Verify transaction belongs to this user, is of type 'send', and is completed
    const [tx] = await sql`
      SELECT id, amount, status, completed_at, type
      FROM transactions
      WHERE id     = ${transaction_id}
        AND sender_id = ${session.user_id}
        AND type   = 'send'
    `;
    if (!tx) return errorResponse(404, 'Transaction not found or does not belong to your account');
    if (tx.status !== 'completed')
      return errorResponse(400, 'You can only dispute transfers that have been completed');

    // Enforce 72-hour dispute window from completion time
    const hoursSince = (Date.now() - new Date(tx.completed_at).getTime()) / 3_600_000;
    if (hoursSince > DISPUTE_WINDOW_HOURS) {
      return errorResponse(400,
        `The ${DISPUTE_WINDOW_HOURS}-hour window to dispute this transfer has closed. ` +
        `It was completed ${Math.floor(hoursSince)} hours ago.`
      );
    }

    // Prevent duplicate open disputes for the same transaction
    const [existing] = await sql`
      SELECT id FROM disputes
      WHERE transaction_id = ${transaction_id}
        AND user_id        = ${session.user_id}
        AND status NOT IN ('rejected', 'cancelled')
    `;
    if (existing) return errorResponse(409, 'You already have an active dispute for this transaction');

    const reference = 'DSP-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

    const [dispute] = await sql`
      INSERT INTO disputes (user_id, transaction_id, reason, description, reference)
      VALUES (${session.user_id}, ${transaction_id}, ${reason}, ${sanitize(description, 2000)}, ${reference})
      RETURNING id, reference, status, reason, created_at
    `;

    return response(201, {
      dispute,
      message: 'Dispute filed successfully. We will review your case within 24–48 hours.',
    });
  }

  // GET /api/disputes — list this user's disputes
  if (req.method === 'GET' && !seg0) {
    const disputes = await sql`
      SELECT d.id, d.reference, d.reason, d.description, d.status,
             d.admin_notes, d.refund_issued, d.created_at, d.reviewed_at, d.updated_at,
             t.amount, t.direction, t.recipient_phone, t.reference AS tx_reference, t.completed_at
      FROM disputes d
      JOIN transactions t ON t.id = d.transaction_id
      WHERE d.user_id = ${session.user_id}
      ORDER BY d.created_at DESC
      LIMIT 50
    `;
    return response(200, { disputes });
  }

  // GET /api/disputes/:id — single dispute detail
  if (req.method === 'GET' && seg0 && !seg1) {
    const [dispute] = await sql`
      SELECT d.*, t.amount, t.direction, t.recipient_phone, t.reference AS tx_reference, t.completed_at
      FROM disputes d
      JOIN transactions t ON t.id = d.transaction_id
      WHERE d.id = ${seg0} AND d.user_id = ${session.user_id}
    `;
    if (!dispute) return errorResponse(404, 'Dispute not found');
    return response(200, { dispute });
  }

  // POST /api/disputes/:id/cancel — user cancels own open dispute
  if (req.method === 'POST' && seg0 && seg1 === 'cancel') {
    const [dispute] = await sql`
      SELECT id, status FROM disputes
      WHERE id = ${seg0} AND user_id = ${session.user_id}
    `;
    if (!dispute) return errorResponse(404, 'Dispute not found');
    if (dispute.status !== 'open') {
      return errorResponse(400, `Dispute cannot be cancelled — it is currently ${dispute.status}`);
    }

    await sql`
      UPDATE disputes SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${seg0}
    `;
    return response(200, { message: 'Dispute cancelled successfully.' });
  }

  return errorResponse(404, 'Unknown disputes endpoint');
};

export const config = { path: '/api/disputes/:resource*' };
