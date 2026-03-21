// v2 — rebuilt 2026-03-20
// netlify/functions/agent.js
import { getDb, getDbDirect, response, errorResponse, isRateLimited, parseBody, sanitize } from './_utils/db.js';
import { getStore } from '@netlify/blobs';
import bcrypt from 'bcryptjs';

// ── Auth helper ──────────────────────────────────────────────
async function verifyAgent(req, sql) {
  const token = req.headers.get('x-agent-token');
  if (!token) return null;
  const [session] = await sql`
    SELECT s.agent_id, s.token, a.full_name, a.email, a.is_suspended, a.is_active,
           a.moncash_phone, a.natcash_phone
    FROM agent_sessions s
    JOIN agents a ON a.id = s.agent_id
    WHERE s.token = ${token} AND s.expires_at > NOW()
  `;
  if (!session || session.is_suspended || !session.is_active) return null;
  // Update last_ping
  await sql`UPDATE agent_sessions SET last_ping_at = NOW() WHERE token = ${token}`;
  await sql`UPDATE agents SET last_seen_at = NOW() WHERE id = ${session.agent_id}`;
  return session;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});

  const url      = new URL(req.url);
  const segments = url.pathname.replace('/api/agent', '').split('/').filter(Boolean);
  const resource = segments[0];
  const subId    = segments[1];
  const sql      = getDb();
  const ip       = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  // ── LOGIN ───────────────────────────────────────────────────
  if (req.method === 'POST' && resource === 'login') {
    if (await isRateLimited(sql, `agent-login:${ip}`, 8, 15))
      return errorResponse(429, 'Too many attempts. Wait 15 minutes.');

    const body = await parseBody(req);
    if (!body) return errorResponse(400, 'Invalid request');
    const { email, password } = body;
    if (!email || !password) return errorResponse(400, 'Email and password required');

    const [agent] = await sql`
      SELECT id, email, full_name, password_hash, is_active, is_suspended,
             failed_attempts, locked_until, moncash_phone, natcash_phone
      FROM agents WHERE email = ${sanitize(email).toLowerCase()}
    `;

    if (agent?.locked_until && new Date(agent.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(agent.locked_until) - Date.now()) / 60000);
      return errorResponse(423, `Account locked. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`);
    }
    if (agent?.is_suspended) return errorResponse(403, 'Your account has been suspended. Contact admin.');
    if (agent && !agent.is_active) return errorResponse(403, 'Account inactive. Contact admin.');

    const valid = agent
      ? await bcrypt.compare(password, agent.password_hash)
      : await bcrypt.compare(password, '$2b$12$invalidhashfortimingprotection00000000000000000000000');

    if (!agent || !valid) {
      if (agent) {
        const attempts  = (agent.failed_attempts || 0) + 1;
        const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
        await sql`UPDATE agents SET failed_attempts=${attempts}, locked_until=${lockUntil} WHERE id=${agent.id}`;
      }
      return errorResponse(401, 'Invalid email or password');
    }

    await sql`UPDATE agents SET failed_attempts=0, locked_until=NULL WHERE id=${agent.id}`;
    await sql`DELETE FROM agent_sessions WHERE agent_id=${agent.id} AND expires_at < NOW()`;
    const [session] = await sql`
      INSERT INTO agent_sessions (agent_id, ip_address, user_agent)
      VALUES (${agent.id}, ${ip}, ${req.headers.get('user-agent') ?? null})
      RETURNING token, expires_at, online_since
    `;
    return response(200, {
      token:      session.token,
      expires_at: session.expires_at,
      agent: {
        id: agent.id, email: agent.email, full_name: agent.full_name,
        moncash_phone: agent.moncash_phone, natcash_phone: agent.natcash_phone,
      },
    });
  }

  // ── LOGOUT ──────────────────────────────────────────────────
  if (req.method === 'POST' && resource === 'logout') {
    const token = req.headers.get('x-agent-token');
    if (token) await sql`DELETE FROM agent_sessions WHERE token = ${token}`;
    return response(200, { message: 'Logged out' });
  }

  // Auth required below
  const agent = await verifyAgent(req, sql);
  if (!agent) return errorResponse(401, 'Session expired. Please log in again.');

  // ── PING (heartbeat every 30s) ──────────────────────────────
  if (req.method === 'POST' && resource === 'ping') {
    return response(200, { ok: true, server_time: new Date().toISOString() });
  }

  // ── AVAILABLE TRANSFERS ─────────────────────────────────────
  // Expire stale claims first (Option A — on-demand)
  if (req.method === 'GET' && resource === 'transfers') {
    await sql`SELECT expire_stale_claims()`;

    const transfers = await sql`
      SELECT
        t.id, t.amount, t.currency, t.direction, t.status,
        t.recipient_phone, t.recipient_name,
        t.visible_to_agents_at, t.created_at,
        p.full_name AS sender_name, p.phone AS sender_phone,
        -- Claim history for this agent on this transfer
        (SELECT COUNT(*) FROM transfer_claims c
         WHERE c.transaction_id = t.id AND c.agent_id = ${agent.agent_id}
           AND c.status = 'expired') AS agent_expired_count,
        -- Whether this agent has an active claim on it
        (SELECT id FROM transfer_claims c
         WHERE c.transaction_id = t.id AND c.agent_id = ${agent.agent_id}
           AND c.status = 'active' LIMIT 1) AS my_active_claim_id,
        -- Active claim info (who's processing it)
        tc.expires_at AS claim_expires_at,
        tc.agent_id AS claimed_by_agent_id
      FROM transactions t
      JOIN profiles p ON p.id = t.sender_id
      LEFT JOIN transfer_claims tc ON tc.id = t.current_claim_id AND tc.status = 'active'
      WHERE t.type = 'send'
        AND t.visible_to_agents_at <= NOW()
        AND t.status IN ('submitted', 'pending', 'processing')
      ORDER BY t.created_at ASC
    `;

    // Filter: hide transfers where this agent has 2 expired attempts AND no admin approval
    const available = transfers.filter(t => {
      if (t.agent_expired_count >= 2) {
        // Only show if admin-approved a retry
        return false; // blocked — admin must approve via admin panel
      }
      return true;
    });

    return response(200, { transfers: available });
  }

  // ── MY ACTIVE CLAIM ─────────────────────────────────────────
  if (req.method === 'GET' && resource === 'my-claim') {
    await sql`SELECT expire_stale_claims()`;
    const [claim] = await sql`
      SELECT c.*, t.amount, t.currency, t.direction, t.recipient_phone, t.recipient_name,
             p.full_name AS sender_name, p.phone AS sender_phone
      FROM transfer_claims c
      JOIN transactions t ON t.id = c.transaction_id
      JOIN profiles p ON p.id = t.sender_id
      WHERE c.agent_id = ${agent.agent_id} AND c.status = 'active'
      ORDER BY c.created_at DESC LIMIT 1
    `;
    return response(200, { claim: claim ?? null });
  }

  // ── CLAIM A TRANSFER ────────────────────────────────────────
  if (req.method === 'POST' && resource === 'claim') {
    await sql`SELECT expire_stale_claims()`;
    const body = await parseBody(req);
    const txId = body?.transaction_id;
    if (!txId) return errorResponse(400, 'transaction_id required');

    // Check agent has no other active claim
    const [existing] = await sql`
      SELECT id FROM transfer_claims
      WHERE agent_id = ${agent.agent_id} AND status = 'active'
    `;
    if (existing) return errorResponse(409, 'You already have an active claim. Complete it first.');

    // Load transaction
    const [tx] = await sql`
      SELECT id, status, current_claim_id, visible_to_agents_at
      FROM transactions WHERE id = ${txId} AND type = 'send'
    `;
    if (!tx) return errorResponse(404, 'Transfer not found');
    if (tx.status === 'processing') return errorResponse(409, 'This transfer is already being processed by another agent.');
    if (!['pending','submitted'].includes(tx.status)) return errorResponse(400, `Transfer cannot be claimed (status: ${tx.status})`);
    if (tx.status === 'submitted' && new Date(tx.visible_to_agents_at) > new Date()) return errorResponse(400, 'Transfer is still in the cancel window.');

    // Check attempt count for this agent on this transfer
    const [{ count: expiredCount }] = await sql`
      SELECT COUNT(*) FROM transfer_claims
      WHERE transaction_id = ${txId} AND agent_id = ${agent.agent_id} AND status = 'expired'
    `;

    if (parseInt(expiredCount) >= 2) {
      // Check if admin approved a retry
      const [approved] = await sql`
        SELECT id FROM transfer_claims
        WHERE transaction_id = ${txId} AND agent_id = ${agent.agent_id}
          AND admin_approved = TRUE
        ORDER BY created_at DESC LIMIT 1
      `;
      if (!approved) return errorResponse(403, 'You have reached the attempt limit for this transfer. Admin approval required.');
    }

    const attemptNumber = parseInt(expiredCount) + 1;

    // Atomic claim
    const sqlDirect = getDbDirect();
    try {
      await sqlDirect`BEGIN`;
      const [tx2] = await sqlDirect`
        SELECT id FROM transactions WHERE id = ${txId} AND status IN ('pending','submitted') FOR UPDATE
      `;
      if (!tx2) { await sqlDirect`ROLLBACK`; return errorResponse(409, 'Transfer was just claimed by another agent.'); }

      const [claim] = await sqlDirect`
        INSERT INTO transfer_claims (transaction_id, agent_id, attempt_number)
        VALUES (${txId}, ${agent.agent_id}, ${attemptNumber})
        RETURNING id, expires_at, attempt_number
      `;
      await sqlDirect`
        UPDATE transactions SET status='processing', current_claim_id=${claim.id} WHERE id=${txId}
      `;
      await sqlDirect`COMMIT`;
      return response(200, {
        claim_id:       claim.id,
        expires_at:     claim.expires_at,
        attempt_number: claim.attempt_number,
        message:        `Transfer claimed. You have 5 minutes to complete it.`,
      });
    } catch (err) {
      await sqlDirect`ROLLBACK`;
      return errorResponse(500, 'Could not claim transfer. Please try again.');
    }
  }

  // ── COMPLETE A TRANSFER ─────────────────────────────────────
  if (req.method === 'POST' && resource === 'complete') {
    const body = await parseBody(req);
    const { claim_id, proof_url, notes } = body ?? {};
    if (!claim_id || !proof_url) return errorResponse(400, 'claim_id and proof_url required');

    const [claim] = await sql`
      SELECT c.*, t.amount, t.direction, t.sender_id
      FROM transfer_claims c
      JOIN transactions t ON t.id = c.transaction_id
      WHERE c.id = ${claim_id} AND c.agent_id = ${agent.agent_id} AND c.status = 'active'
    `;
    if (!claim) return errorResponse(404, 'Active claim not found');
    if (new Date(claim.expires_at) < new Date()) return errorResponse(410, 'Claim has expired. You can re-claim if eligible.');

    const sqlDirect = getDbDirect();
    try {
      await sqlDirect`BEGIN`;
      // Save proof
      await sqlDirect`
        INSERT INTO transfer_proofs (claim_id, transaction_id, agent_id, image_url, notes)
        VALUES (${claim_id}, ${claim.transaction_id}, ${agent.agent_id},
                ${sanitize(proof_url, 500)}, ${sanitize(notes ?? '')})
      `;
      // Mark claim complete
      await sqlDirect`
        UPDATE transfer_claims SET status='completed', admin_approved=TRUE WHERE id=${claim_id}
      `;
      // Mark transaction complete
      await sqlDirect`
        UPDATE transactions SET status='completed', completed_at=NOW() WHERE id=${claim.transaction_id}
      `;
      // Update agent stats
      const col = claim.direction === 'mc_to_nc' ? 'transfers_mc_to_nc' : 'transfers_nc_to_mc';
      await sqlDirect`
        UPDATE agents SET
          ${sqlDirect(col)} = ${sqlDirect(col)} + 1,
          total_amount_processed = total_amount_processed + ${claim.amount}
        WHERE id = ${agent.agent_id}
      `;
      await sqlDirect`COMMIT`;
      return response(200, { message: 'Transfer marked as complete. Well done!' });
    } catch (err) {
      await sqlDirect`ROLLBACK`;
      return errorResponse(500, 'Could not complete transfer. Please try again.');
    }
  }

  // ── MY STATS ────────────────────────────────────────────────
  if (req.method === 'GET' && resource === 'stats') {
    const [stats] = await sql`
      SELECT transfers_mc_to_nc, transfers_nc_to_mc, total_amount_processed,
             created_at, last_seen_at
      FROM agents WHERE id = ${agent.agent_id}
    `;
    const [session] = await sql`
      SELECT online_since FROM agent_sessions
      WHERE agent_id = ${agent.agent_id} AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1
    `;
    return response(200, { stats: { ...stats, online_since: session?.online_since } });
  }

  // ── MY HISTORY ──────────────────────────────────────────────
  if (req.method === 'GET' && resource === 'history') {
    const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100);
    const offset = parseInt(url.searchParams.get('offset') ?? '0');
    const history = await sql`
      SELECT c.id, c.claimed_at, c.status, c.attempt_number,
             t.amount, t.currency, t.direction, t.recipient_phone, t.recipient_name,
             p.full_name AS sender_name,
             pr.image_url AS proof_url
      FROM transfer_claims c
      JOIN transactions t ON t.id = c.transaction_id
      JOIN profiles p ON p.id = t.sender_id
      LEFT JOIN transfer_proofs pr ON pr.claim_id = c.id
      WHERE c.agent_id = ${agent.agent_id}
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return response(200, { history });
  }

  // ── UPLOAD PROOF IMAGE ──────────────────────────────────────
  if (req.method === 'POST' && resource === 'upload-proof') {
    const body = await parseBody(req);
    const { image_data, mime_type } = body ?? {};
    if (!image_data || !mime_type) return errorResponse(400, 'image_data and mime_type required');
    if (!mime_type.startsWith('image/')) return errorResponse(400, 'File must be an image');
    try {
      const store  = getStore('transfer-proofs');
      const fileId = `proof-${agent.agent_id}-${Date.now()}`;
      const buffer = Buffer.from(image_data, 'base64');
      if (buffer.length > 10 * 1024 * 1024) return errorResponse(400, 'Image too large (max 10MB)');
      await store.set(fileId, buffer, { metadata: { contentType: mime_type } });
      return response(200, { url: `/.netlify/blobs/${fileId}`, file_id: fileId });
    } catch (err) {
      console.error('Blob upload error:', err.message);
      return errorResponse(500, 'Image upload failed. Please try again.');
    }
  }

  return errorResponse(404, 'Unknown agent resource');
};

export const config = { path: '/api/agent/:resource*' };
