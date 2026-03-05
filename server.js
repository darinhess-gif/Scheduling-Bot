import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { existsSync, readFileSync } from 'fs';
import dotenv from 'dotenv';
import twilio from 'twilio';

import { createDeepgramConnection } from './src/deepgram-stt.js';
import { getRouteDecision, parseRouteResponse } from './src/claude-router.js';
import { synthesizeSpeech } from './src/elevenlabs-tts.js';
import { notifyLiveTransfer, notifyScheduleRequest, notifyError } from './src/slack-notify.js';
import { logCall } from './src/call-logger.js';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = createServer(app);
const PORT = process.env.PORT || 3000;
const SILENCE_TIMEOUT_MS = 8000;
const LOW_CONFIDENCE_THRESHOLD = 0.4;
const activeCalls = new Map();

function loadAudioFile(name) {
  const path = `./audio/${name}.ulaw`;
  if (existsSync(path)) return readFileSync(path);
  console.warn(`[Audio] ${path} not found — run "npm run generate-audio" first`);
  return null;
}

const greetingAudio = loadAudioFile('greeting');
const timeCheckAudio = loadAudioFile('time_check');

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// ─── HTTP endpoints ──────────────────────────────────────────────────────────

app.post('/incoming-call', (req, res) => {
  const wsUrl = process.env.SERVER_URL.replace(/^https?/, 'wss');
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}/triage-stream">
      <Parameter name="callerNumber" value="${req.body.From || 'unknown'}" />
    </Stream>
  </Connect>
</Response>`);
  console.log(`[Twilio] Incoming call from ${req.body.From}`);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeCalls: activeCalls.size,
    audioFilesReady: !!(greetingAudio && timeCheckAudio),
    uptime: process.uptime(),
  });
});

app.post('/dialpad-webhook', (req, res) => {
  const { call_id, state, target_number } = req.body;
  console.log(`[Dialpad] call=${call_id} state=${state} target=${target_number}`);
  if (call_id && activeCalls.has(call_id)) activeCalls.get(call_id).dialpadState = state;
  res.sendStatus(200);
});

// ─── WebSocket /triage-stream ────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/triage-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  console.log('[WS] Twilio media stream connected');

  let streamSid = null, callSid = null, callerNumber = 'unknown', deepgram = null;
  let silenceTimer = null, callStartTime = Date.now(), hasPlayedGreeting = false;
  let conversationHistory = [], fullTranscript = [], routeDecision = null;
  let isProcessing = false, timeCheckMarkId = null, greetingComplete = false;
  let botSpeakingMarkId = null, botAudioResolve = null;

  function sendAudioToTwilio(audioBuffer) {
    if (!streamSid || ws.readyState !== 1) return;
    const chunkSize = 640;
    for (let i = 0; i < audioBuffer.length; i += chunkSize) {
      ws.send(JSON.stringify({
        event: 'media', streamSid,
        media: { payload: audioBuffer.slice(i, i + chunkSize).toString('base64') },
      }));
    }
    const markId = `mark_${Date.now()}`;
    ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: markId } }));
    return markId;
  }

  function sendTwilioTTS(text) {
    console.log(`[TTS Fallback] Would speak: "${text}"`);
  }

  async function speakOrFallback(text) {
    try {
      return sendAudioToTwilio(await synthesizeSpeech(text));
    } catch {
      sendTwilioTTS(text);
      return null;
    }
  }

  function startSilenceTimer() {
    clearSilenceTimer();
    silenceTimer = setTimeout(async () => {
      if (isProcessing || routeDecision) return;
      console.log('[Silence] 8s timeout — checking in');
      await handleRouteDecision(true);
    }, SILENCE_TIMEOUT_MS);
  }

  function clearSilenceTimer() {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }

  function waitForBotAudioFinished() {
    if (!botSpeakingMarkId) return Promise.resolve();
    return new Promise((resolve) => {
      botAudioResolve = resolve;
      setTimeout(() => {
        if (botAudioResolve) {
          console.log('[Audio] 5s timeout waiting for mark, proceeding');
          botAudioResolve = null;
          resolve();
        }
      }, 5000);
    });
  }

  function callDuration() {
    return Math.round((Date.now() - callStartTime) / 1000);
  }

  function finishCall(route) {
    logCall({
      callSid, clientPhone: callerNumber, transcript: fullTranscript,
      routeDecision: route, duration: callDuration(),
    }).catch((err) => console.error('[Log] Failed:', err.message));
  }

  async function updateCall(twiml) {
    await getTwilioClient().calls(callSid).update({ twiml });
  }

  async function playGreetingSequence() {
    if (hasPlayedGreeting) return;
    hasPlayedGreeting = true;

    if (greetingAudio) {
      sendAudioToTwilio(greetingAudio);
    } else {
      await speakOrFallback("Hey! Congrats on getting started. I just have one quick question before I connect you with your onboarding specialist.");
    }

    if (timeCheckAudio) {
      timeCheckMarkId = sendAudioToTwilio(timeCheckAudio);
    } else {
      const text = "Onboarding usually takes about 45 minutes to get everything dialed in. Do you have about 45 minutes right now, or would it be better to schedule a time that works for you?";
      timeCheckMarkId = await speakOrFallback(text);
      if (!timeCheckMarkId) {
        setTimeout(() => { greetingComplete = true; startSilenceTimer(); }, 12000);
      }
    }

    console.log(`[Greeting] Queued, waiting for mark ${timeCheckMarkId}`);
  }

  async function handleRouteDecision(isSilenceCheck = false) {
    if (isProcessing) return;
    isProcessing = true;

    try {
      const decision = await getRouteDecision(conversationHistory, isSilenceCheck);
      console.log(`[Claude] Route: ${decision.route} | "${decision.spokenText}"`);

      conversationHistory.push({
        role: 'assistant',
        content: `ROUTE:${decision.route}\n${decision.spokenText}`,
      });

      clearSilenceTimer();
      botSpeakingMarkId = await speakOrFallback(decision.spokenText);
      await handleRoute(decision.route);
    } catch (err) {
      console.error('[Claude] API error, falling back to live transfer:', err.message);
      await handleRoute('LIVE');
      notifyError({ errorMessage: err.message, clientPhone: callerNumber, context: 'Claude API failure' }).catch(() => {});
    } finally {
      isProcessing = false;
    }
  }

  async function handleRoute(route) {
    switch (route) {
      case 'LIVE':
      case 'LIVE_URGENT': {
        routeDecision = route;
        clearSilenceTimer();
        await waitForBotAudioFinished();

        const ringGroupNumber = process.env.DIALPAD_RING_GROUP_NUMBER;
        console.log(`[Route] Transferring to ${ringGroupNumber}`);

        try {
          await updateCall(`<Response><Dial>${ringGroupNumber}</Dial></Response>`);
          console.log(`[Route] Transfer initiated for ${callSid}`);
        } catch (err) {
          console.error('[Route] Transfer failed:', err.message);
          notifyError({ errorMessage: `Transfer failed: ${err.message}`, clientPhone: callerNumber, context: 'Twilio call transfer' }).catch(() => {});
        }

        notifyLiveTransfer({ clientPhone: callerNumber, ringGroupNumber }).catch((err) => console.error('[Slack]', err.message));
        finishCall(route);
        break;
      }

      case 'SCHEDULE_CONFIRM': {
        routeDecision = route;
        clearSilenceTimer();
        await waitForBotAudioFinished();

        const preferredTime = conversationHistory.filter((m) => m.role === 'user').pop()?.content || 'Not specified';
        notifyScheduleRequest({ clientPhone: callerNumber, preferredTime }).catch((err) => console.error('[Slack]', err.message));
        finishCall(route);

        try { await updateCall('<Response><Hangup/></Response>'); }
        catch (err) { console.error('[Route] Hangup failed:', err.message); }
        break;
      }

      default:
        break;
    }
  }

  function initDeepgram() {
    deepgram = createDeepgramConnection({
      onTranscript({ transcript, isFinal, speechFinal, confidence }) {
        if (!isFinal || !greetingComplete) return;
        clearSilenceTimer();

        if (confidence < LOW_CONFIDENCE_THRESHOLD) {
          console.log(`[Deepgram] Low confidence (${confidence}): "${transcript}"`);
          conversationHistory.push({ role: 'user', content: `[low confidence transcript]: ${transcript}` });
          speakOrFallback("Sorry, I didn't quite catch that. Could you repeat that?");
          startSilenceTimer();
          return;
        }

        console.log(`[Deepgram] "${transcript}"`);
        fullTranscript.push({ text: transcript, timestamp: Date.now() });
        conversationHistory.push({ role: 'user', content: transcript });

        if (speechFinal) handleRouteDecision(false);
        else startSilenceTimer();
      },
      onError(err) {
        console.error('[Deepgram] Error:', err.message);
        notifyError({ errorMessage: err.message, clientPhone: callerNumber, context: 'Deepgram error' }).catch(() => {});
      },
      onClose() { console.log('[Deepgram] Connection closed'); },
    });
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case 'connected':
          console.log('[Twilio] Media stream connected');
          break;

        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          callerNumber = msg.start.customParameters?.callerNumber || 'unknown';
          console.log(`[Twilio] Stream started: sid=${streamSid} call=${callSid} from=${callerNumber}`);
          activeCalls.set(callSid, { callerNumber, startTime: callStartTime, streamSid });
          initDeepgram();
          playGreetingSequence();
          break;

        case 'media':
          if (deepgram) deepgram.send(Buffer.from(msg.media.payload, 'base64'));
          break;

        case 'mark': {
          const markName = msg.mark?.name;
          if (!markName) break;

          if (markName === timeCheckMarkId) {
            greetingComplete = true;
            console.log('[Twilio] Greeting finished, starting silence timer');
            startSilenceTimer();
          }

          if (markName === botSpeakingMarkId) {
            botSpeakingMarkId = null;
            console.log('[Twilio] Bot audio finished');
            if (botAudioResolve) { const r = botAudioResolve; botAudioResolve = null; r(); }
            if (!routeDecision) startSilenceTimer();
          }
          break;
        }

        case 'stop':
          console.log(`[Twilio] Stream stopped: ${streamSid}`);
          cleanup();
          break;
      }
    } catch (err) {
      console.error('[WS] Parse error:', err.message);
    }
  });

  ws.on('close', () => { console.log('[WS] Closed'); cleanup(); });
  ws.on('error', (err) => { console.error('[WS] Error:', err.message); cleanup(); });

  function cleanup() {
    clearSilenceTimer();
    deepgram?.close();
    if (callSid) {
      activeCalls.delete(callSid);
      if (!routeDecision) finishCall('DISCONNECTED');
    }
  }
});

// ─── Start server ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Server] Voice triage bot on port ${PORT}, audio ready: ${!!(greetingAudio && timeCheckAudio)}`);
});
