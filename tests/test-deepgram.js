import WebSocket from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';

const params = new URLSearchParams({
  model: 'nova-3',
  encoding: 'mulaw',
  sample_rate: '8000',
  channels: '1',
  punctuate: 'true',
  endpointing: '300',
  interim_results: 'true',
});

console.log('[Test] Connecting to Deepgram WebSocket...');

const ws = new WebSocket(`${DEEPGRAM_URL}?${params.toString()}`, {
  headers: {
    Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
  },
});

const timeout = setTimeout(() => {
  console.error('[Test] FAIL — Connection timed out after 10s');
  ws.close();
  process.exit(1);
}, 10000);

ws.on('open', () => {
  clearTimeout(timeout);
  console.log('[Test] PASS — Connected to Deepgram WebSocket successfully');
  console.log('[Test] Sending close frame...');
  ws.close();
});

ws.on('error', (err) => {
  clearTimeout(timeout);
  console.error(`[Test] FAIL — WebSocket error: ${err.message}`);
  process.exit(1);
});

ws.on('close', (code) => {
  console.log(`[Test] WebSocket closed with code ${code}`);
  process.exit(0);
});
