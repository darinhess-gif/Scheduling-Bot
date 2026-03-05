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

// Track active calls for health endpoint
const activeCalls = new Map();

// ─── Pre-generated audio files ───────────────────────────────────────────────
function loadAudioFile(name) {
  const path = `./audio/${name}.ulaw`;
  if (existsSync(path)) {
    return readFileSync(path);
  }
  console.warn(`[Audio] ${path} not found — run "npm run generate-audio" first`);
  return null;
}

const greetingAudio = loadAudioFile('greeting');
const timeCheckAudio = loadAudioFile('time_check');

// ─── POST /incoming-call — Twilio webhook ────────────────────────────────────
app.post('/incoming-call', (req, res) => {
  const serverUrl = process.env.SERVER_URL;
  const wsUrl = serverUrl.replace(/^https?/, 'wss');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}/triage-stream">
      <Parameter name="callerNumber" value="${req.body.From || 'unknown'}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
  console.log(`[Twilio] Incoming call from ${req.body.From}, opening media stream`);
});

// ─── GET /health ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeCalls: activeCalls.size,
    audioFilesReady: !!(greetingAudio && timeCheckAudio),
    uptime: process.uptime(),
  });
});

// ─── POST /dialpad-webhook ───────────────────────────────────────────────────
app.post('/dialpad-webhook', (req, res) => {
  const { call_id, state, target_number } = req.body;
  console.log(`[Dialpad] Webhook: call=${call_id} state=${state} target=${target_number}`);

  // Update call state if we're tracking it
  if (call_id && activeCalls.has(call_id)) {
    const callData = activeCalls.get(call_id);
    callData.dialpadState = state;
  }

  res.sendStatus(200);
});

// ─── WebSocket /triage-stream — Twilio Media Stream handler ──────────────────
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname === '/triage-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  console.log('[WebSocket] Twilio media stream connected');

  let streamSid = null;
  let callSid = null;
  let callerNumber = 'unknown';
  let deepgram = null;
  let silenceTimer = null;
  let callStartTime = Date.now();
  let hasPlayedGreeting = false;
  let conversationHistory = [];
  let fullTranscript = [];
  let routeDecision = null;
  let isProcessing = false;

  // ─── Send audio to Twilio ───────────────────────────────────────────
  function sendAudioToTwilio(audioBuffer) {
    if (!streamSid || ws.readyState !== 1) return;

    // Twilio expects base64-encoded audio in media messages
    const chunkSize = 640; // 40ms of mulaw at 8kHz
    for (let i = 0; i < audioBuffer.length; i += chunkSize) {
      const chunk = audioBuffer.slice(i, i + chunkSize);
      const message = {
        event: 'media',
        streamSid,
        media: {
          payload: chunk.toString('base64'),
        },
      };
      ws.send(JSON.stringify(message));
    }

    // Send mark event to know when audio finishes playing
    const markId = `mark_${Date.now()}`;
    ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: markId } }));
    return markId;
  }

  // ─── Play greeting sequence ─────────────────────────────────────────
  async function playGreetingSequence() {
    if (hasPlayedGreeting) return;
    hasPlayedGreeting = true;

    if (greetingAudio) {
      sendAudioToTwilio(greetingAudio);
    } else {
      // Fallback: generate on-the-fly
      try {
        const audio = await synthesizeSpeech(
          "Hey! Congrats on getting started. I just have one quick question before I connect you with your onboarding specialist."
        );
        sendAudioToTwilio(audio);
      } catch (err) {
        console.error('[Greeting] ElevenLabs fallback failed:', err.message);
        sendTwilioTTS("Hey! Congrats on getting started. I just have one quick question before I connect you with your onboarding specialist.");
      }
    }

    // Short pause then time check
    setTimeout(() => {
      if (timeCheckAudio) {
        sendAudioToTwilio(timeCheckAudio);
      } else {
        synthesizeSpeech(
          "Onboarding usually takes about 45 minutes to get everything dialed in. Do you have about 45 minutes right now, or would it be better to schedule a time that works for you?"
        )
          .then((audio) => sendAudioToTwilio(audio))
          .catch(() => {
            sendTwilioTTS("Onboarding usually takes about 45 minutes. Do you have about 45 minutes right now, or would it be better to schedule a time?");
          });
      }

      // Start listening after time check plays (estimate audio duration)
      setTimeout(() => {
        startSilenceTimer();
      }, 5000);
    }, 3000);
  }

  // ─── Twilio native TTS fallback ────────────────────────────────────
  function sendTwilioTTS(text) {
    // For Twilio native TTS we need to use the REST API to modify the call
    // This is a fallback — in practice the pre-generated audio is preferred
    console.log(`[TTS Fallback] Would speak: "${text}"`);
  }

  // ─── Silence timer ─────────────────────────────────────────────────
  function startSilenceTimer() {
    clearSilenceTimer();
    silenceTimer = setTimeout(async () => {
      if (isProcessing || routeDecision) return;
      console.log('[Silence] 8s timeout — checking in with client');
      await handleRouteDecision(true);
    }, SILENCE_TIMEOUT_MS);
  }

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  // ─── Handle route decision from Claude ──────────────────────────────
  async function handleRouteDecision(isSilenceCheck = false) {
    if (isProcessing) return;
    isProcessing = true;

    try {
      const decision = await getRouteDecision(conversationHistory, isSilenceCheck);
      console.log(`[Claude] Route: ${decision.route} | Text: "${decision.spokenText}"`);

      // Add assistant response to history
      conversationHistory.push({
        role: 'assistant',
        content: `ROUTE:${decision.route}\n${decision.spokenText}`,
      });

      // Speak the response
      try {
        const audio = await synthesizeSpeech(decision.spokenText);
        sendAudioToTwilio(audio);
      } catch (err) {
        console.error('[TTS] ElevenLabs failed, using fallback:', err.message);
        sendTwilioTTS(decision.spokenText);
      }

      // Handle routing
      await handleRoute(decision.route, decision.spokenText);
    } catch (err) {
      console.error('[Claude] API error, falling back to live transfer:', err.message);
      // Fallback: transfer directly
      await handleRoute('LIVE', null);
      notifyError({
        errorMessage: err.message,
        clientPhone: callerNumber,
        context: 'Claude API failure — fell back to live transfer',
      }).catch(() => {});
    } finally {
      isProcessing = false;
    }
  }

  // ─── Execute routing action ─────────────────────────────────────────
  async function handleRoute(route, spokenText) {
    switch (route) {
      case 'LIVE':
      case 'LIVE_URGENT': {
        routeDecision = route;
        clearSilenceTimer();

        const ringGroupNumber = process.env.DIALPAD_RING_GROUP_NUMBER;
        console.log(`[Route] Transferring to ring group: ${ringGroupNumber}`);

        // Transfer via Twilio REST API
        try {
          const twilioClient = twilio(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
          );

          await twilioClient.calls(callSid).update({
            twiml: `<Response><Dial>${ringGroupNumber}</Dial></Response>`,
          });

          console.log(`[Route] Transfer initiated for call ${callSid}`);
        } catch (err) {
          console.error('[Route] Transfer failed:', err.message);
          notifyError({
            errorMessage: `Transfer failed: ${err.message}`,
            clientPhone: callerNumber,
            context: 'Twilio call transfer',
          }).catch(() => {});
        }

        // Notify Slack
        notifyLiveTransfer({
          clientPhone: callerNumber,
          ringGroupNumber,
        }).catch((err) => console.error('[Slack] Notification failed:', err.message));

        // Log call
        logCall({
          callSid,
          clientPhone: callerNumber,
          transcript: fullTranscript,
          routeDecision: route,
          duration: Math.round((Date.now() - callStartTime) / 1000),
        }).catch((err) => console.error('[Log] Failed:', err.message));

        break;
      }

      case 'SCHEDULE_CONFIRM': {
        routeDecision = route;
        clearSilenceTimer();

        // Extract preferred time from conversation
        const lastUserMsg = conversationHistory
          .filter((m) => m.role === 'user')
          .pop();
        const preferredTime = lastUserMsg?.content || 'Not specified';

        // Notify Slack
        notifyScheduleRequest({
          clientPhone: callerNumber,
          preferredTime,
        }).catch((err) => console.error('[Slack] Notification failed:', err.message));

        // Log call
        logCall({
          callSid,
          clientPhone: callerNumber,
          transcript: fullTranscript,
          routeDecision: route,
          duration: Math.round((Date.now() - callStartTime) / 1000),
        }).catch((err) => console.error('[Log] Failed:', err.message));

        // End call after a short delay
        setTimeout(() => {
          try {
            const twilioClient = twilio(
              process.env.TWILIO_ACCOUNT_SID,
              process.env.TWILIO_AUTH_TOKEN
            );
            twilioClient.calls(callSid).update({
              twiml: '<Response><Hangup/></Response>',
            });
          } catch (err) {
            console.error('[Route] Hangup failed:', err.message);
          }
        }, 5000);

        break;
      }

      case 'SCHEDULE':
        // Continue conversation to collect preferred time
        startSilenceTimer();
        break;

      case 'NONE':
      default:
        startSilenceTimer();
        break;
    }
  }

  // ─── Initialize Deepgram ────────────────────────────────────────────
  function initDeepgram() {
    deepgram = createDeepgramConnection({
      onTranscript({ transcript, isFinal, speechFinal, confidence }) {
        if (!isFinal) return; // Only act on final results

        clearSilenceTimer();

        // Dead air / low confidence detection
        if (confidence < LOW_CONFIDENCE_THRESHOLD) {
          console.log(`[Deepgram] Low confidence (${confidence}): "${transcript}"`);
          conversationHistory.push({
            role: 'user',
            content: `[low confidence transcript]: ${transcript}`,
          });

          // Ask to repeat
          synthesizeSpeech("Sorry, I didn't quite catch that. Could you repeat that?")
            .then((audio) => sendAudioToTwilio(audio))
            .catch(() => sendTwilioTTS("Sorry, I didn't catch that. Could you repeat that?"));

          startSilenceTimer();
          return;
        }

        console.log(`[Deepgram] Final transcript: "${transcript}"`);
        fullTranscript.push({ text: transcript, timestamp: Date.now() });

        // Add to conversation history
        conversationHistory.push({ role: 'user', content: transcript });

        // Send to Claude for routing if speech is final (end of utterance)
        if (speechFinal) {
          handleRouteDecision(false);
        } else {
          startSilenceTimer();
        }
      },

      onError(err) {
        console.error('[Deepgram] Error:', err.message);
        notifyError({
          errorMessage: err.message,
          clientPhone: callerNumber,
          context: 'Deepgram connection error',
        }).catch(() => {});
      },

      onClose() {
        console.log('[Deepgram] Connection closed');
      },
    });
  }

  // ─── Handle Twilio WebSocket messages ───────────────────────────────
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
          callerNumber =
            msg.start.customParameters?.callerNumber || 'unknown';

          console.log(
            `[Twilio] Stream started: sid=${streamSid} call=${callSid} from=${callerNumber}`
          );

          activeCalls.set(callSid, {
            callerNumber,
            startTime: callStartTime,
            streamSid,
          });

          // Initialize Deepgram and start greeting
          initDeepgram();
          playGreetingSequence();
          break;

        case 'media':
          // Forward raw audio to Deepgram
          if (deepgram) {
            const audioBuffer = Buffer.from(msg.media.payload, 'base64');
            deepgram.send(audioBuffer);
          }
          break;

        case 'mark':
          // Audio playback mark reached
          break;

        case 'stop':
          console.log(`[Twilio] Stream stopped: ${streamSid}`);
          cleanup();
          break;
      }
    } catch (err) {
      console.error('[WebSocket] Message parse error:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] Connection closed');
    cleanup();
  });

  ws.on('error', (err) => {
    console.error('[WebSocket] Error:', err.message);
    cleanup();
  });

  function cleanup() {
    clearSilenceTimer();
    deepgram?.close();

    if (callSid) {
      activeCalls.delete(callSid);

      // Log if we haven't already
      if (!routeDecision) {
        logCall({
          callSid,
          clientPhone: callerNumber,
          transcript: fullTranscript,
          routeDecision: 'DISCONNECTED',
          duration: Math.round((Date.now() - callStartTime) / 1000),
        }).catch(() => {});
      }
    }
  }
});

// ─── Start server ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Server] Voice triage bot listening on port ${PORT}`);
  console.log(`[Server] Audio files ready: ${!!(greetingAudio && timeCheckAudio)}`);
});
