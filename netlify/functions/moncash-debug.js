// TEMPORARY debug endpoint — DELETE after fixing
import { getDb, getDbDirect, getSession } from './_utils/db.js';

const IS_SANDBOX    = process.env.MONCASH_MODE !== 'live';
const API_HOST      = IS_SANDBOX
  ? 'https://sandbox.moncashbutton.digicelgroup.com/Api'
  : 'https://moncashbutton.digicelgroup.com/Api';
const CLIENT_ID     = process.env.MONCASH_CLIENT_ID;
const CLIENT_SECRET = process.env.MONCASH_CLIENT_SECRET;

export default async (req) => {
  const results = {};

  // Step 1: env vars present?
  results.env = {
    has_client_id:     !!CLIENT_ID,
    has_client_secret: !!CLIENT_SECRET,
    client_id_preview: CLIENT_ID ? CLIENT_ID.slice(0,8)+'...' : 'MISSING',
    mode:              IS_SANDBOX ? 'sandbox' : 'live',
    api_host:          API_HOST,
  };

  // Step 2: DB connection
  try {
    const sql = getDb();
    await sql`SELECT 1`;
    results.db_pooled = 'OK';
  } catch(e) {
    results.db_pooled = 'FAILED: ' + e.message;
  }

  // Step 3: DB unpooled
  try {
    const sqlD = getDbDirect();
    await sqlD`SELECT 1`;
    results.db_unpooled = 'OK';
  } catch(e) {
    results.db_unpooled = 'FAILED: ' + e.message;
  }

  // Step 4: Session check
  try {
    const sql = getDb();
    const session = await getSession(req, sql);
    results.session = session ? 'OK — user_id: ' + session.user_id : 'No session (not logged in)';
  } catch(e) {
    results.session = 'FAILED: ' + e.message;
  }

  // Step 5: MonCash token
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
    results.moncash_token = {
      status: res.status,
      body:   body.slice(0, 500),
    };
  } catch(e) {
    results.moncash_token = 'FETCH FAILED: ' + e.message;
  }

  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { path: '/api/moncash-debug' };
