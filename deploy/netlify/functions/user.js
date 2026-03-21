// v2 — rebuilt 2026-03-20
// netlify/functions/user.js
import { getDb, getSession, response, errorResponse } from './_utils/db.js';

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});

  const sql     = getDb();
  const session = await getSession(req, sql);
  if (!session) return errorResponse(401, 'Invalid or expired token. Please log in again.');

  if (req.method === 'GET') {
    return response(200, { user: session });
  }

  if (req.method === 'PUT') {
    let body;
    try { body = await req.json(); }
    catch { return errorResponse(400, 'Invalid JSON body'); }

    const PHONE_RE = /^\+?[\d\s\-().]{8,20}$/;
    const allowed  = ['full_name', 'phone', 'country', 'avatar_url'];
    const updates  = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));

    if (updates.phone && !PHONE_RE.test(updates.phone)) {
      return errorResponse(400, 'Please enter a valid phone number');
    }
    if (updates.full_name && updates.full_name.trim().length < 2) {
      return errorResponse(400, 'Name must be at least 2 characters');
    }

    const [updated] = await sql`
      UPDATE profiles SET
        full_name  = COALESCE(${updates.full_name?.trim()  ?? null}, full_name),
        phone      = COALESCE(${updates.phone?.trim()      ?? null}, phone),
        country    = COALESCE(${updates.country            ?? null}, country),
        avatar_url = COALESCE(${updates.avatar_url         ?? null}, avatar_url)
      WHERE id = ${session.user_id}
      RETURNING id, email, full_name, phone, country, avatar_url, kyc_status
    `;
    return response(200, { user: updated });
  }

  return errorResponse(405, 'Method not allowed');
};

export const config = { path: '/api/user' };
