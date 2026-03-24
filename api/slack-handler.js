// api/slack-handler.js
// Receives Slack message events from your channel, parses post/edit/skip, writes to Google Sheets

import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Read raw body for Slack signature verification
  const rawBody = await getRawBody(req);
  const body = JSON.parse(rawBody.toString());

  // Slack URL verification challenge
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Verify Slack signature
  if (!verifySlackSignature(req.headers, rawBody)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Acknowledge immediately (Slack requires <3s response)
  res.status(200).end();

  // Process asynchronously
  if (body.event) {
    await processEvent(body.event).catch(err =>
      console.error('Event processing error:', err)
    );
  }
}

async function processEvent(event) {
  // Only handle messages from real users (not bots)
  if (event.type !== 'message') return;
  if (event.bot_id || event.subtype) return;
  if (!event.thread_ts) return; // Must be a thread reply

  const text = (event.text || '').trim().toLowerCase();
  const originalText = (event.text || '').trim();

  // Get the parent message to extract postUrl and comment
  const parentData = await getParentMessage(event.channel, event.thread_ts);
  if (!parentData) {
    console.log('Could not find parent message');
    return;
  }

  const { postUrl, comment } = parentData;

  if (text === 'post') {
    // Approve — write to Google Sheets
    await writeToSheets(postUrl, comment, 'approved');
    await sendSlackReply(event.channel, event.thread_ts, '✅ Locked in. Comment queued for posting.');

  } else if (text.startsWith('edit ')) {
    // Edit — use the user's replacement text
    const editedComment = originalText.slice(5).trim();
    await writeToSheets(postUrl, editedComment, 'edited');
    await sendSlackReply(event.channel, event.thread_ts, `✅ Got it. Saved your edit:\n\`\`\`${editedComment}\`\`\`\nReply with *post* if you're happy with it.`);

  } else if (text === 'skip') {
    await sendSlackReply(event.channel, event.thread_ts, '↩️ Comment skipped. Moving on.');
  }
}

async function getParentMessage(channel, threadTs) {
  // Fetch the thread's parent message
  const res = await fetch(
    `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=1`,
    { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
  );
  const data = await res.json();

  if (!data.ok || !data.messages || !data.messages[0]) return null;

  const parent = data.messages[0];

  // Extract postUrl and comment from the message blocks
  // They're stored in a plain-text section at the bottom of the message
  try {
    const blocks = parent.blocks || [];
    let postUrl = null;
    let comment = null;

    for (const block of blocks) {
      if (block.type === 'section' && block.text?.text) {
        const t = block.text.text;
        if (t.includes('Post URL (for logging):')) {
          const urlMatch = t.match(/Post URL \(for logging\): (https?:\/\/\S+)/);
          if (urlMatch) postUrl = urlMatch[1];
          const commentMatch = t.match(/Comment \(for logging\): (.+)/s);
          if (commentMatch) comment = commentMatch[1].trim();
        }
      }
    }

    // Fallback: try metadata if blocks didn't work
    if (!postUrl && parent.metadata?.event_payload) {
      postUrl = parent.metadata.event_payload.postUrl;
      comment = parent.metadata.event_payload.comment;
    }

    return postUrl && comment ? { postUrl, comment } : null;
  } catch (e) {
    console.error('Error parsing parent message:', e);
    return null;
  }
}

async function writeToSheets(postUrl, comment, status) {
  // Get OAuth token
  const token = await getGoogleAccessToken();

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const range = 'Sheet1!A:C';

  const body = {
    values: [[postUrl, comment, status]],
  };

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(`Sheets error: ${JSON.stringify(data.error)}`);
  return data;
}

async function getGoogleAccessToken() {
  // Use a service account JWT to get an access token
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

  // Use Node.js crypto to sign
  const { createSign } = crypto;
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKeyPem, 'base64url');

  return `${signingInput}.${signature}`;
}

async function sendSlackReply(channel, threadTs, text) {
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });
}

function verifySlackSignature(headers, rawBody) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // Skip in dev

  const timestamp = headers['x-slack-request-timestamp'];
  const slackSignature = headers['x-slack-signature'];

  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody.toString()}`;
  const hmac = crypto.createHmac('sha256', signingSecret);
  hmac.update(baseString);
  const computedSig = `v0=${hmac.digest('hex')}`;

  return crypto.timingSafeEqual(Buffer.from(computedSig), Buffer.from(slackSignature));
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
