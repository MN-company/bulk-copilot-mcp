import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Bulk signs customers in with the classic Magento session (PHPSESSID on path /it), and its
 * GraphQL endpoint honours that session. We keep the site's cookies in a local 0600 file and
 * send them as a Cookie header; values are never logged or returned by any tool.
 */
export class SessionStore {
  constructor(file) { this.file = file; this.cache = undefined; }
  async get() {
    if (this.cache !== undefined) return this.cache;
    try {
      const j = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.cache = j.cookies?.length ? j.cookies.map(([k, v]) => `${k}=${v}`).join('; ') : null;
    } catch { this.cache = null; }
    return this.cache;
  }
  async set(entries) {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, JSON.stringify({ savedAt: new Date().toISOString(), cookies: entries }), { mode: 0o600 });
    this.cache = entries.map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async clear() { await fs.rm(this.file, { force: true }); this.cache = null; }
}

/** Cookies of bulk.com as the store-view path /it/ sees them (PHPSESSID is scoped to /it). */
export async function extractSession(context) {
  const cookies = (await context.cookies('https://www.bulk.com/it/')).filter(c => /(^|\.)bulk\.com$/.test(c.domain));
  // When a name exists at several paths, the most specific path wins, as in the browser.
  cookies.sort((a, b) => b.path.length - a.path.length);
  const seen = new Set(), entries = [];
  for (const c of cookies) if (!seen.has(c.name)) { seen.add(c.name); entries.push([c.name, c.value]); }
  return { entries, hasSession: seen.has('PHPSESSID') };
}
