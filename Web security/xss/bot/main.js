import {chromium} from 'playwright';
import {writeFile, rename} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {origin, runner} from './policy.js';
import {ensureSession} from './auth.js';

const APP = origin(process.env.FORUM_ORIGIN || 'http://xss:8080');
const PASSWORD = 'kb2ctf_meme_reader_demo_password_2026';
if (PASSWORD.length < 32) throw new Error('Invalid bot configuration');
const HEARTBEAT = process.env.BOT_HEARTBEAT_FILE || '/tmp/bot-state.json';
let browser;
let context;
let page;
let stopping = false;
let visits = 0;
let logins = 0;
let generation = 0;

async function heartbeat(state) {
  // Only operational counters are recorded. No cookies, page bodies, passwords or flags.
  await writeFile(HEARTBEAT + '.tmp', JSON.stringify({state, at: Date.now(), visits, logins, generation}));
  await rename(HEARTBEAT + '.tmp', HEARTBEAT);
}

async function openBrowser() {
  browser = await chromium.launch({headless: true, chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-dev-shm-usage'],
    timeout: 20000});
  context = await browser.newContext({acceptDownloads: false});
  context.on('page', opened => {
    opened.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    // The single forum page is created below; unsolicited extra pages are closed.
    if (page && opened !== page) opened.close().catch(() => {});
  });
  page = await context.newPage();
  page.setDefaultNavigationTimeout(5000);
  page.setDefaultTimeout(5000);
  generation += 1;
}

async function visit() {
  if (!browser?.isConnected() || page?.isClosed()) {
    await browser?.close().catch(() => {});
    page = null;
    await openBrowser();
  }
  if (await ensureSession(context.request, APP, PASSWORD)) logins += 1;
  // Full document navigation processes persisted content. The context and cookies survive.
  const response = await page.goto(APP + '/', {waitUntil: 'domcontentloaded', timeout: 5000});
  if (!response?.ok()) throw new Error('Forum unavailable');
  visits += 1;
  await heartbeat('ready');
}

const tick = runner(async () => {
  try { await visit(); }
  catch {
    console.error('Forum visit failed; retrying on the next cycle.');
    await heartbeat('retrying');
    // Reuse the context and cookies after a navigation failure.
    if (page && !page.isClosed()) await page.goto('about:blank', {timeout: 2000}).catch(() => {});
  }
});

async function stop() {
  stopping = true;
  await browser?.close().catch(() => {});
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

try {
  await openBrowser();
  while (!stopping) {
    const started = Date.now();
    await tick();
    await pause(Math.max(0, 7000 - (Date.now() - started)));
  }
} catch {
  console.error('Bot startup failed: check browser sandbox and local configuration.');
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
