# Voice Triage Bot

Voice triage bot for the AI onboarding team. When sales closes a deal and transfers the client to a Twilio number, this bot greets them, checks if they have 45 minutes for onboarding, and either connects them live to a CSM or posts a scheduling request to Slack.

## Architecture

```
Client Phone → Twilio → WebSocket → Server
                                      ├── Deepgram (STT)
                                      ├── Claude (routing)
                                      ├── ElevenLabs (TTS)
                                      ├── Twilio REST (transfer)
                                      └── Slack (notifications)
```

## Prerequisites

- Node.js 18+
- [ngrok](https://ngrok.com/) for local development
- API keys for: Twilio, Deepgram, Anthropic (Claude), ElevenLabs, Slack

## Setup

1. Clone and install dependencies:

```bash
git clone <repo-url>
cd voice-triage-bot
npm install
```

2. Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

### Required Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `SERVER_URL` | Public URL (ngrok URL for local dev) |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Twilio phone number for incoming calls |
| `DIALPAD_RING_GROUP_NUMBER` | Ring group number for live transfers |
| `DEEPGRAM_API_KEY` | Deepgram API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ELEVENLABS_API_KEY` | ElevenLabs API key |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice ID |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_CHANNEL_ID` | Slack channel ID for notifications |

3. Pre-generate greeting audio files:

```bash
npm run generate-audio
```

This creates `audio/greeting.ulaw` and `audio/time_check.ulaw` using ElevenLabs so they don't need to be generated on every call.

4. Start ngrok:

```bash
ngrok http 3000
```

5. Update `SERVER_URL` in `.env` with the ngrok URL.

6. Configure Twilio:
   - Go to your Twilio phone number settings
   - Set the webhook for incoming calls to `POST https://<ngrok-url>/incoming-call`

7. Start the server:

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## Call Flow

1. Client calls the Twilio number
2. Bot greets the client and asks if they have 45 minutes
3. Client responds — audio is transcribed by Deepgram, interpreted by Claude
4. If client has time → transferred live to CSM ring group, Slack notified
5. If client wants to schedule → bot collects preferred time, posts to Slack for manual Calendly booking

## Route Tags

| Tag | Trigger | Action |
|---|---|---|
| `LIVE` | Client has 40+ min | Transfer to ring group |
| `LIVE_URGENT` | Client frustrated | Transfer immediately |
| `SCHEDULE` | Client wants to schedule | Collect preferred time |
| `SCHEDULE_CONFIRM` | Time collected | Post to Slack, end call |
| `NONE` | Ambiguous | Continue conversation |

## Testing

Run individual integration tests (requires valid API keys in `.env`):

```bash
npm run test:deepgram    # Verifies Deepgram WebSocket connection
npm run test:claude      # Tests route tag parsing and Claude API responses
npm run test:elevenlabs  # Generates a test audio file
npm run test:slack       # Posts test messages to Slack channel
```

Slack test supports individual message types:

```bash
node tests/test-slack.js live      # Live transfer notification only
node tests/test-slack.js schedule  # Schedule request only
node tests/test-slack.js error     # Error notification only
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/incoming-call` | Twilio webhook — returns TwiML |
| `WS` | `/triage-stream` | Twilio Media Stream handler |
| `GET` | `/health` | Server status |
| `POST` | `/dialpad-webhook` | Dialpad call status updates |

## Logging

All calls are logged to `call_log.json` with transcript, route decision, duration, and timestamp.

## Fallbacks

- **Claude API fails** → Transfer directly to ring group
- **ElevenLabs fails** → Fall back to Twilio native TTS
- **8s silence** → Bot checks in with client
- **Low confidence transcript** → Bot asks client to repeat
