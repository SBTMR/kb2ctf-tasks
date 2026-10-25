import {randomBytes, randomUUID, scrypt as deriveKey, timingSafeEqual, createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdir, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';

const scrypt = promisify(deriveKey);
export const BOT_NAME = 'meme-reader';
export const SESSION_TTL = 2 * 60 * 60 * 1000;
// Keep the first three IDs stable so existing posts survive a gallery update.
export const MEMES = [
  {id: 'deadline', title: 'Тунг Тунг Сахур', file: 'tung-sahur.png', width: 700, height: 700},
  {id: 'buttons', title: 'Роберт Паттинсон', file: 'pattinson.png', width: 750, height: 1000},
  {id: 'cat', title: 'Когда разбираешься в маршрутизации', file: 'network-routing.png', width: 848, height: 1280},
  {id: 'battle', title: 'Сетевые технологии в баттл-рэпе', file: 'minecraft-battle.png', width: 853, height: 1280},
  {id: 'writer', title: 'Пишу документацию', file: 'writer.png', width: 403, height: 496},
  {id: 'schedule', title: 'График работы', file: 'work-schedule.png', width: 1280, height: 1006},
  {id: 'worm', title: 'Червь в корпоративной сети', file: 'corporate-worm.png', width: 1280, height: 1022},
];

const DEMO_CONTENT = {
  deadline: {
    caption: 'Когда будильник на первую пару стал слишком убедительным.',
    comments: ['С таким будильником точно не проспишь.', 'Главное — не будить весь корпус.'],
  },
  buttons: {
    caption: 'Новый коллега уже готов к ежедневному созвону.',
    comments: ['На всех встречах выглядит одинаково невозмутимо.', 'Зато рабочее место никогда не пустует.'],
  },
  cat: {
    caption: 'Хотел настроить одну подсеть. Нарисовал целый детектив.',
    comments: ['Теперь нужны красные нитки и ещё одна доска.', 'Чем больше стрелок, тем серьёзнее лабораторная.'],
  },
  battle: {
    caption: 'Когда на баттле внезапно началась лекция по сетям.',
    comments: ['За техническую точность — отдельные баллы.', 'Панч проверен преподавателем сетевых технологий.'],
  },
  writer: {
    caption: 'Пишу README так, будто это моя главная литературная работа.',
    comments: ['Осталось красиво описать кнопку запуска.', 'Автор FIX.md тоже вошёл во вкус.'],
  },
  schedule: {
    caption: 'График сервиса, который снова обещали починить к понедельнику.',
    comments: ['Зато обед строго по расписанию.', 'Воскресенье — заслуженный отдых после такой недели.'],
  },
  worm: {
    caption: 'Когда инвентаризация сети познакомила тебя с её старожилом.',
    comments: ['В документации его скромно назвали legacy.', 'Он ещё помнит, зачем здесь этот старый сервер.'],
  },
};

export function createDemoPosts(authorId, clock = Date.now) {
  const createdAt = new Date(clock()).toISOString();
  return MEMES.map(meme => ({
    id: randomUUID(), authorId, memeId: meme.id, caption: DEMO_CONTENT[meme.id].caption, createdAt,
    comments: DEMO_CONTENT[meme.id].comments.map(body => ({id: randomUUID(), authorId, body, createdAt})),
  }));
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

export async function checkPassword(password, encoded) {
  if (typeof encoded !== 'string' || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded)) return false;
  const [salt, stored] = encoded.split(':');
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(stored, 'hex'));
}

const tokenHash = token => createHash('sha256').update(token).digest('hex');

export class Store {
  constructor(directory, state, clock = Date.now) {
    this.directory = directory;
    this.state = state;
    this.clock = clock;
    this.queue = Promise.resolve();
  }

  static async open(directory, botPassword, clock = Date.now) {
    await mkdir(directory, {recursive: true, mode: 0o700});
    let state;
    let refreshBotPassword = false;
    try {
      state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.users) || !Array.isArray(state.posts) || !Array.isArray(state.sessions)) {
        throw new Error('Invalid forum state');
      }
      const bot = state.users.find(user => user.username === BOT_NAME && user.bot === true);
      if (!bot) throw new Error('Bot account missing from forum state');
      refreshBotPassword = !await checkPassword(botPassword, bot.passwordHash);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const bot = {id: randomUUID(), username: BOT_NAME, passwordHash: await hashPassword(botPassword), bot: true};
      state = {version: 1, users: [bot], sessions: [], posts: createDemoPosts(bot.id, clock)};
      await writeFile(join(directory, 'state.json'), JSON.stringify(state), {mode: 0o600});
    }
    const store = new Store(directory, state, clock);
    if (refreshBotPassword) {
      const passwordHash = await hashPassword(botPassword);
      await store.mutate(next => {
        const bot = next.users.find(user => user.username === BOT_NAME && user.bot === true);
        bot.passwordHash = passwordHash;
        next.sessions = next.sessions.filter(session => session.userId !== bot.id);
      });
    }
    return store;
  }

  mutate(operation) {
    const work = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = await operation(next);
      const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(next), {mode: 0o600});
        await rename(temporary, join(this.directory, 'state.json'));
        this.state = next;
        return result;
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }

  userFor(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const session = this.state.sessions.find(item => item.hash === tokenHash(token) && item.expiresAt > this.clock());
    return session ? this.state.users.find(user => user.id === session.userId) || null : null;
  }

  async sessionFor(user) {
    const token = randomBytes(32).toString('hex');
    await this.mutate(state => {
      state.sessions = state.sessions.filter(item => item.expiresAt > this.clock()).slice(-499);
      state.sessions.push({hash: tokenHash(token), userId: user.id, expiresAt: this.clock() + SESSION_TTL});
    });
    return token;
  }

  async logout(token) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
    await this.mutate(state => {state.sessions = state.sessions.filter(item => item.hash !== tokenHash(token));});
  }

  feed() {
    const names = new Map(this.state.users.map(user => [user.id, user.username]));
    return [...this.state.posts].reverse().map(post => ({...post,
      author: names.get(post.authorId) || 'Участник',
      meme: MEMES.find(meme => meme.id === post.memeId),
      comments: post.comments.map(comment => ({...comment, author: names.get(comment.authorId) || 'Участник'})),
    }));
  }
}
