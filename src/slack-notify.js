import https from 'https';

function postSlackMessage(text, blocks) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  const body = JSON.stringify({
    channel,
    text,
    blocks,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://slack.com/api/chat.postMessage',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.ok) {
              reject(new Error(`Slack API error: ${parsed.error}`));
            } else {
              resolve(parsed);
            }
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function notifyLiveTransfer({ clientPhone, ringGroupNumber }) {
  const text = `\u{1F4DE} Incoming Live Transfer`;
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '\u{1F4DE} Incoming Live Transfer' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Client Phone:*\n${clientPhone}` },
        { type: 'mrkdwn', text: `*Routed To:*\n${ringGroupNumber}` },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Client confirmed 45+ min availability | ${new Date().toISOString()}`,
        },
      ],
    },
  ];

  return postSlackMessage(text, blocks);
}

export async function notifyScheduleRequest({ clientPhone, preferredTime }) {
  const text = `\u{1F4C5} Schedule Request`;
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '\u{1F4C5} Schedule Request' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Client Phone:*\n${clientPhone}` },
        { type: 'mrkdwn', text: `*Preferred Time:*\n${preferredTime || 'Not specified'}` },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Please book manually in Calendly | ${new Date().toISOString()}`,
        },
      ],
    },
  ];

  return postSlackMessage(text, blocks);
}

export async function notifyError({ errorMessage, clientPhone, context }) {
  const text = `\u{26A0}\u{FE0F} Triage Bot Error`;
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '\u{26A0}\u{FE0F} Triage Bot Error' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Client Phone:*\n${clientPhone || 'Unknown'}` },
        { type: 'mrkdwn', text: `*Context:*\n${context || 'Unknown'}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Error:*\n\`\`\`${errorMessage}\`\`\`` },
    },
  ];

  return postSlackMessage(text, blocks);
}
