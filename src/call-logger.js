import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const LOG_FILE = './call_log.json';

async function readLog() {
  if (!existsSync(LOG_FILE)) {
    return [];
  }
  try {
    const data = await readFile(LOG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function logCall({ callSid, clientPhone, transcript, routeDecision, duration }) {
  const logs = await readLog();

  logs.push({
    callSid,
    clientPhone,
    transcript,
    routeDecision,
    duration,
    timestamp: new Date().toISOString(),
  });

  await writeFile(LOG_FILE, JSON.stringify(logs, null, 2));
}
