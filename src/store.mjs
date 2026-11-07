import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Local state: guest cart id, cart plans (prepare/commit), audit log, observed prices. */
export class AgentStore {
  constructor(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        status TEXT NOT NULL, phrase TEXT NOT NULL, cart_fingerprint TEXT NOT NULL, ops TEXT NOT NULL, summary TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, event TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS prices(sku TEXT NOT NULL, at INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY(sku, at));`);
  }
  get(key, fallback = null) { const r = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return r ? JSON.parse(r.value) : fallback; }
  set(key, value) {
    if (value === null || value === undefined) this.db.prepare('DELETE FROM kv WHERE key=?').run(key);
    else this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  audit(event, data) { this.db.prepare('INSERT INTO audit(at,event,data) VALUES(?,?,?)').run(Date.now(), event, JSON.stringify(data ?? null)); }

  savePlan(p) {
    this.db.prepare('INSERT INTO plans(id,created_at,expires_at,status,phrase,cart_fingerprint,ops,summary) VALUES(?,?,?,?,?,?,?,?)')
      .run(p.id, p.createdAt, p.expiresAt, 'prepared', p.phrase, p.cartFingerprint, JSON.stringify(p.ops), JSON.stringify(p.summary));
  }
  getPlan(id) {
    const r = this.db.prepare('SELECT * FROM plans WHERE id=?').get(id);
    return r && { id: r.id, createdAt: r.created_at, expiresAt: r.expires_at, status: r.status, phrase: r.phrase, cartFingerprint: r.cart_fingerprint,
      ops: JSON.parse(r.ops), summary: JSON.parse(r.summary), result: r.result ? JSON.parse(r.result) : null };
  }
  /** Atomic prepared → executing transition: only one commit can ever win. */
  claimPlan(id) { return this.db.prepare("UPDATE plans SET status='executing' WHERE id=? AND status='prepared'").run(id).changes === 1; }
  finishPlan(id, status, result) { this.db.prepare('UPDATE plans SET status=?, result=? WHERE id=?').run(status, JSON.stringify(result ?? null), id); }

  recordPrice(sku, price) {
    if (!sku || typeof price !== 'number') return;
    const last = this.db.prepare('SELECT price FROM prices WHERE sku=? ORDER BY at DESC LIMIT 1').get(sku);
    if (!last || last.price !== price) this.db.prepare('INSERT OR IGNORE INTO prices(sku,at,price) VALUES(?,?,?)').run(sku, Date.now(), price);
  }
  priceHistory(sku) { return this.db.prepare('SELECT at, price FROM prices WHERE sku=? ORDER BY at').all(sku).map(r => ({ at: new Date(r.at).toISOString(), price: r.price })); }
  close() { this.db.close(); }
}
