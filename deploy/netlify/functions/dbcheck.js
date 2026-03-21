import { neon } from '@neondatabase/serverless';

export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('secret') !== 'sc_migrate_2026') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const sql = neon(process.env.NETLIFY_DATABASE_URL);

  // Check tables
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `;

  // Check admin credentials
  const admins = await sql`SELECT id, username, length(password_hash) as hash_len, created_at FROM admin_credentials`;

  // Check extensions
  const exts = await sql`SELECT extname FROM pg_extension ORDER BY extname`;

  // Test crypt directly
  let cryptTest = null;
  try {
    const [r] = await sql`SELECT (crypt('KingKash001$$', gen_salt('bf', 4)) IS NOT NULL) as works`;
    cryptTest = r.works;
  } catch(e) {
    cryptTest = 'ERROR: ' + e.message;
  }

  // Test admin login query exactly as auth.js does it
  let loginTest = null;
  try {
    const [r] = await sql`
      SELECT id, username, (password_hash = crypt('KingKash001$$', password_hash)) AS valid
      FROM admin_credentials WHERE username = 'switchcash_admin'
    `;
    loginTest = r ? { found: true, valid: r.valid, username: r.username } : { found: false };
  } catch(e) {
    loginTest = 'ERROR: ' + e.message;
  }

  return new Response(JSON.stringify({
    tables: tables.map(t => t.table_name),
    admin_credentials: admins,
    extensions: exts.map(e => e.extname),
    crypt_works: cryptTest,
    admin_login_test: loginTest,
  }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

export const config = { path: '/api/dbcheck' };
