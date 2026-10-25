import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';

export const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
export const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const search = query => {
  const q = query.trim().toLocaleLowerCase('ru');
  return catalog.filter(a => !q || `${a.title} ${a.body}`.toLocaleLowerCase('ru').includes(q));
};
export function equal(left, right) {
  const a = Buffer.from(String(left)), b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
export function issueSession(mode, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({aud:mode, exp:now + 600000, nonce:randomBytes(16).toString('hex')})).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
export function validSession(token, mode, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 512) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!equal(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.aud === mode && Number.isFinite(data.exp) && data.exp > now && data.exp <= now + 600000;
  } catch { return false; }
}
export async function readBody(request, limit = 8192) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('body-limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
