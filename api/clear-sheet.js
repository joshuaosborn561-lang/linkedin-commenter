// api/clear-sheet.js
// Clears Sheet1 rows 2+ after the phantom has posted the comments.
// Trigger this AFTER the phantom runs (e.g. 21:45 MWF via cron-job.org)

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method === 'GET' || req.method === 'POST') {
    try {
      const token = await getGoogleAccessToken();
      const spreadsheetId = process.env.GOOGLE_SHEET_ID;
      const range = 'Sheet1!A2:C';

      const clearRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        }
      );

      const data = await clearRes.json();
      if (data.error) {
        return res.status(500).json({ error: 'Sheets clear error', details: data.error });
      }

      return res.status(200).json({ status: 'ok', message: 'Sheet1 cleared (rows 2+)' });
    } catch (err) {
      console.error('Clear sheet error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function getGoogleAccessToken() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const jwt = await createJWT(payload, serviceAccount.private_key);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Failed to get Google access token');
  return tokenData.access_token;
}

async function createJWT(payload, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

  const signingInput = `${encode(header)}.${encode(payload)}`;

  const { createSign } = crypto;
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKeyPem, 'base64url');

  return `${signingInput}.${signature}`;
}
