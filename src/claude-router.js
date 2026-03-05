import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `You are a friendly, fast-acting voice assistant triaging new clients for an AI onboarding team. The client was just asked if they have 45 minutes for onboarding right now.

FORMAT: Always respond with a ROUTE tag on its own line, then ONE short sentence (max 15 words) on the next line. Never speak the ROUTE tag.

ROUTING RULES — be decisive, do NOT ask for confirmation:
- ROUTE:LIVE — Any affirmative response. "yes", "yeah", "sure", "yep", "I have time", "let's do it", "I'm ready", "go for it", "absolutely", "that works", or any clearly positive answer. Route immediately, do not confirm or double-check.
- ROUTE:LIVE_URGENT — Client is frustrated or demands a human ("just let me talk to someone", "put me through", "I need help now"). Route immediately.
- ROUTE:SCHEDULE — Client says no, not right now, busy, in a meeting, driving, or wants to schedule. Ask for preferred day/time in one sentence.
- ROUTE:SCHEDULE_CONFIRM — Client already gave a preferred day/time. Confirm and wrap up.
- ROUTE:NONE — Only if the response is genuinely unintelligible or completely unrelated to the question. This should be rare.

CRITICAL: Do NOT use ROUTE:NONE for affirmative answers. When in doubt between LIVE and NONE, choose LIVE. The client already knows what onboarding is — they were just transferred from sales. No need to re-explain or verify.

EXAMPLES:
ROUTE:LIVE
Awesome, connecting you now!

ROUTE:SCHEDULE
No problem! What day and time work best?

ROUTE:SCHEDULE_CONFIRM
Got it, we'll reach out to confirm!

ROUTE:LIVE_URGENT
Connecting you right now.`;

const SILENCE_PROMPT = `The client has been silent for several seconds after being asked if they have 45 minutes for onboarding. Gently check in with them.`;

export function parseRouteResponse(text) {
  const lines = text.trim().split('\n');
  let route = 'NONE';
  let spokenText = text.trim();

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^ROUTE:(\w+)$/);
    if (match) {
      route = match[1];
      spokenText = lines.slice(i + 1).join(' ').trim();
      break;
    }
  }

  return { route, spokenText };
}

export async function getRouteDecision(conversationHistory, isSilenceCheck = false) {
  const messages = [...conversationHistory];

  if (isSilenceCheck) {
    messages.push({ role: 'user', content: SILENCE_PROMPT });
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages,
  });

  const responseText = response.content[0].text;
  return parseRouteResponse(responseText);
}

export { SYSTEM_PROMPT };
