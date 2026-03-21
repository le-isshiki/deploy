// v2 — rebuilt 2026-03-20
// netlify/functions/transfers.js
import { getDb, getDbDirect, getSession, response, errorResponse, parseBody, sanitize } from './_utils/db.js';
import { sendTransferEmail, sendDepositReceiptEmail } from './_utils/email.js';

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});

  const sql     = getDb();
  const session = await getSession(req, sql);
  if (!session) return errorResponse(401, 'Invalid or expired token. Please log in again.');

  const url      = new URL(req.url);
  const segments = url.pathname.replace('/api/transfers', '').split('/').filter(Boolean);
  const resource = segments[0];
  const subId    = segments[1];

  // ── SUBMIT TRANSFER ──────────────────────────────────────────
  if (req.method === 'POST' && !resource) {
    const body = await parseBody(req);
    if (!body) return errorResponse(400, 'Invalid request');

    const amount          = parseFloat(body.amount);
    const direction       = body.direction;
    const recipient_phone = sanitize(body.recipient_phone ?? '');
    const recipient_name  = sanitize(body.recipient_name ?? '');

    if (!amount || isNaN(amount) || amount <= 0)        return errorResponse(400, 'Invalid amount');
    if (amount < 100)                                    return errorResponse(400, 'Minimum transfer is 100 HTG');
    if (!['mc_to_nc','nc_to_mc'].includes(direction))   return errorResponse(400, 'direction must be mc_to_nc or nc_to_mc');
    if (!recipient_phone)                               return errorResponse(400, 'Recipient phone number required');

    // KYC limit enforcement
    const [kycProfile] = await sql`SELECT kyc_status, transfer_limit_htg FROM profiles WHERE id = ${session.user_id}`;
    const transferLimit = parseFloat(kycProfile?.transfer_limit_htg ?? 5000);
    if (amount > transferLimit) {
      if (kycProfile?.kyc_status !== 'verified') {
        return errorResponse(403, `Transfer limit is ${transferLimit.toLocaleString()} HTG until your identity is verified. Please complete KYC in the "Verify ID" section to unlock up to 200,000 HTG.`);
      }
      return errorResponse(400, `Maximum transfer is ${transferLimit.toLocaleString()} HTG`);
    }

    const fee        = parseFloat((amount * 0.05).toFixed(2));
    const net_amount = parseFloat((amount - fee).toFixed(2));

    // Check daily limit
    const [{ total }] = await sql`
      SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE sender_id = ${session.user_id}
        AND type = 'send'
        AND status NOT IN ('cancelled','failed')
        AND created_at >= NOW()::date
    `;
    if (parseFloat(total) + amount > 200000)
      return errorResponse(400, `Daily limit reached. You have ${(200000 - parseFloat(total)).toLocaleString()} HTG remaining today.`);

    // Check wallet balance
    const [wallet] = await sql`
      SELECT id, balance FROM wallets WHERE user_id = ${session.user_id} AND currency = 'HTG'
    `;
    if (!wallet || parseFloat(wallet.balance) < amount)
      return errorResponse(400, `Insufficient balance. You have ${parseFloat(wallet?.balance ?? 0).toLocaleString()} HTG.`);

    const now            = new Date();
    const cancelDeadline = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
    const visibleAt      = new Date(now.getTime() + 2 * 60 * 1000).toISOString();

    const sqlDirect = getDbDirect();
    try {
      await sqlDirect`BEGIN`;
      // Deduct from wallet
      await sqlDirect`
        UPDATE wallets SET balance = balance - ${amount}
        WHERE id = ${wallet.id} AND balance >= ${amount}
      `;
      // Create transaction
      const [tx] = await sqlDirect`
        INSERT INTO transactions (
          sender_id, wallet_id, type, amount, fee, currency, status,
          direction, recipient_phone, recipient_name,
          cancel_deadline, visible_to_agents_at, description
        ) VALUES (
          ${session.user_id}, ${wallet.id}, 'send', ${amount}, ${fee}, 'HTG', 'submitted',
          ${direction}, ${recipient_phone}, ${recipient_name || null},
          ${cancelDeadline}, ${visibleAt},
          ${`Transfer ${direction === 'mc_to_nc' ? 'MonCash → NatCash' : 'NatCash → MonCash'} to ${recipient_phone}`}
        )
        RETURNING id, amount, fee, status, cancel_deadline, visible_to_agents_at, created_at
      `;
      await sqlDirect`COMMIT`;
      return response(201, {
        transfer: {
          ...tx,
          net_amount,
          direction,
          recipient_phone,
          recipient_name,
          message: 'Transfer submitted. You have 2 minutes to cancel.',
        },
      });
    } catch (err) {
      await sqlDirect`ROLLBACK`;
      return errorResponse(500, 'Could not submit transfer. Please try again.');
    }
  }

  // ── CANCEL TRANSFER ──────────────────────────────────────────
  if (req.method === 'POST' && resource === 'cancel') {
    const body = await parseBody(req);
    const txId = body?.transaction_id ?? subId;
    if (!txId) return errorResponse(400, 'transaction_id required');

    const [tx] = await sql`
      SELECT id, amount, sender_id, wallet_id, status, cancel_deadline
      FROM transactions WHERE id = ${txId} AND sender_id = ${session.user_id}
    `;
    if (!tx) return errorResponse(404, 'Transfer not found');
    if (tx.status === 'cancelled') return errorResponse(400, 'Transfer already cancelled');
    if (tx.status === 'completed') return errorResponse(400, 'Cannot cancel a completed transfer');
    if (new Date(tx.cancel_deadline) < new Date())
      return errorResponse(400, 'Cancel window has closed (2 minutes passed). Contact support if needed.');

    const sqlDirect = getDbDirect();
    try {
      await sqlDirect`BEGIN`;
      await sqlDirect`UPDATE transactions SET status='cancelled' WHERE id=${txId}`;
      await sqlDirect`UPDATE wallets SET balance=balance+${tx.amount} WHERE id=${tx.wallet_id}`;
      // If there's an active claim, expire it
      await sqlDirect`
        UPDATE transfer_claims SET status='abandoned'
        WHERE transaction_id=${txId} AND status='active'
      `;
      await sqlDirect`COMMIT`;
      return response(200, { message: 'Transfer cancelled. Your funds have been returned.' });
    } catch (err) {
      await sqlDirect`ROLLBACK`;
      return errorResponse(500, 'Could not cancel transfer. Please try again.');
    }
  }

  // ── TRANSFER STATUS ──────────────────────────────────────────
  if (req.method === 'GET' && resource === 'status') {
    const txId = subId ?? url.searchParams.get('id');
    if (!txId) return errorResponse(400, 'transaction_id required');
    await sql`SELECT expire_stale_claims()`;

    const [tx] = await sql`
      SELECT t.id, t.amount, t.fee, t.status, t.direction, t.currency,
             t.recipient_phone, t.recipient_name,
             t.cancel_deadline, t.visible_to_agents_at, t.created_at, t.completed_at,
             -- Active claim info
             tc.expires_at AS claim_expires_at,
             a.full_name AS agent_name,
             -- Proof if completed
             tp.image_url AS proof_url
      FROM transactions t
      LEFT JOIN transfer_claims tc ON tc.id = t.current_claim_id AND tc.status = 'active'
      LEFT JOIN agents a ON a.id = tc.agent_id
      LEFT JOIN transfer_proofs tp ON tp.transaction_id = t.id
      WHERE t.id = ${txId} AND t.sender_id = ${session.user_id}
    `;
    if (!tx) return errorResponse(404, 'Transfer not found');

    const now = new Date();
    const canCancel = tx.status === 'submitted' && new Date(tx.cancel_deadline) > now;
    const secondsUntilAgents = tx.status === 'submitted'
      ? Math.max(0, Math.round((new Date(tx.visible_to_agents_at) - now) / 1000))
      : 0;

    return response(200, {
      transfer: {
        ...tx,
        can_cancel: canCancel,
        seconds_until_agents: secondsUntilAgents,
        agent_name: tx.agent_name ? tx.agent_name.split(' ')[0] : null, // first name only
      },
    });
  }

  // ── USER TRANSFER LIST ───────────────────────────────────────
  if (req.method === 'GET' && !resource) {
    const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100);
    const offset = parseInt(url.searchParams.get('offset') ?? '0');
    const txs = await sql`
      SELECT t.id, t.amount, t.fee, t.status, t.direction, t.currency,
             t.recipient_phone, t.recipient_name, t.created_at, t.completed_at,
             t.cancel_deadline,
             tp.image_url AS proof_url
      FROM transactions t
      LEFT JOIN transfer_proofs tp ON tp.transaction_id = t.id
      WHERE t.sender_id = ${session.user_id} AND t.type = 'send'
      ORDER BY t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return response(200, { transfers: txs });
  }

  // ── UPLOAD DEPOSIT RECEIPT ────────────────────────────────────
  if (req.method === 'POST' && resource === 'deposit-receipt') {
    const body = await parseBody(req);
    const { wallet_type, amount, reference, image_base64, image_type } = body ?? {};

    if (!['moncash','natcash'].includes(wallet_type)) return errorResponse(400, 'wallet_type must be moncash or natcash');
    if (!amount || parseFloat(amount) < 100) return errorResponse(400, 'Minimum deposit is 100 HTG');

    // Store a small thumbnail preview only (first 50KB of base64 = ~37KB image)
    // Full image storage via blobs not needed — reference number is sufficient for admin verification
    let image_url = 'receipt-submitted';
    if (image_base64) {
      // Store only a thumbnail-sized portion to keep DB rows small
      const preview = image_base64.slice(0, 50000);
      image_url = `data:${image_type || 'image/jpeg'};base64,${preview}`;
    }

    const [profile] = await sql`SELECT full_name, phone, email FROM profiles WHERE id = ${session.user_id}`;

    const [receipt] = await sql`
      INSERT INTO deposit_receipts (user_id, image_url, wallet_type, amount, reference, upload_method)
      VALUES (
        ${session.user_id},
        ${image_url},
        ${wallet_type},
        ${parseFloat(amount)},
        ${reference ? sanitize(reference) : null},
        'dashboard'
      )
      RETURNING id, created_at
    `;

    await sql`UPDATE deposit_receipts SET notified_admin_at=NOW() WHERE id=${receipt.id}`;

    sendDepositReceiptEmail({
      userName:  profile?.full_name,
      userPhone: profile?.phone,
      userEmail: profile?.email,
      walletType: wallet_type,
      amount,
      imageUrl:  reference ? 'Ref: ' + reference : 'No reference provided',
    }).catch(() => {});

    return response(201, {
      receipt_id: receipt.id,
      message: 'Deposit request submitted! An admin will credit your wallet within 15 minutes.',
    });
  }

  // ── MY DEPOSIT HISTORY ─────────────────────────────────────
  if (req.method === 'GET' && resource === 'my-deposits') {
    const session = await getSession(req, sql);
    if (!session) return errorResponse(401, 'Not authenticated');

    const deposits = await sql`
      SELECT id, wallet_type, amount, reference, status, created_at
      FROM deposit_receipts
      WHERE user_id = ${session.user_id}
      ORDER BY created_at DESC
      LIMIT 50
    `;
    return response(200, { deposits });
  }

  return errorResponse(404, 'Unknown resource');
};

export const config = { path: '/api/transfers/:resource*' };
