import assert from 'node:assert/strict';
import test from 'node:test';
import {allowedRequest, target, VisitQueue} from '../policy.js';
import {visit} from '../visitor.js';

const lane = {id:'REFLECTED', publicOrigin:'http://127.0.0.1:18084', internalOrigin:'http://127.0.0.1:8080'};
const url = lane.publicOrigin + '/search?q=HTTP#q=fragment';

test('parser keeps query and fragment but accepts only the configured origin and /search', () => {
  assert.equal(target(url, lane), lane.internalOrigin + '/search?q=HTTP#q=fragment');
  for (const value of ['http://example.invalid/search', 'http://127.0.0.1:18085/search', 'http://127.0.0.1:8080/search',
    'http://127.0.0.1:18084/profile', 'http://127.0.0.1:18084/search/', 'http://user:pass@127.0.0.1:18084/search',
    'https://127.0.0.1:18084/search', '//127.0.0.1:18084/search', 'file:///search', 'data:text/plain,test',
    'http://host.docker.internal/search', 'http://169.254.169.254/search', 'http://[::1]/search',
    'http://127.0.0.1:18084\\@example.invalid/search', 'http://127.0.0.1:18084/search\n', 'x'.repeat(4097)]) {
    assert.throws(() => target(value, lane), value);
  }
});

test('browser requests are limited to read-only search resources of the current app', () => {
  for (const path of ['/search', '/search?q=HTTP', '/static/search.js', '/static/styles.css', '/catalog.json']) assert.equal(allowedRequest(lane.internalOrigin + path, 'GET', lane), true);
  for (const path of ['/profile', '/demo-login', '/report', '/', '/healthz']) assert.equal(allowedRequest(lane.internalOrigin + path, 'GET', lane), false);
  assert.equal(allowedRequest(lane.internalOrigin + '/search', 'POST', lane), false);
  for (const denied of ['http://search-dom:8080/search', 'http://example.invalid/search', 'http://127.0.0.1:18084/search', 'ws://127.0.0.1:8080/search']) assert.equal(allowedRequest(denied, 'GET', lane), false);
});

test('bounded queue serializes work and recovers after a failed visit', async () => {
  let now = 1000, active = 0, maxActive = 0, release;
  const first = new Promise(resolve => { release = resolve; });
  const completed = [];
  const queue = new VisitQueue(async job => {
    active++; maxActive = Math.max(maxActive, active);
    try {
      if (!completed.length) { completed.push(job.url); await first; throw new Error('demo failure'); }
      completed.push(job.url);
    } finally { active--; }
  }, {limit:2, interval:100, now:()=>now});
  assert.equal(queue.submit(lane, url), 202);
  assert.equal(queue.submit(lane, url), 429);
  now += 100;
  assert.equal(queue.submit(lane, url), 202);
  now += 100;
  assert.equal(queue.submit(lane, url), 429);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(maxActive, 1); assert.equal(completed.length, 2);
  assert.deepEqual(queue.stats(), {active:false, queued:0, completed:1, failed:1});
  assert.equal(queue.submit(lane, url), 202);
  await new Promise(resolve => setImmediate(resolve));
  queue.close(); assert.equal(queue.submit(lane, url), 429);
});

function fakeBrowser({fail = false} = {}) {
  const contexts = [];
  return {contexts, async newContext(options) {
    const context = {options, closed:false, events:{},
      async routeWebSocket(pattern, handler) { this.socketHandler = handler; },
      async route(pattern, handler) { this.routeHandler = handler; },
      on(name, callback) { this.events[name] = callback; },
      async newPage() { return {async goto() { if (fail) throw new Error('navigation'); return {ok:()=>true}; }}; },
      async close() { this.closed = true; }};
    contexts.push(context); return context;
  }};
}

test('each visit gets a fresh anonymous context, always closed on success or failure', async () => {
  const browser = fakeBrowser();
  const job = {lane, url:target(url, lane)};
  await visit(browser, job, 0); await visit(browser, job, 0);
  assert.equal(browser.contexts.length, 2);
  assert.notEqual(browser.contexts[0], browser.contexts[1]);
  for (const context of browser.contexts) {
    assert.equal(context.closed, true); assert.equal(context.options.serviceWorkers, 'block');
    assert.equal(context.options.acceptDownloads, false);
    let closed = false; context.socketHandler({close:()=>{closed=true;}}); assert.equal(closed, true);
  }
  const failing = fakeBrowser({fail:true});
  await assert.rejects(visit(failing, job, 0)); assert.equal(failing.contexts[0].closed, true);
});

test('routing aborts denied requests without fetching; permitted responses cannot redirect or set cookies', async () => {
  const browser = fakeBrowser(); await visit(browser, {lane, url:target(url, lane)}, 0);
  const handler = browser.contexts[0].routeHandler;
  const calls = [];
  const route = requestUrl => ({request:()=>({url:()=>requestUrl, method:()=>'GET', headers:()=>({cookie:'forbidden', authorization:'forbidden'})}),
    abort:async reason=>calls.push(['abort', reason]),
    fetch:async options=>{calls.push(['fetch', options]); return {ok:()=>true, headers:()=>({'set-cookie':'forbidden', location:'http://example.invalid/'})};},
    fulfill:async options=>calls.push(['fulfill', options])});
  await handler(route('http://example.invalid/search'));
  assert.deepEqual(calls, [['abort', 'blockedbyclient']]); calls.length = 0;
  await handler(route(lane.internalOrigin + '/search'));
  assert.equal(calls[0][0], 'fetch'); assert.equal(calls[0][1].maxRedirects, 0);
  assert.equal(calls[0][1].headers.cookie, ''); assert.equal(calls[0][1].headers.authorization, '');
  assert.equal(calls[1][0], 'fulfill'); assert.equal(calls[1][1].headers['set-cookie'], undefined);
  assert.equal(calls[1][1].headers.location, undefined);
  calls.length = 0;
  const redirect = route(lane.internalOrigin + '/search');
  redirect.fetch = async()=>({ok:()=>false});
  await handler(redirect); assert.deepEqual(calls, [['abort', 'blockedbyclient']]);
});
