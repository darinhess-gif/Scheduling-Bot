import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import dotenv from 'dotenv';
import { synthesizeSpeech } from './elevenlabs-tts.js';

dotenv.config();

const AUDIO_DIR = './audio';

const MESSAGES = {
  greeting: "Hey, congrats on getting started!",
  time_check: "Onboarding takes about 45 minutes. Do you have time right now, or would you rather schedule?",
};

async function generateAudioFiles() {
  if (!existsSync(AUDIO_DIR)) {
    mkdirSync(AUDIO_DIR, { recursive: true });
  }

  for (const [name, text] of Object.entries(MESSAGES)) {
    const outputPath = `${AUDIO_DIR}/${name}.ulaw`;

    if (existsSync(outputPath)) {
      console.log(`[Audio] ${name}.ulaw already exists, skipping`);
      continue;
    }

    console.log(`[Audio] Generating ${name}.ulaw...`);
    try {
      const audioBuffer = await synthesizeSpeech(text);
      await writeFile(outputPath, audioBuffer);
      console.log(`[Audio] Saved ${name}.ulaw (${audioBuffer.length} bytes)`);
    } catch (err) {
      console.error(`[Audio] Failed to generate ${name}.ulaw:`, err.message);
      process.exit(1);
    }
  }

  console.log('[Audio] All audio files generated successfully');
}

generateAudioFiles();
