// TEMPORARY DIAGNOSTIC + FIX FUNCTION
// GET  /api/dbfix?secret=sc_migrate_2026         → diagnose
// GET  /api/dbfix?secret=sc_migrate_2026&run=fix → fix everything

import { neon } from '@neondatabase/serverless';

const SECRET = 'sc_migrate_2026';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

export default async (req) => {
  const url    = new URL(req.url);
  const secret = url.searchParams.get('secret');
  const run    = url.searchParams.get('run');

  if (secret !== SECRET) return json({ error: 'Unauthorized' }, 401);

  const dbUrl = process.env.NETLIFY_DATABASE_URL;
  if (!dbUrl) return json({ error: 'NETLIFY_DATABASE_URL is not set — env var missing!' }, 500);

  const sql = neon(dbUrl);

  // ── DIAGNOSE ────────────────────────────────────────────────
  if (run !== 'fix') {
    const results = { env_var_present: true, db_url_prefix: dbUrl.substring(0, 40) + '...' };

    try {
      const rows = await sql`SELECT extname FROM pg_extension ORDER BY extname`;
      results.extensions = rows.map(r => r.extname);
      results.has_pgcrypto  = results.extensions.includes('pgcrypto');
      results.has_uuid_ossp = results.extensions.includes('uuid-ossp');
    } catch(e) { results.extensions_error = e.message; }

    try {
      const rows = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name
      `;
      results.tables = rows.map(r => r.table_name);
      const required = ['profiles','sessions','wallets','transactions','agents',
        'agent_sessions','admin_credentials','admin_sessions','transfer_claims',
        'disputes','rate_limit_log','admin_audit_log','kyc_submissions','transfer_proofs'];
      results.missing_tables = required.filter(t => !results.tables.includes(t));
      results.all_tables_present = results.missing_tables.length === 0;
    } catch(e) { results.tables_error = e.message; }

    try {
      const rows = await sql`SELECT username, length(password_hash) as hash_len FROM admin_credentials`;
      results.admin_credentials = rows;
    } catch(e) { results.admin_credentials_error = e.message; }

    try {
      const rows = await sql`
        SELECT username, (password_hash = crypt('KingKash001$$', password_hash)) AS valid
        FROM admin_credentials WHERE username = 'switchcash_admin'
      `;
      results.admin_login_test = rows.length ? rows[0] : { found: false };
    } catch(e) { results.admin_login_error = e.message; }

    try {
      const [r] = await sql`SELECT COUNT(*) as count FROM profiles`;
      results.user_count = r.count;
    } catch(e) { results.user_count = 'error: ' + e.message; }

    try {
      const [r] = await sql`SELECT COUNT(*) as count FROM agents`;
      results.agent_count = r.count;
    } catch(e) { results.agent_count = 'error: ' + e.message; }

    return json(results);
  }

  // ── FIX ─────────────────────────────────────────────────────
  // @neondatabase/serverless neon() uses tagged template literals ONLY — no .unsafe()
  const log = [];
  const step = async (name, fn) => {
    try { await fn(); log.push({ step: name, status: 'ok' }); }
    catch(e) { log.push({ step: name, status: 'error', detail: e.message }); }
  };

  await step('pgcrypto',  () => sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await step('uuid-ossp', () => sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

  await step('profiles', () => sql`CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    phone TEXT UNIQUE,
    country TEXT DEFAULT 'HT',
    currency TEXT DEFAULT 'HTG',
    avatar_url TEXT,
    kyc_status TEXT DEFAULT 'pending',
    is_suspended BOOLEAN DEFAULT FALSE,
    suspension_reason TEXT,
    failed_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMPTZ,
    email_verified BOOLEAN DEFAULT FALSE,
    transfer_limit_htg NUMERIC(18,2) DEFAULT 5000.00,
    kyc_submission_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('sessions', () => sql`CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32),'hex'),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('wallets', () => sql`CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    currency TEXT NOT NULL DEFAULT 'HTG',
    balance NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, currency)
  )`);

  await step('transactions', () => sql`CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id UUID REFERENCES profiles(id),
    receiver_id UUID REFERENCES profiles(id),
    wallet_id UUID REFERENCES wallets(id),
    type TEXT NOT NULL,
    amount NUMERIC(18,2) NOT NULL,
    fee NUMERIC(18,2) DEFAULT 0.00,
    currency TEXT NOT NULL DEFAULT 'HTG',
    status TEXT NOT NULL DEFAULT 'pending',
    direction TEXT,
    recipient_phone TEXT,
    recipient_name TEXT,
    description TEXT,
    reference TEXT UNIQUE DEFAULT 'TXN-' || UPPER(SUBSTR(uuid_generate_v4()::TEXT,1,8)),
    metadata JSONB DEFAULT '{}',
    cancel_deadline TIMESTAMPTZ,
    visible_to_agents_at TIMESTAMPTZ,
    current_claim_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  )`);

  await step('deposit_requests', () => sql`CREATE TABLE IF NOT EXISTS deposit_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    amount NUMERIC(18,2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'HTG',
    from_wallet TEXT NOT NULL,
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    notes TEXT,
    confirmed_by TEXT,
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('withdrawal_requests', () => sql`CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    amount NUMERIC(18,2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'HTG',
    to_wallet TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    notes TEXT,
    processed_by TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('deposit_receipts', () => sql`CREATE TABLE IF NOT EXISTS deposit_receipts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    wallet_type TEXT NOT NULL,
    amount NUMERIC(18,2),
    reference TEXT,
    status TEXT DEFAULT 'pending',
    upload_method TEXT DEFAULT 'dashboard',
    notified_admin_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('admin_credentials', () => sql`CREATE TABLE IF NOT EXISTS admin_credentials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    failed_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('admin_sessions', () => sql`CREATE TABLE IF NOT EXISTS admin_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32),'hex'),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '8 hours',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('admin_audit_log', () => sql`CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    performed_by TEXT NOT NULL DEFAULT 'system',
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id UUID,
    details JSONB DEFAULT '{}',
    ip_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('rate_limit_log', () => sql`CREATE TABLE IF NOT EXISTS rate_limit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('agents', () => sql`CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    moncash_phone TEXT,
    natcash_phone TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    is_suspended BOOLEAN DEFAULT FALSE,
    suspension_reason TEXT,
    failed_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMPTZ,
    transfers_mc_to_nc INTEGER DEFAULT 0,
    transfers_nc_to_mc INTEGER DEFAULT 0,
    total_amount_processed NUMERIC(18,2) DEFAULT 0.00,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('agent_sessions', () => sql`CREATE TABLE IF NOT EXISTS agent_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32),'hex'),
    ip_address TEXT,
    user_agent TEXT,
    online_since TIMESTAMPTZ DEFAULT NOW(),
    last_ping_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '12 hours',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('transfer_claims', () => sql`CREATE TABLE IF NOT EXISTS transfer_claims (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active',
    attempt_number INTEGER DEFAULT 1,
    admin_approved BOOLEAN DEFAULT FALSE,
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '5 minutes',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('transfer_proofs', () => sql`CREATE TABLE IF NOT EXISTS transfer_proofs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id UUID NOT NULL REFERENCES transfer_claims(id),
    transaction_id UUID NOT NULL REFERENCES transactions(id),
    agent_id UUID NOT NULL REFERENCES agents(id),
    image_url TEXT NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('kyc_submissions', () => sql`CREATE TABLE IF NOT EXISTS kyc_submissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    id_type TEXT NOT NULL,
    id_number TEXT NOT NULL,
    full_name TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    address TEXT,
    front_image_url TEXT NOT NULL,
    back_image_url TEXT,
    selfie_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('disputes', () => sql`CREATE TABLE IF NOT EXISTS disputes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    transaction_id UUID NOT NULL REFERENCES transactions(id),
    reason TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    reference TEXT UNIQUE NOT NULL,
    admin_notes TEXT,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    refund_issued BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await step('fn_set_updated_at', () => sql`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql
  `);

  await step('fn_expire_claims', () => sql`
    CREATE OR REPLACE FUNCTION expire_stale_claims() RETURNS void AS $$
    BEGIN
      UPDATE transfer_claims SET status = 'expired'
      WHERE status = 'active' AND expires_at < NOW();
      UPDATE transactions SET status = 'pending', current_claim_id = NULL
      WHERE status = 'processing' AND current_claim_id IN (
        SELECT id FROM transfer_claims WHERE status = 'expired'
      );
    END;
    $$ LANGUAGE plpgsql
  `);

  await step('idx_sessions_token',   () => sql`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`);
  await step('idx_sessions_user',    () => sql`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);
  await step('idx_wallets_user',     () => sql`CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id)`);
  await step('idx_txn_status',       () => sql`CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(status)`);
  await step('idx_txn_created',      () => sql`CREATE INDEX IF NOT EXISTS idx_txn_created ON transactions(created_at DESC)`);
  await step('idx_agent_sess_token', () => sql`CREATE INDEX IF NOT EXISTS idx_agent_sess_token ON agent_sessions(token)`);
  await step('idx_admin_sess_token', () => sql`CREATE INDEX IF NOT EXISTS idx_admin_sess_token ON admin_sessions(token)`);
  await step('idx_rate_limit_key',   () => sql`CREATE INDEX IF NOT EXISTS idx_rate_limit_key ON rate_limit_log(key, created_at)`);
  await step('idx_disputes_user',    () => sql`CREATE INDEX IF NOT EXISTS idx_disputes_user ON disputes(user_id)`);

  await step('drop_trigger_profiles',   () => sql`DROP TRIGGER IF EXISTS profiles_updated_at ON profiles`);
  await step('create_trigger_profiles', () => sql`CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
  await step('drop_trigger_wallets',    () => sql`DROP TRIGGER IF EXISTS wallets_updated_at ON wallets`);
  await step('create_trigger_wallets',  () => sql`CREATE TRIGGER wallets_updated_at BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
  await step('drop_trigger_agents',     () => sql`DROP TRIGGER IF EXISTS agents_updated_at ON agents`);
  await step('create_trigger_agents',   () => sql`CREATE TRIGGER agents_updated_at BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);

  // Upsert admin account
  await step('admin_account', () => sql`
    INSERT INTO admin_credentials (username, password_hash)
    VALUES ('switchcash_admin', crypt('KingKash001$$', gen_salt('bf', 12)))
    ON CONFLICT (username) DO UPDATE
      SET password_hash   = crypt('KingKash001$$', gen_salt('bf', 12)),
          failed_attempts = 0,
          locked_until    = NULL,
          updated_at      = NOW()
  `);

  // Final verification
  let adminOk = false;
  let tables  = [];
  try {
    const rows = await sql`
      SELECT (password_hash = crypt('KingKash001$$', password_hash)) AS valid
      FROM admin_credentials WHERE username = 'switchcash_admin'
    `;
    adminOk = rows[0]?.valid === true;
  } catch(e) {}

  try {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `;
    tables = rows.map(r => r.table_name);
  } catch(e) {}

  const errors = log.filter(s => s.status === 'error');
  return json({
    status:            errors.length === 0 ? '✅ ALL DONE' : `⚠️ ${errors.length} errors`,
    admin_login_works: adminOk,
    table_count:       tables.length,
    tables,
    steps:             log,
  });
};

export const config = { path: '/api/dbfix' };
