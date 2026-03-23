// netlify/functions/create-payment.js
const fetch = require('node-fetch');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { amount, orderId } = JSON.parse(event.body);

  if (!amount || !orderId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing params' }) };
  }

  // Your MonCash logic here (adapt from earlier code I gave)
  const BASE_URL = process.env.MONCASH_MODE === 'live'
    ? 'https://moncashbutton.digicelgroup.com/Api'
    : 'https://sandbox.moncashbutton.digicelgroup.com/Api';

  // ... get token, create payment, return redirectUrl

  try {
    // Implement auth + create payment (use env vars for secrets!)
    const redirectUrl = `YOUR_GENERATED_REDIRECT_URL`; // from MonCash response

    return {
      statusCode: 200,
      body: JSON.stringify({ redirectUrl })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
