import http from 'node:http';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {catalog, escape, search, equal, issueSession, validSession, readBody} from './lib.js';
import {VisitQueue} from '../kb-search-bot/policy.js';
import {visit} from '../kb-search-bot/visitor.js';

export function configuration(env = process.env) {
  const mode = env.MODE;
  if (!['REFLECTED', 'DOM'].includes(mode)) throw new Error('MODE must be REFLECTED or DOM');
  const config = {mode, cookie:env.COOKIE_NAME, secret:env.SESSION_SECRET, login:env.DEMO_LOGIN_CODE,
    flag:env.DEMO_FLAG, publicOrigin:env.PUBLIC_ORIGIN};
  if (!/^kb_demo_[a-z]+$/.test(config.cookie || '') || [config.secret, config.login].some(v => !v || v.length < 32) ||
      !/^KB2CTF\{demo_kb_[a-z_]+\}$/.test(config.flag || '')) throw new Error('Demo configuration missing or invalid');
  const origin = new URL(config.publicOrigin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== config.publicOrigin) throw new Error('Loopback origin required');
  return config;
}

function articles(items) {
  return items.length ? '<div class="grid">' + items.map(a => `<article class="card"><h2>${escape(a.title)}</h2><p>${escape(a.body)}</p></article>`).join('') + '</div>' : '<p class="empty">Ничего не найдено.</p>';
}
function page(config, {query = '', searching = false, message = '', profile = ''} = {}) {
  const serverMode = config.mode === 'REFLECTED';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Поиск ${config.mode} · KB2CTF Web Lab</title><link rel="stylesheet" href="/static/styles.css"><script defer src="/static/search.js"></script></head>
<body data-mode="${config.mode}" data-search="${searching}"><header><strong><a href="/">KB2CTF Web Lab</a></strong><span>База знаний · ${config.mode}</span><a href="/profile">Демо-профиль</a></header>
<main><p class="eyebrow">ЛОКАЛЬНЫЙ УЧЕБНЫЙ СТЕНД</p><h1>Найдите ответ в базе знаний</h1><p class="lead">Одинаковый поиск, два места обработки данных.</p>
<aside class="card notice">Безопасная демонстрация: HTML экранируется, DOM использует textContent. Внедрённый код не выполняется. Бот посещает страницы без сессии.</aside>
<form id="search-form" action="/search" method="get"><label>Поисковый запрос<input id="query" name="q" maxlength="1000" value="${escape(serverMode ? query : '')}" placeholder="Например, браузер"></label><button>Найти</button></form>
<section aria-live="polite"><h2>${searching ? 'Результаты поиска' : 'Каталог статей'}</h2><p id="query-label">${searching && serverMode ? 'Запрос: ' + escape(query) : ''}</p><div id="results">${articles(searching && serverMode ? search(query) : catalog)}</div></section>
<section class="card"><h2>Где обрабатывается запрос</h2><p>${serverMode ? 'Query-параметр q приходит на сервер. Сервер формирует и экранирует результат в HTTP-ответе.' : 'Fragment #q остаётся в браузере. Клиентский скрипт читает location.hash и выводит текст. HTTP-ответ не зависит от fragment.'}</p><p>Сравните ответ во вкладке Network и итоговый DOM во вкладке Elements.</p></section>
${profile}<section class="card"><h2>Отправить ссылку модератору</h2><p>Принимаются только ссылки на /search этого приложения. Посещение длится 5 секунд.</p>
<form action="/report" method="post"><label>Локальная ссылка<input type="url" name="url" maxlength="4096" required placeholder="${escape(config.publicOrigin)}/search"></label><button>Отправить ссылку</button></form>${message ? `<p role="status">${escape(message)}</p>` : ''}</section>
</main><footer>Только демонстрационные данные · Сессия действует 10 минут</footer></body></html>`;
}

export function createApp(config, queue) {
  let nextReport = 0, nextLogin = 0;
  const assets = new Map(['search.js', 'styles.css'].map(name => [name, readFileSync(new URL('./static/' + name, import.meta.url))]));
  return http.createServer({requestTimeout:10000, headersTimeout:5000, maxHeaderSize:8192}, async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    function send(status, body, type = 'text/html; charset=utf-8') {
      res.writeHead(status, {'Content-Type':type}); res.end(body);
    }
    try {
      const url = new URL(req.url, config.publicOrigin);
      const p = url.pathname;
      if (req.method === 'GET' && p === '/healthz') return send(200, JSON.stringify({status:'ready', bot:queue?.stats()}), 'application/json');
      if (req.method === 'GET' && p.startsWith('/static/')) {
        const name = p.slice(8);
        return assets.has(name) ? send(200, assets.get(name), name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8') : send(404, 'Не найдено');
      }
      if (req.method === 'GET' && p === '/catalog.json') return send(200, JSON.stringify(catalog), 'application/json; charset=utf-8');
      if (req.method === 'GET' && (p === '/' || p === '/search')) {
        const query = config.mode === 'REFLECTED' && p === '/search' ? url.searchParams.get('q') || '' : '';
        if (query.length > 1000) return send(400, 'Запрос слишком длинный.');
        return send(200, page(config, {query, searching:p === '/search'}));
      }
      if (req.method === 'GET' && p === '/profile') {
        const cookies = (req.headers.cookie || '').split(';').map(c => c.trim().split('='));
        const token = cookies.find(([key]) => key === config.cookie)?.[1];
        const valid = validSession(token, config.mode, config.secret);
        const profile = valid ? `<section class="card"><h2>Демо-профиль</h2><p>Флаг: <code id="demo-flag">${escape(config.flag)}</code></p></section>` :
          '<section class="card"><h2>Демо-вход</h2><p>Введите учебный код из локального .env. Он не передаётся боту.</p><form action="/demo-login" method="post"><label>Учебный код<input name="code" type="password" maxlength="200" required autocomplete="off"></label><button>Открыть демо-профиль</button></form></section>';
        return send(valid ? 200 : 401, page(config, {profile}));
      }
      if (req.method === 'POST' && ['/report', '/demo-login'].includes(p)) {
        if (req.headers.origin !== config.publicOrigin || !(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) return send(403, 'Отправьте форму со страницы этого приложения.');
        const form = new URLSearchParams(await readBody(req));
        if (p === '/demo-login') {
          if (Date.now() < nextLogin) return send(429, 'Повторите вход через 2 секунды.');
          nextLogin = Date.now() + 2000;
          if (!equal(form.get('code') || '', config.login)) return send(403, 'Неверный учебный код.');
          res.setHeader('Set-Cookie', `${config.cookie}=${issueSession(config.mode, config.secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600`);
          res.writeHead(303, {Location:'/profile'}); return res.end();
        }
        if (Date.now() < nextReport) return send(429, page(config, {message:'Подождите 3 секунды перед повторной отправкой.'}));
        nextReport = Date.now() + 3000;
        try {
          if (!queue) throw new Error('bot-unavailable');
          let status;
          try {
            status = queue.submit({id:config.mode, publicOrigin:config.publicOrigin, internalOrigin:'http://127.0.0.1:8080'}, form.get('url') || '');
          } catch { status = 400; }
          const messages = {202:'Ссылка принята. Бот посетит её по очереди.', 400:'Нужна ссылка на /search этого локального приложения.', 429:'Очередь занята. Повторите отправку позже.'};
          return send(messages[status] ? status : 503, page(config, {message:messages[status] || 'Бот временно недоступен. Повторите позже.'}));
        } catch { return send(503, page(config, {message:'Бот временно недоступен. Повторите позже.'})); }
      }
      send(404, 'Не найдено');
    } catch { if (!res.headersSent) send(400, 'Некорректный запрос.'); else res.end(); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {chromium} = await import('playwright');
  let browser, stopping = false;
  const queue = new VisitQueue(async job => {
    if (!browser?.isConnected()) browser = await chromium.launch({headless:true, chromiumSandbox:true,
      ignoreDefaultArgs:['--disable-dev-shm-usage'], timeout:20000,
      args:['--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--disable-domain-reliability', '--no-first-run', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--host-resolver-rules=MAP * ~NOTFOUND']});
    if (stopping) { await browser.close(); throw new Error('Stopping'); }
    try { await visit(browser, job); }
    catch { await browser.close().catch(() => {}); browser = undefined; throw new Error('Visit failed'); }
  });
  const server = createApp(configuration(), queue);
  server.listen(8080, '0.0.0.0');
  const stop = async () => { stopping = true; queue.close(); server.close(); server.closeAllConnections(); await browser?.close().catch(() => {}); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
