export async function ensureSession(request, appOrigin, password) {
  const response = await request.get(appOrigin + '/api/me', {timeout: 5000, maxRedirects: 0});
  if (response.status() === 200 && (await response.json()).username === 'meme-reader') return false;
  const login = await request.post(appOrigin + '/login', {
    form: {username: 'meme-reader', password}, timeout: 5000, maxRedirects: 0,
  });
  if (login.status() !== 303) throw new Error('Bot login failed');
  return true;
}
