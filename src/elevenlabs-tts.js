import https from 'https';

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

export async function synthesizeSpeech(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream`;

  const body = JSON.stringify({
    text,
    model_id: 'eleven_turbo_v2_5',
    output_format: 'ulaw_8000',
    voice_settings: {
      stability: 0.6,
      similarity_boost: 0.75,
    },
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
          Accept: 'audio/basic',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errorBody = '';
          res.on('data', (chunk) => (errorBody += chunk));
          res.on('end', () =>
            reject(new Error(`ElevenLabs API error ${res.statusCode}: ${errorBody}`))
          );
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function synthesizeSpeechStreaming(text, onChunk) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const url = `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}/stream`;

  const body = JSON.stringify({
    text,
    model_id: 'eleven_turbo_v2_5',
    output_format: 'ulaw_8000',
    voice_settings: {
      stability: 0.6,
      similarity_boost: 0.75,
    },
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
          Accept: 'audio/basic',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errorBody = '';
          res.on('data', (chunk) => (errorBody += chunk));
          res.on('end', () =>
            reject(new Error(`ElevenLabs API error ${res.statusCode}: ${errorBody}`))
          );
          return;
        }

        res.on('data', (chunk) => onChunk(chunk));
        res.on('end', resolve);
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
