// TEMPORARY debug endpoint — DELETE after fixing
import { getDb, getDbDirect } from './_utils/db.js';

const IS_SANDBOX    = process.env.MONCASH_MODE !== 'live';
const API_HOST      = IS_SANDBOX
  ? 'https://sandbox.moncashbutton.digicelgroup.com/Api'
  : 'https://moncashbutton.digicelgroup.com/Api';
const GW_BASE       = IS_SANDBOX
  ? 'https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware'
  : 'https://moncashbutton.digicelgroup.com/Moncash-middleware';
const CLIENT_ID     = process.env.MONCASH_CLIENT_ID;
const CLIENT_SECRET = process.env.MONCASH_CLIENT_SECRET;

export default async (req) => {
  const results = {};

  // Step 1: Get MonCash token
  let mcToken;
  try {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const res = await fetch(`${API_HOST}/oauth/token`, {
      method: 'POST',
      headers: {
        'Accept':        'application/json',
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: 'scope=read,write&grant_type=client_credentials',
    });
    const body = await res.text();
    const data = JSON.parse(body);
    mcToken = data.access_token;
    results.step1_token = mcToken ? 'OK — got token' : 'NO TOKEN: ' + body;
  } catch(e) {
    results.step1_token = 'FAILED: ' + e.message;
    return new Response(JSON.stringify(results, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Step 2: CreatePayment with test amount
  try {
    const testOrderId = 'SC-DEBUG-' + Date.now();
    const payload = { amount: 100, orderId: testOrderId };
    const res = await fetch(`${API_HOST}/v1/CreatePayment`, {
      method: 'POST',
      headers: {
        'Accept':        'application/json',
        'Authorization': `Bearer ${mcToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    results.step2_create_payment = {
      status: res.status,
      body:   body.slice(0, 800),
      payload_sent: payload,
    };

    if (res.ok) {
      const data = JSON.parse(body);
      const token = data?.payment_token?.token;
      if (token) {
        results.step3_redirect_url = `${GW_BASE}/Payment/Redirect?token=${token}`;
      }
    }
  } catch(e) {
    results.step2_create_payment = 'FAILED: ' + e.message;
  }

  // Step 3: Test DB insert with fake UUID
  try {
    const sqlDirect = getDbDirect();
    const fakeUserId = '00000000-0000-0000-0000-000000000000';
    const testOrder  = 'SC-DBTEST-' + Date.now();
    // Try insert — will fail on FK but shows if schema is the issue
    await sqlDirect`
      INSERT INTO deposit_receipts (user_id, image_url, wallet_type, amount, reference, moncash_order_id, status, upload_method)
      VALUES (${fakeUserId}, 'moncash-auto', 'moncash', 100, ${testOrder}, ${testOrder}, 'initiated', 'moncash_api')
    `;
    results.step4_db_insert = 'OK';
  } catch(e) {
    results.step4_db_insert = 'FAILED (expected if FK error): ' + e.message;
  }

  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { path: '/api/moncash-debug' };
