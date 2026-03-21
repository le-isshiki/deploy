// v2 — rebuilt 2026-03-20
// netlify/functions/auth.js
// POST /api/auth/signup  — register new user
// POST /api/auth/login   — returns session token
// POST /api/auth/logout  — invalidates session

import { getDb, response, errorResponse, isRateLimited } from './_utils/db.js';
import bcrypt from 'bcryptjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s\-().]{8,20}$/;

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});
  if (req.method !== 'POST')    return errorResponse(405, 'Method not allowed');

  const url    = new URL(req.url);
  const action = url.pathname.split('/').pop();
  const ip     = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  let body;
  try { body = await req.json(); }
  catch { return errorResponse(400, 'Invalid JSON body'); }

  const sql = getDb();

  // ── SIGN UP ──────────────────────────────────────────────────
  if (action === 'signup') {
    // Rate limit: 5 signups per IP per hour
    if (await isRateLimited(sql, `signup:${ip}`, 5, 60))
      return errorResponse(429, 'Too many signup attempts. Please try again later.');

    const { email, password, full_name, phone } = body;

    if (!email    || !EMAIL_RE.test(email.trim()))  return errorResponse(400, 'Please enter a valid email address');
    if (!password || password.length < 8)            return errorResponse(400, 'Password must be at least 8 characters');
    if (!full_name|| full_name.trim().length < 2)    return errorResponse(400, 'Please enter your full name');
    if (phone && !PHONE_RE.test(phone.trim()))       return errorResponse(400, 'Please enter a valid phone number');

    const passwordHash = await bcrypt.hash(password, 12);

    try {
      const [user] = await sql`
        INSERT INTO profiles (email, password_hash, full_name, phone)
        VALUES (
          ${email.trim().toLowerCase()},
          ${passwordHash},
          ${full_name.trim()},
          ${phone?.trim() ?? null}
        )
        RETURNING id, email, full_name
      `;
      await sql`
        INSERT INTO wallets (user_id, currency, balance)
        VALUES (${user.id}, 'HTG', 0.00)
        ON CONFLICT (user_id, currency) DO NOTHING
      `;
      return response(201, {
        message: 'Account created successfully.',
        user: { id: user.id, email: user.email, full_name: user.full_name },
      });
    } catch (err) {
      if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
        return errorResponse(409, 'An account with this email or phone already exists');
      }
      console.error('Signup error:', err.message);
      return errorResponse(500, 'Account creation failed. Please try again.');
    }
  }

  // ── LOGIN ────────────────────────────────────────────────────
  if (action === 'login') {
    // Rate limit: 10 attempts per IP per 15 min
    if (await isRateLimited(sql, `login:${ip}`, 10, 15))
      return errorResponse(429, 'Too many login attempts. Please wait 15 minutes.');

    const { email, password } = body;
    if (!email || !password) return errorResponse(400, 'Email and password are required');

    const [user] = await sql`
      SELECT id, email, full_name, password_hash
      FROM profiles
      WHERE email = ${email.trim().toLowerCase()}
    `;

    if (!user) {
      await bcrypt.compare(password, '$2b$12$invalidhashfortimingattackprotect0000000000000000000');
      return errorResponse(401, 'Invalid email or password');
    }

    // Support both bcryptjs ($2b$) and pgcrypto ($2a$) hashes
    let validPassword = false;
    try {
      validPassword = await bcrypt.compare(password, user.password_hash);
    } catch {
      try {
        const [row] = await sql`
          SELECT (password_hash = crypt(${password}, password_hash)) AS valid
          FROM profiles WHERE id = ${user.id}
        `;
        validPassword = row?.valid === true;
      } catch {
        validPassword = false;
      }
    }

    if (!validPassword) {
      return errorResponse(401, 'Invalid email or password');
    }

    // Clean up expired sessions
    await sql`DELETE FROM sessions WHERE user_id = ${user.id} AND expires_at < NOW()`.catch(() => {});

    // Create new session
    const [session] = await sql`
      INSERT INTO sessions (user_id)
      VALUES (${user.id})
      RETURNING token, expires_at
    `;

    return response(200, {
      access_token: session.token,
      expires_at:   session.expires_at,
      user: { id: user.id, email: user.email, full_name: user.full_name },
    });
  }

  // ── LOGOUT ───────────────────────────────────────────────────
  if (action === 'logout') {
    const token = req.headers.get('authorization')?.replace('Bearer ', '').trim();
    if (token) await sql`DELETE FROM sessions WHERE token = ${token}`.catch(() => {});
    return response(200, { message: 'Logged out successfully' });
  }

  return errorResponse(404, 'Unknown auth action');
};

export const config = { path: '/api/auth/:action' };
