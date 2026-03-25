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

  // Slack retries if it doesn't get 200 in 3s — deduplicate with x-slack-retry-num
  const retryNum = req.headers['x-slack-retry-num'];
  if (retryNum) {
    console.log(`Ignoring Slack retry #${retryNum}`);
    return res.status(200).end();
  }

  // Process the event BEFORE responding so Vercel doesn't kill the function
  if (body.event) {
    try {
      await processEvent(body.event);
    } catch (err) {
      console.error('Event processing error:', err);
    }
  }

  // Respond after processing is complete
  res.status(200).end();
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
    try {
      // Write to Sheet1 for the phantom to post
      await writeToSheets('Sheet1!A:C', postUrl, comment, 'approved');
      // Also log to Voice Log for voice learning (includes post context)
      await writeToVoiceLog(postUrl, comment);
      await sendSlackReply(event.channel, event.thread_ts, `✅ Comment queued for posting:\n\`\`\`${comment}\`\`\``);
    } catch (err) {
      await sendSlackReply(event.channel, event.thread_ts, `❌ Failed to save to Google Sheet: ${err.message}`);
    }

  } else if (text.startsWith('edit ')) {
    const editedComment = originalText.slice(5).trim();
    try {
      // Write edited version to Sheet1 for posting
      await writeToSheets('Sheet1!A:C', postUrl, editedComment, 'edited');
      // Log the user's actual edit to Voice Log — this is the real voice data
      await writeToVoiceLog(postUrl, editedComment);
      await sendSlackReply(event.channel, event.thread_ts, `✅ Your edit has been saved to Google Sheet:\n\`\`\`${editedComment}\`\`\``);
    } catch (err) {
      await sendSlackReply(event.channel, event.thread_ts, `❌ Failed to save edit to Google Sheet: ${err.message}`);
    }

  } else if (text === 'skip') {
    await sendSlackReply(event.channel, event.thread_ts, '↩️ Comment skipped. Moving on.');
  }
}

async function getParentMessage(channel, threadTs) {
  const res = await fetch(
    `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=1&include_all_metadata=true`,
    { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
  );
  const data = await res.json();

  if (!data.ok || !data.messages || !data.messages[0]) {
    console.error('conversations.replies failed:', JSON.stringify(data));
    return null;
  }

  const parent = data.messages[0];

  try {
    let postUrl = null;
    let comment = null;

    // Try metadata first
    if (parent.metadata?.event_payload) {
      postUrl = parent.metadata.event_payload.postUrl;
      comment = parent.metadata.event_payload.comment;
    }

    // Fallback: parse from block content directly
    if (!postUrl) {
      const blocks = parent.blocks || [];
      for (const block of blocks) {
        if (block.type !== 'section' || !block.text?.text) continue;
        const t = block.text.text;

        // Extract postUrl from the "View on LinkedIn" link: <URL|View on LinkedIn>
        if (!postUrl) {
          const linkMatch = t.match(/<([^|>]+)\|View on LinkedIn>/);
          if (linkMatch) {
            postUrl = linkMatch[1];
          }
        }

        // Extract comment from the "Proposed comment:" section
        if (!comment) {
          const commentMatch = t.match(/^\*Proposed comment:\*\n([\s\S]+)$/);
          if (commentMatch) {
            comment = commentMatch[1].trim();
          }
        }
      }
    }

    // Final fallback: try context block with lenient regex (handles Slack URL formatting)
    if (!postUrl) {
      const blocks = parent.blocks || [];
      for (const block of blocks) {
        if (block.type === 'context' && block.elements) {
          for (const el of block.elements) {
            const t = el.text || '';
            // Handle Slack auto-linking: postUrl::<URL|text>::comment::...::end
            const match = t.match(/postUrl::<?([^|>\s]+)[^:]*::comment::(.+?)::end/s);
            if (match) {
              postUrl = match[1].trim();
              comment = match[2].trim();
            }
          }
        }
      }
    }

    if (!postUrl || !comment) {
      console.error('Could not parse postUrl/comment from parent. Blocks:', JSON.stringify(parent.blocks));
    }

    // Strip any Slack markdown artifacts so the sheet gets clean values
    if (postUrl) postUrl = stripSlackFormatting(postUrl);
    if (comment) comment = stripSlackFormatting(comment);

    return postUrl && comment ? { postUrl, comment } : null;
  } catch (e) {
    console.error('Error parsing parent message:', e);
    return null;
  }
}

function stripSlackFormatting(text) {
  return text
    // Convert Slack links <URL|label> to just URL, or <URL> to URL
    .replace(/<([^|>]+)\|[^>]+>/g, '$1')
    .replace(/<([^>]+)>/g, '$1')
    // Remove bold/italic markers
    .replace(/\*/g, '')
    .replace(/_/g, '')
    // Remove any remaining Slack special chars
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

async function writeToSheets(range, postUrl, comment, status) {
  const token = await getGoogleAccessToken();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ values: [[postUrl, comment, status]] }),
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(`Sheets error: ${JSON.stringify(data.error)}`);
  return data;
}

async function writeToVoiceLog(postUrl, comment) {
  const token = await getGoogleAccessToken();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const range = 'Voice Log!A:C';
  const timestamp = new Date().toISOString();

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ values: [[postUrl, comment, timestamp]] }),
    }
  );

  const data = await res.json();
  if (data.error) {
    // Don't throw — voice log failure shouldn't block the main flow
    console.error('Voice log write failed:', data.error);
  }
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
