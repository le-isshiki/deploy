// v3 — added username + lookup endpoint
import { getDb, getSession, response, errorResponse, sanitize } from './_utils/db.js';

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});

  const sql      = getDb();
  const url      = new URL(req.url);
  const segments = url.pathname.replace('/api/user', '').split('/').filter(Boolean);
  const resource = segments[0];

  // ── LOOKUP (no auth — just search by username or phone) ──────
  // GET /api/user/lookup?q=@username OR +50912345678
  if (req.method === 'GET' && resource === 'lookup') {
    const q = url.searchParams.get('q')?.trim();
    if (!q || q.length < 2) return errorResponse(400, 'Query too short');

    // Ensure username column exists
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS username TEXT`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_idx ON profiles (username) WHERE username IS NOT NULL`;

    const clean = q.startsWith('@') ? q.slice(1).toLowerCase() : q;

    // Search by username or phone
    const [user] = await sql`
      SELECT id, full_name, username, phone
      FROM profiles
      WHERE (LOWER(username) = ${clean} OR phone = ${clean})
        AND is_suspended = FALSE
      LIMIT 1
    `;

    if (!user) return response(200, { user: null });
    return response(200, {
      user: { id: user.id, full_name: user.full_name, username: user.username, phone: user.phone }
    });
  }

  // Auth required below
  const session = await getSession(req, sql);
  if (!session) return errorResponse(401, 'Invalid or expired token. Please log in again.');

  // ── GET PROFILE ─────────────────────────────────────────────
  if (req.method === 'GET' && !resource) {
    // Ensure username column exists
    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS username TEXT`;
    const [profile] = await sql`
      SELECT id, email, full_name, phone, country, avatar_url, kyc_status, username, created_at
      FROM profiles WHERE id = ${session.user_id}
    `;
    return response(200, { user: { ...session, ...profile } });
  }

  // ── UPDATE PROFILE ──────────────────────────────────────────
  if (req.method === 'PUT' && !resource) {
    let body;
    try { body = await req.json(); }
    catch { return errorResponse(400, 'Invalid JSON body'); }

    const PHONE_RE    = /^\+?[\d\s\-().]{8,20}$/;
    const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
    const allowed     = ['full_name', 'phone', 'country', 'avatar_url', 'username'];
    const updates     = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));

    if (updates.phone && !PHONE_RE.test(updates.phone))
      return errorResponse(400, 'Please enter a valid phone number');
    if (updates.full_name && updates.full_name.trim().length < 2)
      return errorResponse(400, 'Name must be at least 2 characters');
    if (updates.username) {
      const uname = updates.username.toLowerCase().trim();
      if (!USERNAME_RE.test(uname))
        return errorResponse(400, 'Username must be 3-20 characters: letters, numbers, underscores only');
      // Check uniqueness
      const [taken] = await sql`SELECT id FROM profiles WHERE LOWER(username)=${uname} AND id != ${session.user_id}`;
      if (taken) return errorResponse(409, 'Username already taken');
      updates.username = uname;
    }

    await sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS username TEXT`;
    const [updated] = await sql`
      UPDATE profiles SET
        full_name  = COALESCE(${updates.full_name?.trim()  ?? null}, full_name),
        phone      = COALESCE(${updates.phone?.trim()      ?? null}, phone),
        country    = COALESCE(${updates.country            ?? null}, country),
        avatar_url = COALESCE(${updates.avatar_url         ?? null}, avatar_url),
        username   = COALESCE(${updates.username           ?? null}, username)
      WHERE id = ${session.user_id}
      RETURNING id, email, full_name, phone, country, avatar_url, kyc_status, username
    `;
    return response(200, { user: updated });
  }

  return errorResponse(405, 'Method not allowed');
};

export const config = { path: '/api/user/:resource*' };
