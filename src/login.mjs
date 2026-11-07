/** Opens a real browser window on bulk.com: the USER signs in there. We never see or ask for the password. */
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getConfig, SITE, STORE_PATH } from './config.mjs';
import { SessionStore, extractSession } from './auth.mjs';
import { BulkClient } from './client.mjs';

const config = getConfig();
const session = new SessionStore(config.sessionPath);
if (process.argv.includes('--logout')) { await session.clear(); console.log('Sessione locale rimossa.'); process.exit(0); }

const { chromium } = await import('playwright');
await fs.mkdir(config.profilePath, { recursive: true, mode: 0o700 });
const fromProfile = process.argv.includes('--from-profile');
const context = await chromium.launchPersistentContext(config.profilePath, { headless: fromProfile,
  ...(config.channel === 'chrome' ? { channel: 'chrome' } : {}), ...(config.browserExecutable ? { executablePath: config.browserExecutable } : {}) });
try {
  const page = context.pages()[0] ?? await context.newPage();
  if (fromProfile) {
    // Re-captures the session the browser profile already holds (no window, no interaction).
    await page.goto(`${SITE}${STORE_PATH}/customer/account`, { waitUntil: 'domcontentloaded' });
  } else {
    await page.goto(`${SITE}${STORE_PATH}/customer/account/login`, { waitUntil: 'domcontentloaded' });
    console.log('Accedi al tuo account Bulk nella finestra del browser (se sei già dentro, non serve rifarlo).');
    const rl = createInterface({ input, output });
    try { await rl.question('Quando vedi il tuo account, torna qui e premi INVIO: '); } finally { rl.close(); }
  }
  const { entries, hasSession } = await extractSession(context);
  const cookie = entries.map(([k, v]) => `${k}=${v}`).join('; ');
  const status = hasSession ? await new BulkClient({ getSession: () => cookie }).verifyCustomer() : 'guest';
  if (status === 'verified') { await session.set(entries); console.log('Account Bulk verificato. Sessione salvata in locale (cookie mai mostrati).'); }
  else { console.log(`Bulk non ha confermato l'account (${status}). Nulla è stato salvato: completa il login nel browser e riprova.`); process.exitCode = 1; }
} finally { await context.close(); }
