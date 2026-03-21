// netlify/functions/_utils/db.js
import { neon } from '@neondatabase/serverless';

export function getDb() {
  const url = process.env.NETLIFY_DATABASE_URL;
  if (!url) throw new Error('Missing NETLIFY_DATABASE_URL');
  return neon(url);
}

// Unpooled connection — use for transactions (BEGIN/COMMIT)
export function getDbDirect() {
  const url = process.env.NETLIFY_DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('Missing NETLIFY_DATABASE_URL_UNPOOLED');
  return neon(url);
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token, x-agent-token',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

// Return proper Web Platform Response objects (required for Netlify Functions v2)
export function response(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status:  statusCode,
    headers: CORS,
  });
}

export function errorResponse(statusCode, message) {
  return response(statusCode, { error: message });
}

export function corsHeaders() {
  return CORS;
}

export async function getSession(req, sql) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim();
  if (!token) return null;
  const [s] = await sql`
    SELECT s.user_id, p.email, p.full_name, p.phone, p.country, p.kyc_status, p.avatar_url, p.created_at
    FROM sessions s
    JOIN profiles p ON p.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > NOW()
  `;
  return s ?? null;
}

export async function getUserId(req, sql) {
  const s = await getSession(req, sql);
  return s?.user_id ?? null;
}

export async function parseBody(req) {
  try { return await req.json(); } catch { return null; }
}

export function sanitize(str, max = 500) {
  if (!str) return '';
  return String(str).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

export async function isRateLimited(sql, key, limit = 10, windowMinutes = 15) {
  try {
    const [{ count }] = await sql`
      SELECT COUNT(*) FROM rate_limit_log
      WHERE key = ${key} AND created_at > NOW() - (${windowMinutes} || ' minutes')::INTERVAL
    `;
    if (parseInt(count) >= limit) return true;
    await sql`INSERT INTO rate_limit_log (key) VALUES (${key})`;
    await sql`DELETE FROM rate_limit_log WHERE created_at < NOW() - INTERVAL '1 hour'`;
    return false;
  } catch { return false; }
}

export async function auditLog(sql, performer, action, entityType, entityId, details, ip) {
  try {
    await sql`
      INSERT INTO admin_audit_log (performed_by, action, entity_type, entity_id, details, ip_address)
      VALUES (
        ${performer ?? 'system'},
        ${action},
        ${entityType ?? null},
        ${entityId ?? null},
        ${JSON.stringify(details ?? {})},
        ${ip ?? null}
      )
    `;
  } catch { /* never crash */ }
}
