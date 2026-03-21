// netlify/functions/admin.js
import { getDb, getDbDirect, response, errorResponse, isRateLimited, auditLog, parseBody, sanitize } from './_utils/db.js';
import { sendDepositConfirmedEmail, sendWithdrawalEmail } from './_utils/email.js';
import bcrypt from 'bcryptjs';

async function verifyAdminSession(req, sql) {
  const token = req.headers.get('x-admin-token');
  if (!token) return null;
  const [session] = await sql`SELECT token FROM admin_sessions WHERE token = ${token} AND expires_at > NOW()`;
  return session ? token : null;
}

async function getAdminUsername(token, sql) {
  if (!token) return 'admin';
  const [row] = await sql`SELECT username FROM admin_credentials LIMIT 1`;
  return row?.username ?? 'admin';
}

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});

  const url      = new URL(req.url);
  const segments = url.pathname.replace('/api/admin', '').split('/').filter(Boolean);
  const resource = segments[0];
  const subId    = segments[1];
  const sql      = getDb();
  const ip       = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  // ── LOGIN ──────────────────────────────────────────────────
  if (req.method === 'POST' && resource === 'login') {
    if (await isRateLimited(sql, `admin-login:${ip}`, 5, 15))
      return errorResponse(429, 'Too many login attempts. Wait 15 minutes.');
    const body = await parseBody(req);
    if (!body) return errorResponse(400, 'Invalid request');
    const { username, password } = body;
    if (!username || !password) return errorResponse(400, 'Username and password required');

    const [admin] = await sql`
      SELECT id, username, failed_attempts, locked_until,
             (password_hash = crypt(${password}, password_hash)) AS valid
      FROM admin_credentials WHERE username = ${sanitize(username)}
    `;
    if (admin?.locked_until && new Date(admin.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(admin.locked_until) - Date.now()) / 60000);
      return errorResponse(423, `Locked. Try again in ${mins} min.`);
    }
    if (!admin?.valid) {
      if (admin) {
        const attempts  = (admin.failed_attempts || 0) + 1;
        const lockUntil = attempts >= 5 ? new Date(Date.now() + 15*60*1000).toISOString() : null;
        await sql`UPDATE admin_credentials SET failed_attempts=${attempts}, locked_until=${lockUntil} WHERE id=${admin.id}`;
      }
      await new Promise(r => setTimeout(r, 800));
      return errorResponse(401, 'Invalid username or password');
    }
    await sql`UPDATE admin_credentials SET failed_attempts=0, locked_until=NULL WHERE id=${admin.id}`;
    await sql`DELETE FROM admin_sessions WHERE expires_at < NOW()`;
    const [session] = await sql`
      INSERT INTO admin_sessions (expires_at)
      VALUES (NOW() + INTERVAL '8 hours')
      RETURNING token, expires_at
    `;
    await auditLog(sql, admin.username, 'login', null, null, {}, ip);
    return response(200, { token: session.token, expires_at: session.expires_at, username: admin.username });
  }

  // ── LOGOUT ─────────────────────────────────────────────────
  if (req.method === 'POST' && resource === 'logout') {
    const token = req.headers.get('x-admin-token');
    if (token) {
      await sql`DELETE FROM admin_sessions WHERE token = ${token}`;
      await auditLog(sql, 'admin', 'logout', null, null, {}, ip);
    }
    return response(200, { message: 'Logged out' });
  }

  // Require auth for everything below
  const sessionToken = await verifyAdminSession(req, sql);
  if (!sessionToken) return errorResponse(401, 'Admin session expired. Please log in again.');
  const adminUser = await getAdminUsername(sessionToken, sql);

  // ── STATS ──────────────────────────────────────────────────
  if (req.method === 'GET' && resource === 'stats') {
    const [users]       = await sql`SELECT COUNT(*) AS count FROM profiles`;
    const [txns]        = await sql`SELECT COUNT(*) AS count FROM transactions WHERE status='completed'`;
    const [volume]      = await sql`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE status='completed' AND type='send'`;
    const [pending]     = await sql`SELECT COUNT(*) AS count FROM transactions WHERE status IN ('pending','submitted','processing')`;
    const [newUsers]    = await sql`SELECT COUNT(*) AS count FROM profiles WHERE created_at >= NOW() - INTERVAL '7 days'`;
    const [newTxns]     = await sql`SELECT COUNT(*) AS count FROM transactions WHERE created_at >= NOW() - INTERVAL '7 days' AND status='completed'`;
    const [volWeek]     = await sql`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE created_at >= NOW() - INTERVAL '7 days' AND status='completed' AND type='send'`;
    const [deposits]    = await sql`SELECT COUNT(*) AS count FROM deposit_requests WHERE status='pending'`;
    const [withdrawals] = await sql`SELECT COUNT(*) AS count FROM withdrawal_requests WHERE status='pending'`;
    // Recent activity for overview feed
    const signups   = await sql`SELECT 'New signup: ' || COALESCE(full_name, email) AS event, created_at FROM profiles ORDER BY created_at DESC LIMIT 5`;
    const transfers = await sql`SELECT 'Transfer: ' || amount || ' HTG (' || COALESCE(direction,'send') || ')' AS event, created_at FROM transactions WHERE type='send' AND status='completed' ORDER BY created_at DESC LIMIT 5`;
    const recent = [...signups, ...transfers].sort((a,b) => new Date(b.created_at)-new Date(a.created_at)).slice(0,10);
    return response(200, {
      stats: {
        total_users:        parseInt(users.count),
        total_txns:         parseInt(txns.count),
        total_volume:       parseFloat(volume.total),
        flagged_txns:       parseInt(pending.count),
        new_users_week:     parseInt(newUsers.count),
        new_txns_week:      parseInt(newTxns.count),
        vol_week:           parseFloat(volWeek.total),
        pending_deposits:   parseInt(deposits.count),
        pending_withdrawals: parseInt(withdrawals.count),
      },
      recent_activity: recent,
    });
  }

  // ── USERS LIST ─────────────────────────────────────────────
  if (req.method === 'GET' && resource === 'users' && !subId) {
    const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200);
    const offset = parseInt(url.searchParams.get('offset') ?? '0');
    const search = url.searchParams.get('search') ?? '';
    const users = search
      ? await sql`
          SELECT p.id, p.email, p.full_name, p.phone, p.country, p.kyc_status,
                 p.created_at, p.is_suspended, p.email_verified,
                 COALESCE(w.balance, 0) AS balance, COUNT(DISTINCT t.id) AS transfer_count
          FROM profiles p
          LEFT JOIN wallets w      ON w.user_id = p.id AND w.currency = 'HTG'
          LEFT JOIN transactions t ON t.sender_id = p.id OR t.receiver_id = p.id
          WHERE (p.email ILIKE ${'%'+search+'%'} OR p.full_name ILIKE ${'%'+search+'%'} OR p.phone ILIKE ${'%'+search+'%'})
          GROUP BY p.id, w.balance
          ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${offset}`
      : await sql`
          SELECT p.id, p.email, p.full_name, p.phone, p.country, p.kyc_status,
                 p.created_at, p.is_suspended, p.email_verified,
                 COALESCE(w.balance, 0) AS balance, COUNT(DISTINCT t.id) AS transfer_count
          FROM profiles p
          LEFT JOIN wallets w      ON w.user_id = p.id AND w.currency = 'HTG'
          LEFT JOIN transactions t ON t.sender_id = p.id OR t.receiver_id = p.id
          GROUP BY p.id, w.balance
          ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const [{ count }] = await sql`SELECT COUNT(*) FROM profiles`;
    return response(200, { users, total: parseInt(count) });
  }

  // ── UPDATE USER (KYC / suspend) ────────────────────────────
  if (req.method === 'PUT' && resource === 'users' && subId) {
    const body = await parseBody(req);
    if (!body) return errorResponse(400, 'Invalid request');
    const updates = {};
    if (body.kyc_status !== undefined) {
      if (!['pending','verified','rejected','submitted'].includes(body.kyc_status)) return errorResponse(400, 'Invalid KYC status');
      updates.kyc_status = body.kyc_status;
    }
    // admin.html sends status:'suspended'/'active' — map to is_suspended
    if (body.status !== undefined) updates.is_suspended = body.status === 'suspended';
    if (body.is_suspended !== undefined) updates.is_suspended = !!body.is_suspended;
    if (body.suspension_reason !== undefined) updates.suspension_reason = sanitize(body.suspension_reason);
    // full_name and phone updates from admin.html
    if (body.full_name !== undefined) updates.full_name = sanitize(body.full_name);
    if (body.phone !== undefined)     updates.phone = sanitize(body.phone);
    const [updated] = await sql`
      UPDATE profiles SET
        kyc_status        = COALESCE(${updates.kyc_status   ?? null}, kyc_status),
        is_suspended      = COALESCE(${updates.is_suspended ?? null}, is_suspended),
        suspension_reason = COALESCE(${updates.suspension_reason ?? null}, suspension_reason),
        full_name         = COALESCE(${updates.full_name ?? null}, full_name),
        phone             = COALESCE(${updates.phone     ?? null}, phone)
      WHERE id = ${subId} RETURNING id, email, full_name, phone, kyc_status, is_suspended
    `;
    if (!updated) return errorResponse(404, 'User not found');
    await auditLog(sql, adminUser, 'update_user', 'profile', subId, updates, ip);
    return response(200, { user: updated });
  }

  // ── CREATE USER ────────────────────────────────────────────
  if (req.method === 'POST' && resource === 'users') {
    const body = await parseBody(req);
    if (!body) return errorResponse(400, 'Invalid request');
    const { full_name, email, phone, status } = body;
    if (!full_name || !email) return errorResponse(400, 'full_name and email required');
    const is_suspended = status === 'suspended';
    // Generate a random temp password hash
    const tempHash = await bcrypt.hash('TempPass' + Date.now(), 10);
    try {
      const [user] = await sql`
        INSERT INTO profiles (email, password_hash, full_name, phone, is_suspended)
        VALUES (${sanitize(email).toLowerCase()}, ${tempHash}, ${sanitize(full_name)},
                ${phone ? sanitize(phone) : null}, ${is_suspended})
        RETURNING id, email, full_name
      `;
      await sql`INSERT INTO wallets (user_id, currency, balance) VALUES (${user.id}, 'HTG', 0.00) ON CONFLICT DO NOTHING`;
      await auditLog(sql, adminUser, 'create_user', 'profile', user.id, { email: user.email }, ip);
      return response(201, { user, message: 'User created. They will need to reset their password.' });
    } catch(err) {
      if (err.message?.includes('unique')) return errorResponse(409, 'Email already exists');
      return errorResponse(500, 'Could not create user: ' + err.message);
    }
  }

  // ── CREDIT WALLET ──────────────────────────────────────────
  if (req.method === 'POST' && resource === 'credit') {
    const body   = await parseBody(req);
    const amount = parseFloat(body?.amount);
    const note   = sanitize(body?.note ?? '');
    if (!amount || isNaN(amount) || amount <= 0 || amount > 500000) return errorResponse(400, 'Invalid amount');
    const [wallet] = await sql`
      UPDATE wallets SET balance = balance + ${amount}
      WHERE user_id = ${subId} AND currency = 'HTG' RETURNING balance
    `;
    if (!wallet) return errorResponse(404, 'Wallet not found');
    await sql`
      INSERT INTO transactions (receiver_id, wallet_id, type, amount, currency, status, description, completed_at)
      SELECT ${subId}, w.id, 'deposit', ${amount}, 'HTG', 'completed', ${'Admin credit: '+(note||'Manual deposit')}, NOW()
      FROM wallets w WHERE w.user_id = ${subId} AND w.currency = 'HTG'
    `;
    await auditLog(sql, adminUser, 'credit_wallet', 'wallet', subId, { amount, note }, ip);
    return response(200, { message: `Credited ${amount} HTG`, new_balance: parseFloat(wallet.balance) });
  }

  // ── DEBIT WALLET ───────────────────────────────────────────
  if (req.method === 'POST' && resource === 'debit') {
    const body   = await parseBody(req);
    const amount = parseFloat(body?.amount);
    const note   = sanitize(body?.note ?? '');
    if (!amount || isNaN(amount) || amount <= 0) return errorResponse(400, 'Invalid amount');
    const [wallet] = await sql`
      UPDATE wallets SET balance = balance - ${amount}
      WHERE user_id = ${subId} AND currency = 'HTG' AND balance >= ${amount}
      RETURNING balance
    `;
    if (!wallet) return errorResponse(400, 'Insufficient balance or wallet not found');
    await sql`
      INSERT INTO transactions (sender_id, wallet_id, type, amount, currency, status, description, completed_at)
      SELECT ${subId}, w.id, 'withdrawal', ${amount}, 'HTG', 'completed', ${'Admin debit: '+(note||'Manual debit')}, NOW()
      FROM wallets w WHERE w.user_id = ${subId} AND w.currency = 'HTG'
    `;
    await auditLog(sql, adminUser, 'debit_wallet', 'wallet', subId, { amount, note }, ip);
    return response(200, { message: `Debited ${amount} HTG`, new_balance: parseFloat(wallet.balance) });
  }

  // ── TRANSACTIONS ───────────────────────────────────────────
  if (req.method === 'GET' && resource === 'transactions') {
    const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200);
    const offset = parseInt(url.searchParams.get('offset') ?? '0');
    const search = url.searchParams.get('search') ?? '';
    const status = url.searchParams.get('status') ?? '';
    let transactions;
    if (search && status) {
      transactions = await sql`
        SELECT t.*, s.email AS sender_email, s.full_name AS sender_name,
               r.email AS receiver_email, r.full_name AS receiver_name
        FROM transactions t LEFT JOIN profiles s ON s.id = t.sender_id LEFT JOIN profiles r ON r.id = t.receiver_id
        WHERE (s.email ILIKE ${'%'+search+'%'} OR t.reference ILIKE ${'%'+search+'%'}) AND t.status = ${status}
        ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    } else if (search) {
      transactions = await sql`
        SELECT t.*, s.email AS sender_email, s.full_name AS sender_name,
               r.email AS receiver_email, r.full_name AS receiver_name
        FROM transactions t LEFT JOIN profiles s ON s.id = t.sender_id LEFT JOIN profiles r ON r.id = t.receiver_id
        WHERE (s.email ILIKE ${'%'+search+'%'} OR t.reference ILIKE ${'%'+search+'%'})
        ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    } else if (status) {
      transactions = await sql`
        SELECT t.*, s.email AS sender_email, s.full_name AS sender_name,
               r.email AS receiver_email, r.full_name AS receiver_name
        FROM transactions t LEFT JOIN profiles s ON s.id = t.sender_id LEFT JOIN profiles r ON r.id = t.receiver_id
        WHERE t.status = ${status}
        ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    } else {
      transactions = await sql`
        SELECT t.*, s.email AS sender_email, s.full_name AS sender_name,
               r.email AS receiver_email, r.full_name AS receiver_name
        FROM transactions t LEFT JOIN profiles s ON s.id = t.sender_id LEFT JOIN profiles r ON r.id = t.receiver_id
        ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    }
    const [{ count }] = await sql`SELECT COUNT(*) FROM transactions`;
    return response(200, { transactions, total: parseInt(count) });
  }

  // ── DEPOSITS ───────────────────────────────────────────────
  if (req.method === 'GET' && resource === 'deposits') {
    const status = url.searchParams.get('status') ?? 'pending';
    const deposits = status !== 'all'
      ? await sql`SELECT d.*, p.email, p.full_name, p.phone FROM deposit_requests d JOIN profiles p ON p.id = d.user_id WHERE d.status = ${status} ORDER BY d.created_at DESC LIMIT 100`
      : await sql`SELECT d.*, p.email, p.full_name, p.phone FROM deposit_requests d JOIN profiles p ON p.id = d.user_id ORDER BY d.created_at DESC LIMIT 100`;
    return response(200, { deposits });
  }

  if (req.method === 'PUT' && resource === 'deposits' && subId) {
    const body   = await parseBody(req);
    const status = body?.status;
    const notes  = sanitize(body?.notes ?? '');
    if (!['confirmed','rejected'].includes(status)) return errorResponse(400, 'Status must be confirmed or rejected');
    const [deposit] = await sql`
      UPDATE deposit_requests SET status=${status}, notes=${notes}, confirmed_by=${adminUser}, confirmed_at=NOW()
      WHERE id=${subId} AND status='pending' RETURNING *
    `;
    if (!deposit) return errorResponse(404, 'Not found or already processed');
    if (status === 'confirmed') {
      await sql`UPDATE wallets SET balance=balance+${deposit.amount} WHERE user_id=${deposit.user_id} AND currency=${deposit.currency}`;
      await sql`
        INSERT INTO transactions (receiver_id, wallet_id, type, amount, currency, status, description, completed_at)
        SELECT ${deposit.user_id}, w.id, 'deposit', ${deposit.amount}, ${deposit.currency}, 'completed',
               ${'Deposit confirmed — ref: '+(deposit.reference||'N/A')}, NOW()
        FROM wallets w WHERE w.user_id=${deposit.user_id} AND w.currency=${deposit.currency}
      `;
      sql`SELECT email, full_name FROM profiles WHERE id=${deposit.user_id}`.then(([p]) => {
        if (p) sendDepositConfirmedEmail(p.email, p.full_name, deposit.amount).catch(() => {});
      }).catch(() => {});
    }
    await auditLog(sql, adminUser, `deposit_${status}`, 'deposit', subId, { amount: deposit.amount, notes }, ip);
    return response(200, { deposit });
  }

  // ── WITHDRAWALS ────────────────────────────────────────────
  if (req.method === 'GET' && resource === 'withdrawals') {
    const status = url.searchParams.get('status') ?? 'pending';
    const withdrawals = status !== 'all'
      ? await sql`SELECT w.*, p.email, p.full_name FROM withdrawal_requests w JOIN profiles p ON p.id = w.user_id WHERE w.status = ${status} ORDER BY w.created_at DESC LIMIT 100`
      : await sql`SELECT w.*, p.email, p.full_name FROM withdrawal_requests w JOIN profiles p ON p.id = w.user_id ORDER BY w.created_at DESC LIMIT 100`;
    return response(200, { withdrawals });
  }

  if (req.method === 'PUT' && resource === 'withdrawals' && subId) {
    const body   = await parseBody(req);
    const status = body?.status;
    const notes  = sanitize(body?.notes ?? '');
    if (!['processing','completed','rejected'].includes(status)) return errorResponse(400, 'Invalid status');
    const [withdrawal] = await sql`
      UPDATE withdrawal_requests SET status=${status}, notes=${notes}, processed_by=${adminUser}, processed_at=NOW()
      WHERE id=${subId} RETURNING *
    `;
    if (!withdrawal) return errorResponse(404, 'Not found');
    if (status === 'rejected' && withdrawal.status !== 'rejected') {
      await sql`UPDATE wallets SET balance=balance+${withdrawal.amount} WHERE user_id=${withdrawal.user_id} AND currency=${withdrawal.currency}`;
    }
    sql`SELECT email, full_name FROM profiles WHERE id=${withdrawal.user_id}`.then(([p]) => {
      if (p) sendWithdrawalEmail(p.email, p.full_name, withdrawal.amount, withdrawal.to_wallet, withdrawal.phone_number).catch(() => {});
    }).catch(() => {});
    await auditLog(sql, adminUser, `withdrawal_${status}`, 'withdrawal', subId, { amount: withdrawal.amount, notes }, ip);
    return response(200, { withdrawal });
  }

  // ── ACTIVITY ───────────────────────────────────────────────
  if (req.method === 'GET' && resource === 'activity') {
    const signups   = await sql`SELECT 'signup' AS type, email, full_name, created_at AS time FROM profiles ORDER BY created_at DESC LIMIT 10`;
    const transfers = await sql`
      SELECT 'transfer' AS type, s.email, t.amount, t.currency, t.status, t.created_at AS time
      FROM transactions t JOIN profiles s ON s.id = t.sender_id WHERE t.type='send'
      ORDER BY t.created_at DESC LIMIT 10
    `;
    const all = [...signups, ...transfers].sort((a,b) => new Date(b.time)-new Date(a.time)).slice(0,20);
    return response(200, { activity: all });
  }

  // ── AUDIT LOG ──────────────────────────────────────────────
  if (req.method === 'GET' && resource === 'audit-log') {
    const logs = await sql`SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 200`;
    return response(200, { logs });
  }

  // ── AGENTS LIST ────────────────────────────────────────────
  if (req.method === 'GET' && resource === 'agents' && !subId) {
    await sql`SELECT expire_stale_claims()`;
    const agents = await sql`
      SELECT a.id, a.email, a.full_name, a.phone,
             a.moncash_phone, a.natcash_phone,
             a.is_active, a.is_suspended, a.suspension_reason,
             a.transfers_mc_to_nc, a.transfers_nc_to_mc,
             a.total_amount_processed, a.last_seen_at, a.created_at,
             (SELECT last_ping_at FROM agent_sessions s
              WHERE s.agent_id = a.id AND s.expires_at > NOW()
              ORDER BY last_ping_at DESC LIMIT 1) AS last_ping,
             (SELECT online_since FROM agent_sessions s
              WHERE s.agent_id = a.id AND s.expires_at > NOW()
              ORDER BY last_ping_at DESC LIMIT 1) AS online_since
      FROM agents a
      ORDER BY a.created_at DESC
    `;
    const now = Date.now();
    const result = agents.map(a => ({
      ...a,
      is_online: a.last_ping ? (now - new Date(a.last_ping).getTime()) < 90000 : false,
    }));
    return response(200, { agents: result });
  }

  // ── CREATE AGENT ───────────────────────────────────────────
  if (req.method === 'POST' && resource === 'agents') {
    const body = await parseBody(req);
    const { email, full_name, phone, password, moncash_phone, natcash_phone } = body ?? {};
    if (!email || !full_name || !password) return errorResponse(400, 'email, full_name, password required');
    if (password.length < 8) return errorResponse(400, 'Password must be at least 8 characters');
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      const [agent] = await sql`
        INSERT INTO agents (email, full_name, phone, password_hash, moncash_phone, natcash_phone)
        VALUES (
          ${sanitize(email).toLowerCase()}, ${sanitize(full_name)},
          ${phone ? sanitize(phone) : null}, ${passwordHash},
          ${moncash_phone ? sanitize(moncash_phone) : null},
          ${natcash_phone ? sanitize(natcash_phone) : null}
        )
        RETURNING id, email, full_name
      `;
      await auditLog(sql, adminUser, 'create_agent', 'agent', agent.id, { email: agent.email }, ip);
      return response(201, { agent });
    } catch (err) {
      if (err.message?.includes('unique')) return errorResponse(409, 'An agent with this email already exists');
      return errorResponse(500, 'Could not create agent');
    }
  }

  // ── UPDATE AGENT ───────────────────────────────────────────
  if (req.method === 'PUT' && resource === 'agents' && subId) {
    const body = await parseBody(req);
    if (!body) return errorResponse(400, 'Invalid request');
    const updates = {};
    if (body.is_suspended !== undefined)      updates.is_suspended = !!body.is_suspended;
    if (body.suspension_reason !== undefined) updates.suspension_reason = sanitize(body.suspension_reason);
    if (body.is_active !== undefined)         updates.is_active = !!body.is_active;
    if (body.moncash_phone !== undefined)     updates.moncash_phone = sanitize(body.moncash_phone);
    if (body.natcash_phone !== undefined)     updates.natcash_phone = sanitize(body.natcash_phone);
    if (body.password) {
      if (body.password.length < 8) return errorResponse(400, 'Password must be at least 8 characters');
      updates.password_hash = await bcrypt.hash(body.password, 12);
    }
    const [updated] = await sql`
      UPDATE agents SET
        is_suspended      = COALESCE(${updates.is_suspended      ?? null}, is_suspended),
        suspension_reason = COALESCE(${updates.suspension_reason ?? null}, suspension_reason),
        is_active         = COALESCE(${updates.is_active         ?? null}, is_active),
        moncash_phone     = COALESCE(${updates.moncash_phone     ?? null}, moncash_phone),
        natcash_phone     = COALESCE(${updates.natcash_phone     ?? null}, natcash_phone),
        password_hash     = COALESCE(${updates.password_hash     ?? null}, password_hash)
      WHERE id = ${subId}
      RETURNING id, email, full_name, is_active, is_suspended
    `;
    if (!updated) return errorResponse(404, 'Agent not found');
    if (updates.is_suspended) {
      await sql`DELETE FROM agent_sessions WHERE agent_id = ${subId}`;
    }
    await auditLog(sql, adminUser, 'update_agent', 'agent', subId, updates, ip);
    return response(200, { agent: updated });
  }

  // ── APPROVE BLOCKED CLAIM ──────────────────────────────────
  if (req.method === 'POST' && resource === 'approve-claim') {
    const body = await parseBody(req);
    const { transaction_id, agent_id } = body ?? {};
    if (!transaction_id || !agent_id) return errorResponse(400, 'transaction_id and agent_id required');
    const [claim] = await sql`
      UPDATE transfer_claims
      SET admin_approved = TRUE, approved_by = ${adminUser}, approved_at = NOW()
      WHERE id = (
        SELECT id FROM transfer_claims
        WHERE transaction_id = ${transaction_id}
          AND agent_id = ${agent_id}
          AND status = 'expired'
          AND admin_approved = FALSE
        ORDER BY created_at DESC
        LIMIT 1
      )
      RETURNING id
    `;
    if (!claim) return errorResponse(404, 'No blocked claim found for this agent/transfer');
    await auditLog(sql, adminUser, 'approve_claim', 'transfer_claim', claim.id, { transaction_id, agent_id }, ip);
    return response(200, { message: 'Agent approved to retry this transfer.' });
  }

  // ── BLOCKED CLAIMS ─────────────────────────────────────────
  if (req.method === 'GET' && resource === 'blocked-claims') {
    const blocked = await sql`
      SELECT t.id AS transaction_id, t.amount, t.currency, t.direction,
             t.recipient_phone, t.status AS transfer_status,
             a.id AS agent_id, a.full_name AS agent_name, a.email AS agent_email,
             MAX(c.created_at) AS last_attempt, COUNT(c.id) AS total_attempts
      FROM transfer_claims c
      JOIN transactions t ON t.id = c.transaction_id
      JOIN agents a ON a.id = c.agent_id
      WHERE c.status = 'expired' AND c.admin_approved = FALSE
      GROUP BY t.id, t.amount, t.currency, t.direction, t.recipient_phone, t.status,
               a.id, a.full_name, a.email
      HAVING COUNT(c.id) >= 2
      ORDER BY last_attempt DESC
    `;
    return response(200, { blocked });
  }

  // ── DEPOSIT RECEIPTS ───────────────────────────────────────
  if (req.method === 'GET' && resource === 'deposit-receipts') {
    const receipts = await sql`
      SELECT dr.*, p.full_name, p.phone, p.email
      FROM deposit_receipts dr
      JOIN profiles p ON p.id = dr.user_id
      ORDER BY dr.created_at DESC LIMIT 100
    `;
    return response(200, { receipts });
  }

  // ── CHANGE PASSWORD ────────────────────────────────────────
  if (req.method === 'POST' && resource === 'change-password') {
    const body = await parseBody(req);
    if (!body) return errorResponse(400, 'Invalid request');
    const { current_password, new_password } = body;
    if (!current_password || !new_password) return errorResponse(400, 'current_password and new_password required');
    if (new_password.length < 10) return errorResponse(400, 'New password must be at least 10 characters');

    const [admin] = await sql`
      SELECT id, username, (password_hash = crypt(${current_password}, password_hash)) AS valid
      FROM admin_credentials LIMIT 1
    `;
    if (!admin?.valid) return errorResponse(401, 'Current password is incorrect');

    const newHash = await bcrypt.hash(new_password, 12);
    await sql`UPDATE admin_credentials SET password_hash = crypt(${new_password}, gen_salt('bf', 12)) WHERE id = ${admin.id}`;

    // Invalidate all admin sessions — force re-login
    await sql`DELETE FROM admin_sessions`;

    await auditLog(sql, admin.username, 'change_password', 'admin_credentials', admin.id, {}, ip);
    return response(200, { message: 'Password changed. Please log in again.' });
  }

  return errorResponse(404, 'Unknown admin resource');
};

export const config = { path: '/api/admin/:resource*' };
