import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import dotenv from 'dotenv';
import { synthesizeSpeech } from './elevenlabs-tts.js';

dotenv.config();

const AUDIO_DIR = './audio';

const MESSAGES = {
  greeting: "Hey! Congrats on getting started. I just have one quick question before I connect you with your onboarding specialist.",
  time_check: "Onboarding usually takes about 45 minutes to get everything dialed in. Do you have about 45 minutes right now, or would it be better to schedule a time that works for you?",
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
