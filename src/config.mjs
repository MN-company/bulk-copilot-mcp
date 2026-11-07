import os from 'node:os';
import path from 'node:path';

export const SITE = 'https://www.bulk.com';
export const STORE_PATH = '/it';
export const GRAPHQL_URL = `${SITE}${STORE_PATH}/graphql/`;
export const STORE_VIEW = 'bp_italy_view';

export function getConfig(env = process.env) {
  const dataDir = env.BULK_DATA_DIR || path.join(os.homedir(), '.bulk-copilot');
  return {
    dataDir,
    dbPath: env.BULK_DB_PATH || path.join(dataDir, 'agent.sqlite'),
    sessionPath: path.join(dataDir, 'session-cookies.json'),
    profilePath: env.BULK_PROFILE_DIR || path.join(dataDir, 'browser-profile'),
    channel: env.BROWSER_CHANNEL || '',
    browserExecutable: env.BROWSER_EXECUTABLE || '',
    port: Number(env.PORT || 3789),
    bindHost: env.BIND_HOST || '127.0.0.1',
    allowCartWrites: env.ALLOW_CART_WRITES !== 'false',
    minIntervalMs: Number(env.BULK_MIN_INTERVAL_MS || 600),
    planTtlMs: 15 * 60 * 1000
  };
}
