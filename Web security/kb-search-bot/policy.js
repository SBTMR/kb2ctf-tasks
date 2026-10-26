export function target(value, lane) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) throw new Error('Invalid URL');
  const url = new URL(value);
  if (url.origin !== lane.publicOrigin || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/search') throw new Error('Invalid URL');
  return lane.internalOrigin + '/search' + url.search + url.hash;
}

export function allowedRequest(value, method, lane) {
  try {
    const url = new URL(value);
    return method === 'GET' && url.origin === lane.internalOrigin && !url.username && !url.password &&
      ['/search', '/catalog.json', '/static/search.js', '/static/styles.css'].includes(url.pathname);
  } catch { return false; }
}

export class VisitQueue {
  constructor(visit, {limit = 8, interval = 3000, now = Date.now} = {}) {
    this.visit = visit; this.limit = limit; this.interval = interval; this.now = now;
    this.pending = []; this.active = false; this.closed = false; this.next = new Map();
    this.completed = 0; this.failed = 0;
  }
  submit(lane, url) {
    const internal = target(url, lane);
    if (this.closed || this.pending.length + Number(this.active) >= this.limit || this.now() < (this.next.get(lane.id) || 0)) return 429;
    this.next.set(lane.id, this.now() + this.interval);
    this.pending.push({lane, url:internal});
    void this.drain();
    return 202;
  }
  async drain() {
    if (this.active || this.closed) return;
    this.active = true;
    try {
      while (this.pending.length && !this.closed) {
        const job = this.pending.shift();
        try { await this.visit(job); this.completed++; }
        catch { this.failed++; }
      }
    } finally { this.active = false; }
  }
  close() { this.closed = true; this.pending.length = 0; }
  stats() { return {active:this.active, queued:this.pending.length, completed:this.completed, failed:this.failed}; }
}
