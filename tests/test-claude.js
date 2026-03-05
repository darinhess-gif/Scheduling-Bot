import dotenv from 'dotenv';
import { getRouteDecision, parseRouteResponse } from '../src/claude-router.js';

dotenv.config();

const testCases = [
  {
    name: 'Client has time (LIVE)',
    history: [{ role: 'user', content: "Yeah, I've got about an hour free right now." }],
    expectedRoute: 'LIVE',
  },
  {
    name: 'Client wants to schedule (SCHEDULE)',
    history: [{ role: 'user', content: "I'm actually in a meeting in 15 minutes, can we do this later?" }],
    expectedRoute: 'SCHEDULE',
  },
  {
    name: 'Client is frustrated (LIVE_URGENT)',
    history: [{ role: 'user', content: "Just let me talk to someone already." }],
    expectedRoute: 'LIVE_URGENT',
  },
  {
    name: 'Client provides time (SCHEDULE_CONFIRM)',
    history: [
      { role: 'user', content: "I'd rather schedule, I'm busy right now." },
      { role: 'assistant', content: "ROUTE:SCHEDULE\nNo problem! What day and time would work best for you?" },
      { role: 'user', content: "How about tomorrow at 2pm?" },
    ],
    expectedRoute: 'SCHEDULE_CONFIRM',
  },
  {
    name: 'Ambiguous response (NONE or SCHEDULE)',
    history: [{ role: 'user', content: "Hmm, I'm not really sure." }],
    expectedRoute: null, // Could be NONE or SCHEDULE
  },
];

// Test parseRouteResponse
console.log('─── Testing parseRouteResponse ───\n');

const parseTests = [
  { input: 'ROUTE:LIVE\nAwesome, connecting you now!', expectedRoute: 'LIVE', expectedText: 'Awesome, connecting you now!' },
  { input: 'ROUTE:SCHEDULE\nNo worries! What time works?', expectedRoute: 'SCHEDULE', expectedText: 'No worries! What time works?' },
  { input: 'Some text without a route tag', expectedRoute: 'NONE', expectedText: 'Some text without a route tag' },
];

let parsePassed = 0;
for (const test of parseTests) {
  const result = parseRouteResponse(test.input);
  const passed = result.route === test.expectedRoute && result.spokenText === test.expectedText;
  console.log(`${passed ? 'PASS' : 'FAIL'} — parseRouteResponse("${test.input.substring(0, 30)}...")`);
  if (!passed) {
    console.log(`  Expected: route=${test.expectedRoute}, text="${test.expectedText}"`);
    console.log(`  Got:      route=${result.route}, text="${result.spokenText}"`);
  } else {
    parsePassed++;
  }
}
console.log(`\nParse tests: ${parsePassed}/${parseTests.length} passed\n`);

// Test Claude API integration
console.log('─── Testing Claude API Route Decisions ───\n');

let apiPassed = 0;
for (const testCase of testCases) {
  try {
    const result = await getRouteDecision(testCase.history);
    const passed = testCase.expectedRoute === null || result.route === testCase.expectedRoute;
    const icon = passed ? 'PASS' : 'WARN';
    console.log(`${icon} — ${testCase.name}`);
    console.log(`  Route: ${result.route} | Text: "${result.spokenText}"`);
    if (passed) apiPassed++;
  } catch (err) {
    console.error(`FAIL — ${testCase.name}: ${err.message}`);
  }
}

console.log(`\nAPI tests: ${apiPassed}/${testCases.length} passed`);
