// ONE-TIME MIGRATION FUNCTION — DELETE AFTER USE
import { neon } from '@neondatabase/serverless';

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('secret') !== 'sc_migrate_2026') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const sql = neon(process.env.NETLIFY_DATABASE_URL);
  const results = [];
  const errors = [];

  async function run(name, query) {
    try {
      await sql.unsafe(query);
      results.push(`✓ ${name}`);
    } catch (e) {
      errors.push(`✗ ${name}: ${e.message}`);
    }
  }

  await run('extensions', `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

  await run('profiles', `CREATE TABLE IF NOT EXISTS profiles (
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

  await run('sessions', `CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('wallets', `CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    currency TEXT NOT NULL DEFAULT 'HTG',
    balance NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, currency)
  )`);

  await run('transactions', `CREATE TABLE IF NOT EXISTS transactions (
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

  await run('deposit_requests', `CREATE TABLE IF NOT EXISTS deposit_requests (
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

  await run('withdrawal_requests', `CREATE TABLE IF NOT EXISTS withdrawal_requests (
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

  await run('deposit_receipts', `CREATE TABLE IF NOT EXISTS deposit_receipts (
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

  await run('admin_credentials', `CREATE TABLE IF NOT EXISTS admin_credentials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    failed_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('admin_sessions', `CREATE TABLE IF NOT EXISTS admin_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '8 hours',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('admin_audit_log', `CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    performed_by TEXT NOT NULL DEFAULT 'system',
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id UUID,
    details JSONB DEFAULT '{}',
    ip_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('rate_limit_log', `CREATE TABLE IF NOT EXISTS rate_limit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('agents', `CREATE TABLE IF NOT EXISTS agents (
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

  await run('agent_sessions', `CREATE TABLE IF NOT EXISTS agent_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
    ip_address TEXT,
    user_agent TEXT,
    online_since TIMESTAMPTZ DEFAULT NOW(),
    last_ping_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '12 hours',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('transfer_claims', `CREATE TABLE IF NOT EXISTS transfer_claims (
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

  await run('transfer_proofs', `CREATE TABLE IF NOT EXISTS transfer_proofs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id UUID NOT NULL REFERENCES transfer_claims(id),
    transaction_id UUID NOT NULL REFERENCES transactions(id),
    agent_id UUID NOT NULL REFERENCES agents(id),
    image_url TEXT NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await run('kyc_submissions', `CREATE TABLE IF NOT EXISTS kyc_submissions (
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

  await run('disputes', `CREATE TABLE IF NOT EXISTS disputes (
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

  await run('indexes', `
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
    CREATE INDEX IF NOT EXISTS idx_txn_sender ON transactions(sender_id);
    CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_txn_created ON transactions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_token ON agent_sessions(token);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_key ON rate_limit_log(key, created_at);
    CREATE INDEX IF NOT EXISTS idx_disputes_user ON disputes(user_id);
  `);

  await run('updated_at_trigger_fn', `
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
  `);

  await run('expire_claims_fn', `
    CREATE OR REPLACE FUNCTION expire_stale_claims() RETURNS void AS $$
    BEGIN
      UPDATE transfer_claims SET status = 'expired' WHERE status = 'active' AND expires_at < NOW();
      UPDATE transactions SET status = 'pending', current_claim_id = NULL
      WHERE status = 'processing' AND current_claim_id IN (
        SELECT id FROM transfer_claims WHERE status = 'expired'
      );
    END;
    $$ LANGUAGE plpgsql;
  `);

  await run('triggers', `
    DROP TRIGGER IF EXISTS profiles_updated_at ON profiles;
    CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    DROP TRIGGER IF EXISTS wallets_updated_at ON wallets;
    CREATE TRIGGER wallets_updated_at BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    DROP TRIGGER IF EXISTS agents_updated_at ON agents;
    CREATE TRIGGER agents_updated_at BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  await run('admin_account', `
    INSERT INTO admin_credentials (username, password_hash)
    VALUES ('switchcash_admin', crypt('KingKash001$$', gen_salt('bf', 12)))
    ON CONFLICT (username) DO UPDATE
      SET password_hash = crypt('KingKash001$$', gen_salt('bf', 12)), updated_at = NOW();
  `);

  // Final table list
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `;

  const allGood = errors.length === 0;

  return new Response(JSON.stringify({
    status: allGood ? '✅ MIGRATION COMPLETE' : '⚠️ MIGRATION WITH ERRORS',
    success: results,
    errors: errors,
    tables_created: tables.map(t => t.table_name),
  }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

export const config = { path: '/api/migrate' };
