import dotenv from 'dotenv';
import { notifyLiveTransfer, notifyScheduleRequest, notifyError } from '../src/slack-notify.js';

dotenv.config();

const testType = process.argv[2] || 'all';

async function testLiveTransfer() {
  console.log('[Test] Sending live transfer notification...');
  try {
    await notifyLiveTransfer({
      clientPhone: '+1555TEST123',
      ringGroupNumber: process.env.DIALPAD_RING_GROUP_NUMBER || '+10000000000',
    });
    console.log('[Test] PASS — Live transfer notification sent');
  } catch (err) {
    console.error(`[Test] FAIL — ${err.message}`);
  }
}

async function testScheduleRequest() {
  console.log('[Test] Sending schedule request notification...');
  try {
    await notifyScheduleRequest({
      clientPhone: '+1555TEST456',
      preferredTime: 'Tomorrow at 2pm EST',
    });
    console.log('[Test] PASS — Schedule request notification sent');
  } catch (err) {
    console.error(`[Test] FAIL — ${err.message}`);
  }
}

async function testErrorNotification() {
  console.log('[Test] Sending error notification...');
  try {
    await notifyError({
      errorMessage: 'Test error — ignore this message',
      clientPhone: '+1555TEST789',
      context: 'test-slack.js integration test',
    });
    console.log('[Test] PASS — Error notification sent');
  } catch (err) {
    console.error(`[Test] FAIL — ${err.message}`);
  }
}

if (testType === 'live' || testType === 'all') await testLiveTransfer();
if (testType === 'schedule' || testType === 'all') await testScheduleRequest();
if (testType === 'error' || testType === 'all') await testErrorNotification();
