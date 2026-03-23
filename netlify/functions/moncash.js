// netlify/functions/create-payment.js
const fetch = require('node-fetch'); // add to package.json if not present: "node-fetch": "^2.6.7"

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { amount, orderId } = body;

  if (!amount || !orderId || isNaN(amount) || amount <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid amount or orderId' }) };
  }

  const BASE_URL = process.env.MONCASH_MODE === 'live'
    ? 'https://moncashbutton.digicelgroup.com/Api'
    : 'https://sandbox.moncashbutton.digicelgroup.com/Api';

  const GATEWAY_BASE = process.env.MONCASH_MODE === 'live'
    ? 'https://moncashbutton.digicelgroup.com/Moncash'
    : 'http://sandbox.moncashbutton.digicelgroup.com/Moncash';

  try {
    // Get access token
    const auth = Buffer.from(`${process.env.MONCASH_CLIENT_ID}:${process.env.MONCASH_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(`${BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=read,write',
    });

    if (!tokenRes.ok) throw new Error('Failed to get MonCash token');
    const { access_token } = await tokenRes.json();

    // Create payment
    const paymentRes = await fetch(`${BASE_URL}/v1/CreatePayment`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount: Number(amount), orderId }),
    });

    if (!paymentRes.ok) {
      const err = await paymentRes.json();
      throw new Error(err.message || 'Create payment failed');
    }

    const paymentData = await paymentRes.json();
    const paymentToken = paymentData.payment_token?.token;

    if (!paymentToken) throw new Error('No payment token received');

    const redirectUrl = `${GATEWAY_BASE}/Payment/Redirect?token=${paymentToken}`;

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, redirectUrl }),
    };
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: error.message }),
    };
  }
};
