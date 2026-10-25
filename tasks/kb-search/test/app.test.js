import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {configuration, createApp} from '../server.js';
import {catalog, search, issueSession, validSession} from '../lib.js';
import {VisitQueue} from '../../kb-search-bot/policy.js';

function config(mode) {
  return configuration({MODE:mode, COOKIE_NAME:'kb_demo_' + mode.toLowerCase(),
    SESSION_SECRET:'demo_session_secret_' + mode.repeat(8), DEMO_LOGIN_CODE:'demo_login_' + mode.repeat(10),
    DEMO_FLAG:`KB2CTF{demo_kb_${mode.toLowerCase()}_search}`, PUBLIC_ORIGIN:'http://127.0.0.1:18084'});
}
async function app(t, mode, queue) {
  const settings = config(mode);
  const server = createApp(settings, queue);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  settings.publicOrigin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return {settings, get:(path, opts) => fetch(settings.publicOrigin + path, opts)};
}
function form(settings, values) {
  return {method:'POST', redirect:'manual', headers:{Origin:settings.publicOrigin, 'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams(values)};
}

test('configuration requires local demo values', () => {
  assert.equal(config('DOM').mode, 'DOM');
  assert.throws(() => configuration({MODE:'UNKNOWN'}));
  for (const publicOrigin of ['https://127.0.0.1:18084', 'http://example.com', 'http://127.0.0.1:18084/path']) {
    const c = config('DOM');
    assert.throws(() => configuration({MODE:'DOM', COOKIE_NAME:c.cookie, SESSION_SECRET:c.secret,
      DEMO_LOGIN_CODE:c.login, DEMO_FLAG:c.flag, PUBLIC_ORIGIN:publicOrigin}));
  }
});

for (const mode of ['REFLECTED', 'DOM']) {
  test(`${mode}: home, form, assets and unknown routes`, async t => {
    const {get} = await app(t, mode);
    const home = await get('/');
    const html = await home.text();
    assert.match(html, /KB2CTF Web Lab/);
    assert.match(html, /action="\/report"/);
    assert.ok(catalog.every(a => html.includes(a.title)));
    for (const path of ['/static/search.js', '/static/styles.css', '/catalog.json', '/healthz']) assert.equal((await get(path)).status, 200);
    assert.equal((await get('/missing')).status, 404);
    assert.equal((await get('/static/missing.js')).status, 404);
    assert.match(home.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(home.headers.get('cache-control'), 'no-store');
  });

  test(`${mode}: ordinary search, empty, Cyrillic, no matches and escaped markup`, async t => {
    const {get} = await app(t, mode);
    const baseline = await (await get('/search')).text();
    for (const query of ['', 'браузер', 'HTTP', 'нет такой статьи 987', '<b>текст</b>']) {
      const html = await (await get('/search?' + new URLSearchParams({q:query}))).text();
      if (mode === 'DOM') { assert.equal(html, baseline); continue; }
      assert.ok(!html.includes('<b>текст</b>'));
      if (query.startsWith('<')) assert.ok(html.includes('&lt;b&gt;текст&lt;/b&gt;'));
      const matches = search(query);
      assert.equal(html.includes('Ничего не найдено.'), matches.length === 0);
      for (const article of catalog) assert.equal(html.includes(article.title), matches.some(a => a.id === article.id));
    }
    assert.equal((await get('/search?q=' + 'a'.repeat(1001))).status, mode === 'DOM' ? 200 : 400);
  });

  test(`${mode}: profile accepts only its own unexpired signed cookie`, async t => {
    const {get, settings} = await app(t, mode);
    for (const cookie of ['', `${settings.cookie}=fake`, `${settings.cookie}=${issueSession(mode === 'DOM' ? 'REFLECTED' : 'DOM', settings.secret)}`,
      `${settings.cookie}=${issueSession(mode, 'another_secret')}`, `${settings.cookie}=${issueSession(mode, settings.secret, Date.now() - 700000)}`]) {
      const response = await get('/profile', {headers:{cookie}});
      assert.equal(response.status, 401);
      assert.ok(!(await response.text()).includes(settings.flag));
    }
    const login = await get('/demo-login', form(settings, {code:settings.login}));
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/profile');
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const profile = await get('/profile', {headers:{cookie:cookie.split(';')[0]}});
    assert.equal(profile.status, 200); assert.ok((await profile.text()).includes(settings.flag));
  });

  test(`${mode}: report accepted, rate limited and never includes user URL in response`, async t => {
    const visits = [];
    const queue = new VisitQueue(async job => { visits.push(job); });
    const {get, settings} = await app(t, mode, queue);
    const url = settings.publicOrigin + '/search?q=unique-report-value#q=fragment';
    const response = await get('/report', form(settings, {url}));
    assert.equal(response.status, 202);
    const body = await response.text();
    assert.match(body, /Ссылка принята/); assert.ok(!body.includes('unique-report-value'));
    assert.equal(visits[0].url, 'http://127.0.0.1:8080/search?q=unique-report-value#q=fragment');
    assert.equal((await get('/report', form(settings, {url}))).status, 429);
  });

  test(`${mode}: report rejects external links and cross-origin submissions`, async t => {
    const queue = new VisitQueue(async () => assert.fail('Must not visit'));
    const {get, settings} = await app(t, mode, queue);
    const denied = form(settings, {url:'http://example.invalid/search'});
    denied.headers.Origin = 'http://example.invalid';
    assert.equal((await get('/report', denied)).status, 403);
    assert.equal((await get('/report', form(settings, {url:'http://example.invalid/search'}))).status, 400);
    assert.equal((await get('/demo-login', form(settings, {code:'wrong'}))).status, 403);
  });
}

test('sessions do not share keys, audience or expiration', () => {
  const reflected = config('REFLECTED'), dom = config('DOM');
  const token = issueSession(reflected.mode, reflected.secret, 1000);
  assert.equal(validSession(token, reflected.mode, reflected.secret, 2000), true);
  assert.equal(validSession(token, dom.mode, dom.secret, 2000), false);
  assert.equal(validSession(token, reflected.mode, reflected.secret, 601001), false);
  assert.equal(validSession(token + '.extra', reflected.mode, reflected.secret, 2000), false);
});

// A DOM harness catches accidental HTML sinks and compares the client search with
// the real server catalog for the same inputs, without running untrusted markup.
class Element {
  constructor(tag = '') { this.tag = tag; this.children = []; this.events = {}; this.textContent = ''; }
  set innerHTML(_) { throw new Error('HTML sink forbidden'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.events[name] = callback; }
}
test('DOM fragment search matches server behavior and writes only text', async () => {
  const script = readFileSync(new URL('../static/search.js', import.meta.url), 'utf8');
  for (const query of ['', 'браузер', 'HTTP', 'нет такой статьи 987', '<b>текст</b>']) {
    const nodes = Object.fromEntries(['query', 'search-form', 'query-label', 'results'].map(id => [id, new Element()]));
    const location = {hash:'#' + new URLSearchParams({q:query}), assign:()=>{}};
    const context = {URLSearchParams, location, document:{body:{dataset:{mode:'DOM', search:'true'}},
      getElementById:id=>nodes[id], createElement:tag=>new Element(tag)},
      window:{addEventListener:()=>{}}, fetch:async()=>({ok:true, json:async()=>catalog})};
    vm.runInNewContext(script, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes.query.value, query);
    assert.equal(nodes['query-label'].textContent, 'Запрос: ' + query);
    const matches = search(query);
    const children = nodes.results.children[0].children;
    assert.deepEqual(children.map(a => a.children[0].textContent), matches.map(a => a.title));
    if (!matches.length) assert.equal(nodes.results.children[0].textContent, 'Ничего не найдено.');
    let destination;
    location.assign = url => { destination = url; };
    nodes['search-form'].events.submit({preventDefault:()=>{}});
    assert.equal(destination, '/search#' + new URLSearchParams({q:query}));
  }
});
