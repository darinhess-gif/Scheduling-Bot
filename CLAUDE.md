# Voice Triage Bot

## Project Overview
Voice triage bot for the AI onboarding team. Sits between sales reps and CSM team. When sales closes a deal and transfers the client to a Twilio phone number, this bot greets them, asks if they have 45 minutes for onboarding, and either transfers them live to a CSM or books a scheduled call.

## Stack
- **Runtime**: Node.js with Express, ES modules
- **Telephony**: Twilio Media Streams (bidirectional WebSocket, mulaw audio at 8kHz)
- **Speech-to-Text**: Deepgram Nova 3 (streaming WebSocket)
- **Conversation AI**: Claude API (Sonnet) for intent classification and routing
- **Text-to-Speech**: ElevenLabs Turbo v2.5 (streaming, ulaw_8000 output)
- **Notifications**: Slack Bot API

## Key Endpoints
- `POST /incoming-call` - Twilio webhook, returns TwiML to open Media Stream
- `WebSocket /triage-stream` - Receives Twilio audio, orchestrates full pipeline
- `GET /health` - Server status and CSM availability
- `POST /dialpad-webhook` - Receives call status updates from Dialpad

## Call Flow
1. Twilio webhook opens bidirectional Media Stream
2. Bot plays pre-generated greeting + time check question
3. Client speaks -> Twilio streams audio -> Deepgram transcribes
4. Claude interprets and returns ROUTE tag (LIVE, LIVE_URGENT, SCHEDULE, SCHEDULE_CONFIRM, NONE)
5. ElevenLabs generates spoken response audio
6. Audio streamed back to client via Twilio
7. LIVE/LIVE_URGENT -> transfer to Dialpad ring group, post Slack notification
8. SCHEDULE -> collect preferred time, post to Slack for manual booking

## Route Tags
- `LIVE` - Client has 40+ minutes, transfer immediately
- `LIVE_URGENT` - Client frustrated, transfer immediately
- `SCHEDULE` - Client wants to schedule, collect time preference
- `SCHEDULE_CONFIRM` - Time preference collected, post to Slack
- `NONE` - Need more info, continue conversation

## Running Locally
```bash
npm install
cp .env.example .env  # Fill in API keys
npm run generate-audio  # Pre-generate greeting audio files
ngrok http 3000  # Start tunnel
# Update SERVER_URL in .env with ngrok URL
# Configure Twilio webhook to POST to {ngrok_url}/incoming-call
npm start
```

## Testing
```bash
npm run test:deepgram
npm run test:claude
npm run test:elevenlabs
npm run test:slack
```
