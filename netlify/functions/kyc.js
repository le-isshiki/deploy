// v2 — rebuilt 2026-03-20
// netlify/functions/kyc.js
// POST /api/kyc/submit       — user submits KYC documents
// GET  /api/kyc/status       — user checks their KYC status
// GET  /api/kyc/list         — admin lists all submissions
// PUT  /api/kyc/:id/approve  — admin approves
// PUT  /api/kyc/:id/reject   — admin rejects

import { getDb, getSession, response, errorResponse, parseBody, sanitize } from './_utils/db.js';
import { getStore } from '@netlify/blobs';

// ── Upload image to Netlify Blobs ────────────────────────────
async function uploadImage(base64Data, mimeType, filename) {
  const store  = getStore('kyc-documents');
  const buffer = Buffer.from(base64Data, 'base64');
  const key    = `${Date.now()}-${filename}`;
  await store.set(key, buffer, { metadata: { contentType: mimeType } });
  // Return a reference key — actual URL served via blob store
  return `kyc-documents/${key}`;
}

// ── Admin auth helper ────────────────────────────────────────
async function verifyAdmin(req, sql) {
  const token = req.headers.get('x-admin-token');
  if (!token) return null;
  const [session] = await sql`
    SELECT token FROM admin_sessions
    WHERE token = ${token} AND expires_at > NOW()
  `;
  if (!session) return null;
  const [admin] = await sql`SELECT username FROM admin_credentials LIMIT 1`;
  return admin ? { username: admin.username } : { username: 'admin' };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return response(200, {});

  const url      = new URL(req.url);
  const segments = url.pathname.replace('/api/kyc', '').split('/').filter(Boolean);
  const resource = segments[0];
  const subId    = segments[1]; // e.g. /api/kyc/:id/approve
  const action   = segments[2]; // approve or reject
  const sql      = getDb();

  // ── USER: SUBMIT KYC ────────────────────────────────────────
  if (req.method === 'POST' && resource === 'submit') {
    const session = await getSession(req, sql);
    if (!session) return errorResponse(401, 'Not authenticated');

    // Check if already verified
    const [profile] = await sql`SELECT kyc_status FROM profiles WHERE id = ${session.user_id}`;
    if (profile?.kyc_status === 'verified') return errorResponse(400, 'Your identity is already verified.');
    if (profile?.kyc_status === 'submitted') return errorResponse(400, 'You already have a pending KYC submission. Please wait for review.');

    const body = await parseBody(req);
    if (!body) return errorResponse(400, 'Invalid request body');

    const {
      id_type, id_number, full_name, date_of_birth, address,
      front_image_base64, front_image_type, front_image_name,
      back_image_base64,  back_image_type,  back_image_name,
      selfie_base64,      selfie_type,      selfie_name,
    } = body;

    // Validate required fields
    if (!['cin','passport','drivers_license'].includes(id_type))
      return errorResponse(400, 'Invalid ID type');
    if (!id_number?.trim())    return errorResponse(400, 'ID number is required');
    if (!full_name?.trim())    return errorResponse(400, 'Full name is required');
    if (!date_of_birth)        return errorResponse(400, 'Date of birth is required');
    if (!front_image_base64)   return errorResponse(400, 'Front ID photo is required');
    if (!selfie_base64)        return errorResponse(400, 'Selfie photo is required');

    // Validate age (must be 18+)
    const dob = new Date(date_of_birth);
    const age = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    if (age < 18) return errorResponse(400, 'You must be at least 18 years old to use SwitchCash.');

    try {
      // Upload images to Netlify Blobs
      const frontUrl  = await uploadImage(front_image_base64, front_image_type || 'image/jpeg', front_image_name  || 'front.jpg');
      const backUrl   = back_image_base64 ? await uploadImage(back_image_base64, back_image_type || 'image/jpeg', back_image_name || 'back.jpg') : null;
      const selfieUrl = await uploadImage(selfie_base64, selfie_type || 'image/jpeg', selfie_name || 'selfie.jpg');

      // Delete any previous rejected submission
      await sql`DELETE FROM kyc_submissions WHERE user_id = ${session.user_id} AND status = 'rejected'`;

      // Insert submission
      const [submission] = await sql`
        INSERT INTO kyc_submissions
          (user_id, id_type, id_number, full_name, date_of_birth, address,
           front_image_url, back_image_url, selfie_url)
        VALUES
          (${session.user_id}, ${id_type}, ${sanitize(id_number)}, ${sanitize(full_name)},
           ${date_of_birth}, ${sanitize(address || '')},
           ${frontUrl}, ${backUrl}, ${selfieUrl})
        RETURNING id
      `;

      // Update profile status
      await sql`
        UPDATE profiles
        SET kyc_status = 'submitted', kyc_submission_id = ${submission.id}
        WHERE id = ${session.user_id}
      `;

      // Email admin (non-blocking)
      import('./_utils/email.js').then(({ sendKycSubmissionEmail }) => {
        if (sendKycSubmissionEmail) sendKycSubmissionEmail({
          userName:  session.full_name,
          userEmail: session.email,
          idType:    id_type,
          submissionId: submission.id,
        }).catch(() => {});
      }).catch(() => {});

      return response(201, {
        message: 'KYC submitted successfully. We typically review within 24 hours.',
        submission_id: submission.id,
      });
    } catch (err) {
      console.error('KYC submit error:', err);
      return errorResponse(500, 'Submission failed. Please try again.');
    }
  }

  // ── USER: CHECK STATUS ───────────────────────────────────────
  if (req.method === 'GET' && resource === 'status') {
    const session = await getSession(req, sql);
    if (!session) return errorResponse(401, 'Not authenticated');

    const [profile] = await sql`
      SELECT kyc_status, kyc_verified_at, transfer_limit_htg FROM profiles WHERE id = ${session.user_id}
    `;
    const [submission] = await sql`
      SELECT id, status, id_type, rejection_reason, submitted_at, reviewed_at
      FROM kyc_submissions WHERE user_id = ${session.user_id}
      ORDER BY created_at DESC LIMIT 1
    `;

    return response(200, {
      kyc_status:        profile?.kyc_status || 'pending',
      kyc_verified_at:   profile?.kyc_verified_at,
      transfer_limit_htg: profile?.transfer_limit_htg || 5000,
      submission: submission || null,
    });
  }

  // ── ADMIN: LIST ALL SUBMISSIONS ──────────────────────────────
  if (req.method === 'GET' && resource === 'list') {
    const admin = await verifyAdmin(req, sql);
    if (!admin) return errorResponse(401, 'Admin auth required');

    const status = url.searchParams.get('status') || 'pending';
    const submissions = status === 'all'
      ? await sql`
          SELECT k.*, p.email, p.phone, p.full_name AS account_name
          FROM kyc_submissions k JOIN profiles p ON p.id = k.user_id
          ORDER BY k.submitted_at DESC LIMIT 100`
      : await sql`
          SELECT k.*, p.email, p.phone, p.full_name AS account_name
          FROM kyc_submissions k JOIN profiles p ON p.id = k.user_id
          WHERE k.status = ${status}
          ORDER BY k.submitted_at ASC LIMIT 100`;

    return response(200, { submissions, total: submissions.length });
  }

  // ── ADMIN: GET SINGLE SUBMISSION ─────────────────────────────
  if (req.method === 'GET' && resource && !action) {
    const admin = await verifyAdmin(req, sql);
    if (!admin) return errorResponse(401, 'Admin auth required');

    const [submission] = await sql`
      SELECT k.*, p.email, p.phone, p.full_name AS account_name, p.created_at AS account_created
      FROM kyc_submissions k JOIN profiles p ON p.id = k.user_id
      WHERE k.id = ${resource}
    `;
    if (!submission) return errorResponse(404, 'Submission not found');
    return response(200, { submission });
  }

  // ── ADMIN: APPROVE ────────────────────────────────────────────
  if (req.method === 'PUT' && action === 'approve') {
    const admin = await verifyAdmin(req, sql);
    if (!admin) return errorResponse(401, 'Admin auth required');

    const [sub] = await sql`SELECT * FROM kyc_submissions WHERE id = ${subId}`;
    if (!sub)                       return errorResponse(404, 'Submission not found');
    if (sub.status !== 'pending')   return errorResponse(400, 'Submission is not pending');

    await sql`
      UPDATE kyc_submissions
      SET status = 'approved', reviewed_by = ${admin.username}, reviewed_at = NOW()
      WHERE id = ${subId}
    `;
    await sql`
      UPDATE profiles
      SET kyc_status = 'verified', kyc_verified_at = NOW(), transfer_limit_htg = 200000.00
      WHERE id = ${sub.user_id}
    `;

    // Email user (non-blocking)
    import('./_utils/email.js').then(({ sendKycApprovedEmail }) => {
      if (sendKycApprovedEmail) {
        sql`SELECT email, full_name FROM profiles WHERE id = ${sub.user_id}`.then(([p]) => {
          sendKycApprovedEmail({ userName: p?.full_name, userEmail: p?.email }).catch(() => {});
        });
      }
    }).catch(() => {});

    return response(200, { message: 'KYC approved. User limit raised to 200,000 HTG.' });
  }

  // ── ADMIN: REJECT ─────────────────────────────────────────────
  if (req.method === 'PUT' && action === 'reject') {
    const admin = await verifyAdmin(req, sql);
    if (!admin) return errorResponse(401, 'Admin auth required');

    const body = await parseBody(req);
    const reason = sanitize(body?.reason || 'Documents could not be verified.');

    const [sub] = await sql`SELECT * FROM kyc_submissions WHERE id = ${subId}`;
    if (!sub)                     return errorResponse(404, 'Submission not found');
    if (sub.status !== 'pending') return errorResponse(400, 'Submission is not pending');

    await sql`
      UPDATE kyc_submissions
      SET status = 'rejected', rejection_reason = ${reason},
          reviewed_by = ${admin.username}, reviewed_at = NOW()
      WHERE id = ${subId}
    `;
    await sql`
      UPDATE profiles
      SET kyc_status = 'rejected', kyc_submission_id = NULL
      WHERE id = ${sub.user_id}
    `;

    // Email user (non-blocking)
    import('./_utils/email.js').then(({ sendKycRejectedEmail }) => {
      if (sendKycRejectedEmail) {
        sql`SELECT email, full_name FROM profiles WHERE id = ${sub.user_id}`.then(([p]) => {
          sendKycRejectedEmail({ userName: p?.full_name, userEmail: p?.email, reason }).catch(() => {});
        });
      }
    }).catch(() => {});

    return response(200, { message: 'KYC rejected. User can resubmit.' });
  }

  return errorResponse(404, 'Unknown KYC resource');
};

export const config = { path: '/api/kyc/:resource*' };
