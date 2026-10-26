import express from 'express';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store, MEMES, BOT_NAME, SESSION_TTL, hashPassword, checkPassword} from './store.js';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
export const COOKIE = 'kb2ctf_xss_session';
const cookieOptions = {httpOnly: false, sameSite: 'strict', secure: false, path: '/'};

function sessionCookie(req) {
  const piece = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(COOKIE + '='));
  return piece ? piece.slice(COOKIE.length + 1) : null;
}

function credentials(body) {
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') return null;
  const username = body.username.trim();
  if (!username || username.length > 48 || body.password.length < 8 || body.password.length > 128) return null;
  return {username, password: body.password};
}

function content(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
}

export async function createForum({directory, botPassword, flag, clock = Date.now}) {
  if (typeof botPassword !== 'string' || botPassword.length < 32 || !/^KB2CTF\{[a-zA-Z0-9_-]+\}$/.test(flag)) {
    throw new Error('Invalid local configuration');
  }
  const store = await Store.open(directory, botPassword, clock);
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', join(APP_DIR, 'views'));
  app.use(express.urlencoded({extended: false, limit: '16kb', parameterLimit: 12}));
  app.use('/assets', express.static(join(APP_DIR, 'assets')));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    res.locals.user = store.userFor(sessionCookie(req));
    next();
  });

  const feed = (res, error = null, status = 200) => res.status(status).render('feed', {posts: store.feed(), memes: MEMES, error});
  const requireUser = (req, res, next) => {
    if (!res.locals.user) return res.status(401).render('auth', {mode: 'login', error: 'Войдите, чтобы продолжить.'});
    next();
  };

  app.get('/healthz', (_req, res) => res.json({status: 'ready'}));
  app.get('/', (_req, res) => feed(res));
  app.get('/register', (_req, res) => res.render('auth', {mode: 'register', error: null}));
  app.get('/login', (_req, res) => res.render('auth', {mode: 'login', error: null}));

  app.post('/register', async (req, res) => {
    const values = credentials(req.body);
    if (!values || values.username === BOT_NAME) {
      return res.status(400).render('auth', {mode: 'register', error: 'Имя: 1–48 символов; пароль: 8–128. Это имя может быть недоступно.'});
    }
    const passwordHash = await hashPassword(values.password);
    const added = await store.mutate(state => {
      if (state.users.some(user => user.username === values.username) || state.users.length >= 100) return false;
      state.users.push({id: randomUUID(), username: values.username, passwordHash, bot: false});
      return true;
    });
    if (!added) return res.status(409).render('auth', {mode: 'register', error: 'Это имя уже занято или достигнут лимит аккаунтов.'});
    res.redirect(303, '/login');
  });

  app.post('/login', async (req, res) => {
    const values = credentials(req.body);
    const user = values && store.state.users.find(item => item.username === values.username);
    if (!user || !await checkPassword(values.password, user.passwordHash)) {
      return res.status(401).render('auth', {mode: 'login', error: 'Неверные учётные данные.'});
    }
    await store.logout(sessionCookie(req));
    // Intentional teaching setting: the session cookie can be read by page JavaScript.
    res.cookie(COOKIE, await store.sessionFor(user), {...cookieOptions, maxAge: SESSION_TTL});
    res.redirect(303, '/');
  });

  app.post('/logout', async (req, res) => {
    await store.logout(sessionCookie(req));
    res.clearCookie(COOKIE, cookieOptions);
    res.redirect(303, '/login');
  });

  app.get('/api/me', (req, res) => {
    const user = store.userFor(sessionCookie(req));
    if (!user) return res.status(401).json({authenticated: false});
    res.json({authenticated: true, username: user.username});
  });

  app.get('/profile', (req, res) => {
    const user = store.userFor(sessionCookie(req));
    if (!user) return res.redirect('/login');
    res.render('profile', {flag: user.bot === true ? flag : null});
  });

  app.post('/posts', requireUser, async (req, res) => {
    if (!MEMES.some(meme => meme.id === req.body?.memeId) || !content(req.body?.caption)) {
      return feed(res, 'Выберите картинку и добавьте подпись длиной до 2000 символов.', 400);
    }
    const id = randomUUID();
    const added = await store.mutate(state => {
      if (state.posts.length >= 100) return false;
      state.posts.push({id, authorId: res.locals.user.id, memeId: req.body.memeId,
        caption: req.body.caption, createdAt: new Date(clock()).toISOString(), comments: []});
      return true;
    });
    if (!added) return feed(res, 'Лимит форума: 100 постов. Можно сбросить локальную задачу.', 409);
    res.redirect(303, '/#post-' + id);
  });

  app.post('/posts/:id/comments', requireUser, async (req, res) => {
    if (!content(req.body?.body)) return feed(res, 'Нужен комментарий длиной до 2000 символов.', 400);
    const status = await store.mutate(state => {
      const post = state.posts.find(item => item.id === req.params.id);
      if (!post) return 404;
      if (post.comments.length >= 20) return 409;
      post.comments.push({id: randomUUID(), authorId: res.locals.user.id,
        body: req.body.body, createdAt: new Date(clock()).toISOString()});
      return 303;
    });
    if (status !== 303) return feed(res, 'Пост недоступен или достигнут лимит комментариев.', status);
    res.redirect(303, '/#post-' + req.params.id);
  });

  app.use((_req, res) => res.status(404).render('error', {message: 'Страница не найдена.'}));
  app.use((error, _req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413 : error.status === 400 ? 400 : 503;
    res.status(status).render('error', {message: status === 413 ? 'Запрос слишком большой.' : 'Не удалось обработать запрос.'});
  });
  return {app, store};
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    const {app} = await createForum({directory: process.env.STATE_DIR || '/var/lib/lab/xss',
      botPassword: 'kb2ctf_meme_reader_demo_password_2026',
      flag: 'KB2CTF{xss_demo}'});
    const server = app.listen(8080, '0.0.0.0', () => console.log('Meme Forum ready'));
    server.requestTimeout = 10000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 5000;
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (error) {
    const reasons = {
      EACCES: 'State directory is not writable by uid 10001.',
      EPERM: 'State directory access denied.',
      EROFS: 'State directory is read-only; check the xss_data volume.',
      ENOSPC: 'No space left for forum state.',
    };
    const detail = reasons[error.code] || (error instanceof SyntaxError
      ? 'state.json contains invalid JSON.'
      : ['Invalid forum state', 'Bot account missing from forum state', 'Invalid local configuration'].includes(error.message)
        ? error.message : 'Unexpected initialization error; check the state volume.');
    console.error('Forum startup failed: ' + detail);
    process.exit(1);
  }
}
