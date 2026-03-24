// api/run.js
// Triggered by a cron or manual call. Fetches PB results, generates comments, posts to Slack for review.

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Fetch PhantomBuster agent metadata to get S3 file location
    const pbKey = process.env.PHANTOMBUSTER_API_KEY;
    if (!pbKey || !process.env.PHANTOM_ID) {
      return res.status(500).json({ error: 'Missing env vars', hasPbKey: !!pbKey, hasPhantomId: !!process.env.PHANTOM_ID });
    }

    let agentRes;
    try {
      agentRes = await fetch(
        `https://api.phantombuster.com/api/v2/agents/fetch?id=${process.env.PHANTOM_ID}`,
        {
          headers: {
            'X-Phantombuster-Key': pbKey,
            'X-Phantombuster-Key-1': pbKey,
          },
        }
      );
    } catch (fetchErr) {
      return res.status(500).json({ error: 'PhantomBuster fetch failed', message: fetchErr.message });
    }
    const agent = await agentRes.json();

    if (!agent.id) {
      return res.status(500).json({ error: 'Failed to fetch agent', details: agent });
    }

    const { s3Folder, orgS3Folder } = agent;
    const jsonUrl = `https://cache1.phantombuster.com/${orgS3Folder}/${s3Folder}/result.json`;

    // 2. Fetch the actual results JSON
    const resultsRes = await fetch(jsonUrl);
    if (!resultsRes.ok) {
      return res.status(500).json({ error: 'Failed to fetch results JSON', url: jsonUrl });
    }

    const posts = await resultsRes.json();

    // 3. Filter to posts that have actual content
    const validPosts = posts.filter(p => p.postUrl && p.postText && p.postText.trim().length > 20);

    if (validPosts.length === 0) {
      return res.status(200).json({ message: 'No valid posts found', total: posts.length });
    }

    // 4. Clear the Google Sheet (except header row) before this batch
    try {
      await clearSheet();
    } catch (sheetErr) {
      return res.status(500).json({ error: 'clearSheet failed', message: sheetErr.message, cause: sheetErr.cause?.message });
    }

    // 5. For each post, generate a comment and post to Slack
    const results = [];
    for (const post of validPosts.slice(0, 20)) {
      try {
        const comment = await generateComment(post);
        await postToSlack(post, comment);
        results.push({ postUrl: post.postUrl, status: 'sent_to_slack' });
        // Small delay to avoid rate limits
        await sleep(500);
      } catch (err) {
        results.push({ postUrl: post.postUrl, status: 'error', error: err.message });
      }
    }

    return res.status(200).json({ processed: results.length, results });
  } catch (err) {
    console.error('Run error:', err);
    return res.status(500).json({ error: err.message, stack: err.stack, cause: err.cause?.message });
  }
}

async function generateComment(post) {
  const prompt = buildPrompt(post);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (!data.content || !data.content[0]) {
    throw new Error('No content from Claude');
  }
  return data.content[0].text.trim();
}

function buildPrompt(post) {
  return `You are writing a LinkedIn comment on behalf of Josh, founder of SalesGlider Growth — a B2B outbound lead gen agency. Josh has a $20M B2B sales background and posts regularly about cold email, outbound strategy, and GTM.

Here is the LinkedIn post you are commenting on:
---
Author: ${post.profileUrl || 'Unknown'}
Post URL: ${post.postUrl}
Post Content:
"${post.postText}"
---

Write a LinkedIn comment in Josh's voice. Rules:
- Under 75 words. Fragments are fine.
- Sounds like a real LinkedIn comment from a fellow practitioner, not a generic compliment
- No "I noticed" or "I saw" or "Great post!" or "This is so true!"
- Can disagree, add a contrarian take, share a quick stat, or build on the idea with a specific example
- First line is a punchy hook — reads like the opening of a LinkedIn comment, not a sentence
- Must sound like Josh: direct, a little irreverent, occasionally funny, always substantive
- Quote or reference exact words from the post when it strengthens the comment
- Return ONLY the comment text. No quotes around it. No preamble.

Josh's voice samples for reference:
- "Cold callers, are you feeling personally targeted?"
- "Don't send any emails today. How much work could you do?"
- "Lead Gen Agencies = Fractional SDRs, CROs, and IT Directors rolled into one."
- "I have been saying this for a while...to my wife, but ask her, I really have!"

Write the comment now:`;
}

async function postToSlack(post, comment) {
  const truncatedPost = post.postText.length > 400
    ? post.postText.slice(0, 400) + '...'
    : post.postText;

  const message = {
    channel: process.env.SLACK_CHANNEL_ID,
    text: `New LinkedIn comment ready for review`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '💬 LinkedIn Comment Review', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Post:*\n<${post.postUrl}|View on LinkedIn>\n\n*Post excerpt:*\n_"${truncatedPost}"_`,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Proposed comment:*\n\`\`\`${comment}\`\`\``,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Reply with *post* to approve • *edit [your text]* to replace • *skip* to reject`,
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_Post URL (for logging):_ ${post.postUrl}\n_Comment (for logging):_ ${comment}`,
        },
      },
    ],
    metadata: {
      event_type: 'linkedin_comment_review',
      event_payload: {
        postUrl: post.postUrl,
        comment: comment,
      },
    },
  };

  const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(message),
  });

  const slackData = await slackRes.json();
  if (!slackData.ok) {
    throw new Error(`Slack error: ${slackData.error}`);
  }
  return slackData;
}

async function clearSheet() {
  const token = await getGoogleAccessToken();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  // Clear everything from row 2 onward (preserve header row)
  const range = 'Sheet1!A2:C';
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:clear`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(`Sheets clear error: ${JSON.stringify(data.error)}`);
  return data;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
