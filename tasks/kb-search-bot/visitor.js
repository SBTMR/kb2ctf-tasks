import {setTimeout as pause} from 'node:timers/promises';
import {allowedRequest} from './policy.js';

export async function visit(browser, {lane, url}, dwell = 5000) {
  // Deliberately anonymous: no credentials or session material enter this context.
  const context = await browser.newContext({acceptDownloads:false, serviceWorkers:'block',
    permissions:[], javaScriptEnabled:true});
  try {
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      const request = route.request();
      if (!allowedRequest(request.url(), request.method(), lane)) return route.abort('blockedbyclient');
      try {
        // Fetch without redirects: a permitted URL must not redirect to a denied origin.
        const response = await route.fetch({maxRedirects:0, timeout:4000,
          headers:{...request.headers(), cookie:'', authorization:''}});
        if (!response.ok()) return route.abort('blockedbyclient');
        const headers = {...response.headers()};
        delete headers['set-cookie']; delete headers.location;
        await route.fulfill({response, headers});
      } catch { await route.abort('failed').catch(() => {}); }
    });
    let page;
    context.on('page', opened => {
      opened.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      opened.on('download', download => download.cancel().catch(() => {}));
      if (page && opened !== page) void opened.close().catch(() => {});
    });
    page = await context.newPage();
    const response = await page.goto(url, {waitUntil:'load', timeout:7000});
    if (!response?.ok()) throw new Error('Visit unavailable');
    await pause(dwell);
  } finally { await context.close(); }
}
