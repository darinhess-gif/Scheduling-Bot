import WebSocket from 'ws';

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';

const DEEPGRAM_PARAMS = new URLSearchParams({
  model: 'nova-3',
  encoding: 'mulaw',
  sample_rate: '8000',
  channels: '1',
  punctuate: 'true',
  endpointing: '300',
  interim_results: 'true',
});

export function createDeepgramConnection({ onTranscript, onError, onClose }) {
  const url = `${DEEPGRAM_URL}?${DEEPGRAM_PARAMS.toString()}`;

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
    },
  });

  ws.on('open', () => {
    console.log('[Deepgram] Connected');
  });

  ws.on('message', (data) => {
    try {
      const response = JSON.parse(data.toString());
      const alternative = response.channel?.alternatives?.[0];
      if (!alternative) return;

      const transcript = alternative.transcript;
      if (!transcript) return;

      const isFinal = response.is_final;
      const speechFinal = response.speech_final;
      const confidence = alternative.confidence;

      onTranscript({
        transcript,
        isFinal,
        speechFinal,
        confidence,
      });
    } catch (err) {
      console.error('[Deepgram] Parse error:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error('[Deepgram] WebSocket error:', err.message);
    onError?.(err);
  });

  ws.on('close', (code, reason) => {
    console.log(`[Deepgram] Closed: ${code} ${reason}`);
    onClose?.(code, reason);
  });

  return {
    send(audioBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(audioBuffer);
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    },
    get readyState() {
      return ws.readyState;
    },
  };
}
