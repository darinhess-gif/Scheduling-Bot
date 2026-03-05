import { writeFile } from 'fs/promises';
import dotenv from 'dotenv';
import { synthesizeSpeech } from '../src/elevenlabs-tts.js';

dotenv.config();

const TEST_TEXT = 'Hello! This is a test of the ElevenLabs text to speech integration.';
const OUTPUT_FILE = './audio/test_output.ulaw';

console.log('[Test] Generating speech with ElevenLabs...');
console.log(`[Test] Text: "${TEST_TEXT}"`);

try {
  const audioBuffer = await synthesizeSpeech(TEST_TEXT);
  await writeFile(OUTPUT_FILE, audioBuffer);
  console.log(`[Test] PASS — Generated ${audioBuffer.length} bytes`);
  console.log(`[Test] Saved to ${OUTPUT_FILE}`);
} catch (err) {
  console.error(`[Test] FAIL — ${err.message}`);
  process.exit(1);
}
