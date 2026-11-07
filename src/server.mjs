/** LOCAL ONLY. Streamable HTTP MCP server for bulk.com/it. */
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod/v4';
import { getConfig } from './config.mjs';
import { BulkClient, BulkError } from './client.mjs';
import { AgentStore } from './store.mjs';
import { SessionStore } from './auth.mjs';
import { CartContext, CartPlanner, freeShippingInfo } from './planner.mjs';
import { CatalogService, StorefrontConfig, yotpoBottomline } from './catalog.mjs';
import { enrichDetails, nutritionFor } from './enrich.mjs';
import { DIETS, EMPTY_PREFS, mergePrefs, quickFlags, removePrefs } from './preferences.mjs';

export const VERSION = '0.2.0';
const config = getConfig();
const store = new AgentStore(config.dbPath);
const session = new SessionStore(config.sessionPath);
const client = new BulkClient({ getSession: () => session.get(), minIntervalMs: config.minIntervalMs });
const storefront = new StorefrontConfig();
const catalog = new CatalogService(storefront);
const cartContext = new CartContext(client, store, session);
const planner = new CartPlanner({ client, store, cartContext, ttlMs: config.planTtlMs, writesEnabled: config.allowCartWrites,
  freeShippingThreshold: () => storefront.freeShippingThreshold() });
const prefs = () => store.get('preferences', EMPTY_PREFS);

const textResult = (data, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], isError });
function safeTool(fn) {
  return async params => {
    try { return textResult(await fn(params ?? {})); }
    catch (e) {
      if (e instanceof BulkError) return textResult({ error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) }, true);
      console.error('Bulk tool error (details suppressed)');
      return textResult({ error: 'INVALID_OPERATION', message: 'Operazione non valida. Nessuna modifica confermata.' }, true);
    }
  };
}
const read = { readOnlyHint: true, openWorldHint: true };
const localRead = { readOnlyHint: true, openWorldHint: false };
const localWrite = { readOnlyHint: false, openWorldHint: false };
const write = { readOnlyHint: false, openWorldHint: true };
const productRef = { urlKey: z.string().min(2).max(200).optional(), sku: z.string().min(2).max(80).optional() };
const SAFETY_NOTE = 'Allergeni e ingredienti vanno sempre verificati sull\'etichetta: non dichiarare mai un prodotto "sicuro".';

const cartOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), ...productRef, quantity: z.number().int().min(1).max(20),
    options: z.record(z.string().max(40), z.string().max(60)).optional()
      .describe('Varianti, es. {"Gusto":"Vaniglia","Confezione":"2kg"} (nomi da bulk_product_details)') }),
  z.object({ op: z.literal('reorder'), orderNumber: z.string().regex(/^\d{5,15}$/),
    skus: z.array(z.string().max(80)).max(30).optional().describe('Solo questi SKU dell\'ordine; se assente, tutto l\'ordine') }),
  z.object({ op: z.literal('update'), itemUid: z.string().min(1).max(100), quantity: z.number().int().min(0).max(20) }),
  z.object({ op: z.literal('remove'), itemUid: z.string().min(1).max(100) }),
  z.object({ op: z.literal('coupon_apply'), code: z.string().min(2).max(60) }),
  z.object({ op: z.literal('coupon_remove') })
]);

async function cartWithShipping() {
  const { cart, mode, cartId, auth } = await cartContext.read();
  const shipping = freeShippingInfo(cart.subtotal ?? 0, await storefront.freeShippingThreshold());
  if (cart.items.length) {
    try { shipping.options = await client.estimateShipping(cartId, auth); shipping.optionsFor = 'Italia (stima, nessun indirizzo salvato)'; }
    catch { shipping.options = null; }
  }
  return { cartMode: mode, ...cart, shipping };
}

function makeServer() {
  const server = new McpServer({ name: 'bulk-copilot', version: VERSION });

  // ---- session
  server.registerTool('bulk_session_status', { description: 'Stato del collegamento a Bulk (cliente verificato, guest o sessione scaduta) e tipo di carrello in uso. Nessun dato personale.', annotations: read },
    safeTool(async () => {
      const account = await client.verifyCustomer();
      return { account, cartMode: account === 'verified' ? 'customer' : 'guest', cartWritesEnabled: config.allowCartWrites,
        ...(account !== 'verified' ? { hint: 'Per usare il tuo account esegui `npm run login` nella cartella bulk-copilot-mcp.' } : {}) };
    }));

  // ---- catalog
  server.registerTool('bulk_search', { description: 'Ricerca live nel catalogo Bulk Italia, con filtri: categoria (uid da bulk_categories), "Adatto a" (Vegano, Vegetariano, halal), tipo (Powder, Capsule, Tablet, Food...), prezzo min/max, solo disponibili. Prezzi "da": le varianti possono costare di più. Segnala possibili conflitti con le preferenze salvate (solo dal nome).',
    inputSchema: { query: z.string().max(150).optional(), categoryUid: z.string().max(40).optional(), suitable: z.string().max(40).optional(), type: z.string().max(40).optional(),
      minPrice: z.number().min(0).max(1000).optional(), maxPrice: z.number().min(0).max(1000).optional(), inStockOnly: z.boolean().optional(),
      page: z.number().int().min(1).max(50).optional(), pageSize: z.number().int().min(1).max(40).optional(), sort: z.enum(['relevance', 'price_asc', 'price_desc', 'name']).optional() }, annotations: read },
    safeTool(async ({ query, ...opts }) => {
      if (!query && !opts.categoryUid && !opts.suitable && !opts.type) throw new BulkError('Indica una ricerca o un filtro', 'INVALID_ARGUMENT');
      const r = await client.search(query ?? '', opts), p = prefs();
      for (const x of r.products) { store.recordPrice(x.sku, x.price.from); Object.assign(x, quickFlags(x.name, p)); if (!x.flags.length) delete x.flags; }
      return { ...r, source: 'live_bulk_graphql', note: [r.note, 'Per €/kg e €/g di proteina usa bulk_product_details o bulk_nutrition.'].filter(Boolean).join(' ') };
    }));

  server.registerTool('bulk_filters', { description: 'Valori disponibili per i filtri di bulk_search ("Adatto a", tipo).', annotations: read },
    safeTool(async () => client.filterOptions()));

  server.registerTool('bulk_categories', { description: 'Albero delle categorie Bulk (obiettivi, proteine, vitamine, offerte...) con uid e numero di prodotti.', annotations: read },
    safeTool(async () => ({ categories: await client.categories() })));

  server.registerTool('bulk_category_products', { description: 'Prodotti di una categoria (uid da bulk_categories), con gli stessi filtri di bulk_search.',
    inputSchema: { categoryUid: z.string().min(2).max(40), suitable: z.string().max(40).optional(), type: z.string().max(40).optional(), inStockOnly: z.boolean().optional(),
      page: z.number().int().min(1).max(50).optional(), pageSize: z.number().int().min(1).max(40).optional(), sort: z.enum(['relevance', 'price_asc', 'price_desc', 'name']).optional() }, annotations: read },
    safeTool(async opts => {
      const r = await client.search('', opts);
      for (const x of r.products) store.recordPrice(x.sku, x.price.from);
      return r;
    }));

  server.registerTool('bulk_offers', { description: 'Prodotti in offerta ora (categoria Offerte del sito), ordinati per sconto, con prezzo pieno e prezzo scontato.',
    inputSchema: { page: z.number().int().min(1).max(20).optional(), pageSize: z.number().int().min(1).max(40).optional() }, annotations: read },
    safeTool(async args => {
      const r = await client.offers(args);
      for (const x of r.products) store.recordPrice(x.sku, x.price.from);
      return r;
    }));

  server.registerTool('bulk_product_details', { description: 'Dettagli di un prodotto: opzioni (gusto, confezione), ogni variante con SKU, prezzo, disponibilità e campi di confronto (netWeightG, pricePerKg, proteinPer100g, pricePerGramProtein), ingredienti, allergeni, "Adatto a", dose e controllo con le preferenze salvate.',
    inputSchema: productRef, annotations: read },
    safeTool(async ref => {
      const p = await enrichDetails(client, catalog, ref, prefs());
      for (const v of p.variants) store.recordPrice(v.sku, v.price);
      return { ...p, note: SAFETY_NOTE };
    }));

  server.registerTool('bulk_nutrition', { description: 'Tabella nutrizionale (per 100 g e per porzione) di una variante, dose, porzioni, proteine per porzione, e per ogni variante €/kg e €/g di proteina. Se Bulk non pubblica la tabella lo dice, senza inventare valori.',
    inputSchema: { ...productRef, variantSku: z.string().min(2).max(80).optional() }, annotations: read },
    safeTool(async ({ variantSku, ...ref }) => nutritionFor(client, catalog, ref, variantSku)));

  server.registerTool('bulk_reviews', { description: 'Valutazione media, numero di recensioni e distribuzione delle stelle (Yotpo, la fonte usata dal sito). I testi delle recensioni non sono esposti pubblicamente.',
    inputSchema: productRef, annotations: read },
    safeTool(async ref => {
      const p = await client.rawProduct(ref);
      return { product: p.name, ...(await yotpoBottomline(storefront, p.uid)), source: 'yotpo' };
    }));

  // ---- cart
  server.registerTool('bulk_get_cart', { description: 'Legge il carrello (del cliente se collegato, altrimenti guest locale) con spedizione: soglia per la consegna gratuita, quanto manca, e costi stimati per l\'Italia. Gli itemUid servono per modificare o rimuovere righe.', annotations: read },
    safeTool(async () => cartWithShipping()));

  server.registerTool('bulk_prepare_cart_change', { description: 'SOLA LETTURA. Prepara modifiche al carrello: add, reorder (rimette nel carrello gli articoli di un ordine passato, solo quelli disponibili), update, remove, coupon_apply, coupon_remove. Verifica varianti e disponibilità e restituisce riepilogo, spedizione e confirmationPhrase. Mostra il riepilogo e attendi l\'approvazione esplicita dell\'utente in un messaggio successivo.',
    inputSchema: { operations: z.array(cartOp).min(1).max(15) }, annotations: read },
    safeTool(async ({ operations }) => planner.prepare(operations)));

  server.registerTool('bulk_commit_cart_change', { description: 'ESEGUE UNA SOLA VOLTA un piano preparato, solo dopo approvazione esplicita dell\'utente. Fallisce se il carrello è cambiato. In caso di errore non ripetere: rileggi il carrello. Non effettua ordini né pagamenti.',
    inputSchema: { planId: z.string().uuid(), confirmationPhrase: z.string().min(1).max(30), userExplicitlyApproved: z.literal(true) }, annotations: write },
    safeTool(async ({ planId, confirmationPhrase }) => planner.commit(planId, confirmationPhrase)));

  server.registerTool('bulk_cart_plan_status', { description: 'Stato ed esito di un piano carrello, senza rieseguirlo.',
    inputSchema: { planId: z.string().uuid() }, annotations: localRead },
    safeTool(async ({ planId }) => planner.status(planId)));

  // ---- account (requires npm run login)
  server.registerTool('bulk_orders', { description: 'Ultimi ordini del cliente (richiede `npm run login`): numero, data, stato, totale, articoli.',
    inputSchema: { page: z.number().int().min(1).max(50).optional(), pageSize: z.number().int().min(1).max(20).optional() }, annotations: read },
    safeTool(async args => client.orders(args)));

  server.registerTool('bulk_order_get', { description: 'Dettaglio di un ordine: articoli con varianti e prezzi, totali, spedizione, stato, tracking del corriere, metodo di pagamento (solo nome), coupon. Per riordinare usa bulk_prepare_cart_change con op "reorder".',
    inputSchema: { orderNumber: z.string().regex(/^\d{5,15}$/) }, annotations: read },
    safeTool(async ({ orderNumber }) => client.orderGet(orderNumber)));

  server.registerTool('bulk_rewards', { description: 'Punti fedeltà Bulk (saldo, valore in euro, regole di accumulo e utilizzo) e credito negozio del cliente.', annotations: read },
    safeTool(async () => client.rewards()));

  server.registerTool('bulk_addresses', { description: 'Indirizzi salvati nel tuo account Bulk (sola lettura; si modificano solo sul sito).', annotations: read },
    safeTool(async () => ({ addresses: await client.addresses() })));

  server.registerTool('bulk_payment_methods', { description: 'Metodi di pagamento che Bulk offre per il carrello attuale (solo nome e codice, mai dati di carte). L\'elenco completo compare quando il carrello ha articoli e indirizzo; il pagamento si fa solo sul sito.', annotations: read },
    safeTool(async () => {
      const { cartId, auth, mode } = await cartContext.resolve();
      return { cartMode: mode, methods: await client.paymentMethods(cartId, auth),
        note: 'Elenco dipendente da carrello e indirizzo: al checkout possono comparire altri metodi (es. carte, PayPal, Apple Pay).' };
    }));

  server.registerTool('bulk_wishlist', { description: 'Lista dei desideri. Su bulk.com/it è disattivata dal negozio: il tool lo verifica in tempo reale.', annotations: read },
    safeTool(async () => {
      if (!(await client.wishlistEnabled())) return { enabled: false, message: 'Bulk Italia ha la wishlist disattivata (storeConfig): nessuna lista da leggere o modificare.' };
      throw new BulkError('La wishlist risulta attiva ma questa versione non la gestisce ancora', 'NOT_IMPLEMENTED');
    }));

  // ---- local preferences
  server.registerTool('bulk_preferences_get', { description: 'Preferenze locali: diete (vegan, vegetarian, gluten_free, lactose_free, halal), ingredienti da evitare, gusti e marchi preferiti.', annotations: localRead },
    safeTool(async () => ({ preferences: prefs(), dietsAvailable: DIETS })));

  server.registerTool('bulk_preferences_set', { description: 'Aggiunge preferenze locali (si sommano a quelle esistenti). Servono a segnalare possibili conflitti, non garantiscono nulla.',
    inputSchema: { diets: z.array(z.enum(DIETS)).max(5).optional(), avoid: z.array(z.string().min(2).max(40)).max(20).optional(),
      flavours: z.array(z.string().min(2).max(40)).max(20).optional(), brands: z.array(z.string().min(2).max(40)).max(10).optional(),
      userExplicitlyRequested: z.literal(true) }, annotations: localWrite },
    safeTool(async ({ userExplicitlyRequested, ...patch }) => {
      const next = mergePrefs(prefs(), patch); store.set('preferences', next); store.audit('preferences_set', next); return { preferences: next };
    }));

  server.registerTool('bulk_preferences_remove', { description: 'Rimuove voci dalle preferenze locali.',
    inputSchema: { diets: z.array(z.enum(DIETS)).max(5).optional(), avoid: z.array(z.string().max(40)).max(20).optional(),
      flavours: z.array(z.string().max(40)).max(20).optional(), brands: z.array(z.string().max(40)).max(10).optional(), userExplicitlyRequested: z.literal(true) }, annotations: localWrite },
    safeTool(async ({ userExplicitlyRequested, ...patch }) => {
      const next = removePrefs(prefs(), patch); store.set('preferences', next); store.audit('preferences_remove', next); return { preferences: next };
    }));

  // ---- misc
  server.registerTool('bulk_price_history', { description: 'Storico prezzi di uno SKU (variante o prodotto) osservato da questo MCP. Parte dalla prima volta che il prodotto è stato visto.',
    inputSchema: { sku: z.string().min(2).max(80) }, annotations: localRead },
    safeTool(async ({ sku }) => {
      const h = store.priceHistory(sku), prices = h.map(x => x.price);
      return { sku, observations: h.length, min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null, history: h.slice(-30) };
    }));

  server.registerTool('bulk_release_info', { description: 'Versione del server, funzioni disponibili e limiti noti.', annotations: localRead },
    safeTool(async () => ({ service: 'bulk-copilot', version: VERSION, site: 'https://www.bulk.com/it', cartWritesEnabled: config.allowCartWrites,
      freeShippingThreshold: await storefront.freeShippingThreshold(),
      features: { nutrition: 'Catalog Service, per variante', reviews: 'Yotpo: solo valutazione aggregata', rewards: 'punti fedeltà e credito negozio', wishlist: 'disattivata dal negozio',
        reorder: 'op "reorder" nel piano carrello', preferences: 'locali, segnalazione di possibili conflitti' },
      excluded: ['checkout e pagamento', 'modifica indirizzi o dati account'], checkout: 'solo sul sito, mai dall\'MCP' })));

  return server;
}

const app = createMcpExpressApp({ host: config.bindHost,
  ...(config.bindHost === '0.0.0.0' ? { allowedHosts: ['bulk-mcp', 'localhost', '127.0.0.1'], allowedOrigins: ['bulk-mcp', 'localhost', '127.0.0.1'] } : {}) });
app.use(express.json({ limit: '128kb' }));
app.get('/health', (_req, res) => res.json({ service: 'bulk-copilot', ok: true, version: VERSION }));
app.post('/mcp', async (req, res) => {
  const server = makeServer(), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch { if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal MCP error' }, id: null }); }
  finally {
    if (res.writableFinished) { await transport.close(); await server.close(); }
    else res.on('close', async () => { await transport.close(); await server.close(); });
  }
});
app.get('/mcp', (_req, res) => res.status(405).end());
app.delete('/mcp', (_req, res) => res.status(405).end());
const instance = app.listen(config.port, config.bindHost, () =>
  console.log(`Bulk MCP v${VERSION} on http://${config.bindHost}:${config.port}/mcp — cart writes: ${config.allowCartWrites ? 'enabled' : 'disabled'}`));
function stop() { instance.close(); store.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
