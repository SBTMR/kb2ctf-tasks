import {readFile} from 'node:fs/promises';
try {
  const state = JSON.parse(await readFile(process.env.BOT_HEARTBEAT_FILE || '/tmp/bot-state.json', 'utf8'));
  if (state.state !== 'ready' || Date.now() - state.at > 30000) process.exit(1);
} catch { process.exit(1); }
