import crypto from 'node:crypto';
import { BulkError, resolveVariant } from './client.mjs';

export const cartFingerprint = cart => crypto.createHash('sha256')
  .update(JSON.stringify([(cart?.items ?? []).map(i => [i.itemUid, i.quantity]).sort(), [...(cart?.coupons ?? [])].sort()]))
  .digest('hex').slice(0, 16);

/** Finds the right cart: the customer's cart when logged in, otherwise a local guest cart. */
export class CartContext {
  constructor(client, store, session) { this.client = client; this.store = store; this.session = session; }
  async resolve() {
    if (await this.session.get()) return { cartId: await this.client.customerCartId(), auth: true, mode: 'customer' };
    let cartId = this.store.get('guestCartId');
    if (cartId) {
      try { await this.client.readCart(cartId, false); return { cartId, auth: false, mode: 'guest' }; }
      catch (e) { if (!['NOT_FOUND', 'GRAPHQL_ERROR', 'INPUT_REJECTED'].includes(e.code)) throw e; }
    }
    cartId = await this.client.createGuestCart();
    this.store.set('guestCartId', cartId);
    return { cartId, auth: false, mode: 'guest' };
  }
  async read() { const c = await this.resolve(); return { ...c, cart: await this.client.readCart(c.cartId, c.auth) }; }
}

const PHRASE_WORDS = ['WHEY', 'CREA', 'OATS', 'BCAA', 'MASS', 'VEGA', 'BULK', 'GYM'];
const newPhrase = () => `${PHRASE_WORDS[crypto.randomInt(PHRASE_WORDS.length)]}-${crypto.randomInt(1000, 9999)}`;

/**
 * Two-phase cart changes. prepare(): read-only, resolves every operation against the live cart
 * and catalog and returns a summary plus a confirmation phrase. commit(): runs the plan ONCE,
 * only if the cart did not change in the meantime. Uncertain outcomes are never retried.
 */
export class CartPlanner {
  constructor({ client, store, cartContext, ttlMs = 15 * 60 * 1000, writesEnabled = true, freeShippingThreshold = async () => 55 }) {
    Object.assign(this, { client, store, cartContext, ttlMs, writesEnabled, freeShippingThreshold });
  }

  /** Resolves one product + options into an add operation (throws OUT_OF_STOCK / option errors). */
  async #resolveAdd({ urlKey, sku, options, quantity }) {
    const raw = await this.client.rawProduct({ urlKey, sku });
    const v = resolveVariant(raw, options ?? {});
    if (v.inStock === false || raw.stock_status !== 'IN_STOCK') throw new BulkError(`${raw.name} ${Object.values(v.label).join(' ')} non è disponibile`, 'OUT_OF_STOCK');
    const price = v.unitPrice ?? raw.price_range?.minimum_price?.final_price?.value;
    this.store.recordPrice(v.variantSku ?? raw.sku, price);
    return { op: { op: 'add', sku: raw.sku, quantity, selectedOptions: v.selectedOptions },
      line: { action: 'aggiungi', name: raw.name, options: v.label, sku: v.variantSku ?? raw.sku, quantity, unitPrice: price, estimatedTotal: round(price * quantity) },
      amount: price * quantity };
  }

  async prepare(operations) {
    if (!operations?.length) throw new BulkError('Nessuna operazione', 'INVALID_ARGUMENT');
    const { cart, mode } = await this.cartContext.read();
    const ops = [], lines = [], warnings = [];
    let delta = 0;
    for (const op of operations) {
      if (op.op === 'add') {
        const r = await this.#resolveAdd(op);
        ops.push(r.op); lines.push(r.line); delta += r.amount;
      } else if (op.op === 'reorder') {
        // Expands a past order into add operations; unavailable or changed items are reported, not guessed.
        const order = await this.client.orderGet(op.orderNumber);
        const wanted = op.skus?.length ? order.items.filter(i => op.skus.includes(i.sku)) : order.items;
        const skipped = [];
        for (const it of wanted) {
          if (!it.urlKey) { skipped.push({ name: it.name, sku: it.sku, reason: 'prodotto non più identificabile' }); continue; }
          try {
            const r = await this.#resolveAdd({ urlKey: it.urlKey, options: it.options, quantity: Math.max(1, Math.round(it.quantity)) });
            r.line.fromOrder = order.number;
            if (r.line.sku !== it.sku) r.line.note = `SKU cambiato (era ${it.sku})`;
            if (it.unitPrice !== undefined && Math.abs(r.line.unitPrice - it.unitPrice) >= 0.01) r.line.previousPrice = it.unitPrice;
            ops.push(r.op); lines.push(r.line); delta += r.amount;
          } catch (e) {
            if (!(e instanceof BulkError)) throw e;
            skipped.push({ name: it.name, sku: it.sku, options: it.options, reason: e.message });
          }
        }
        if (skipped.length) warnings.push({ reorderSkipped: skipped });
        if (!wanted.length) throw new BulkError('Nessun articolo dell\'ordine corrisponde agli SKU indicati', 'INVALID_ARGUMENT');
      } else if (op.op === 'update' || op.op === 'remove') {
        const item = cart.items.find(i => i.itemUid === op.itemUid);
        if (!item) throw new BulkError('Articolo non presente nel carrello: rileggi il carrello', 'ITEM_NOT_IN_CART');
        const qty = op.op === 'remove' ? 0 : op.quantity;
        ops.push(qty === 0 ? { op: 'remove', itemUid: item.itemUid } : { op: 'update', itemUid: item.itemUid, quantity: qty });
        lines.push({ action: qty === 0 ? 'rimuovi' : 'modifica quantità', name: item.name, options: item.options, from: item.quantity, to: qty });
        delta += (qty - item.quantity) * (item.unitPrice ?? 0);
      } else if (op.op === 'coupon_apply') {
        if (!cart.items.length && !ops.some(o => o.op === 'add')) throw new BulkError('Il carrello è vuoto: aggiungi prima dei prodotti, poi applica il coupon', 'INVALID_ARGUMENT');
        if (cart.coupons.length) warnings.push(`Il coupon ${cart.coupons.join(', ')} verrà sostituito: Bulk accetta un solo coupon per carrello.`);
        ops.push({ op: 'coupon_apply', code: op.code });
        lines.push({ action: 'applica coupon', code: op.code, note: 'lo sconto reale si vede solo dopo l\'applicazione' });
      } else if (op.op === 'coupon_remove') {
        if (!cart.coupons.length) throw new BulkError('Nessun coupon da rimuovere', 'INVALID_ARGUMENT');
        ops.push({ op: 'coupon_remove' }); lines.push({ action: 'rimuovi coupon', code: cart.coupons[0] });
      } else throw new BulkError(`Operazione sconosciuta: ${op.op}`, 'INVALID_ARGUMENT');
    }
    if (!ops.length) throw new BulkError('Nessuna operazione eseguibile', 'NOTHING_TO_DO', { warnings });
    const estimatedNewSubtotal = round((cart.subtotal ?? 0) + delta);
    const plan = { id: crypto.randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs, phrase: newPhrase(),
      cartFingerprint: cartFingerprint(cart), ops,
      summary: { cartMode: mode, lines, currentTotal: cart.grandTotal, estimatedDelta: round(delta), estimatedNewSubtotal,
        shipping: freeShippingInfo(estimatedNewSubtotal, await this.freeShippingThreshold()), warnings } };
    this.store.savePlan(plan);
    this.store.audit('cart_prepare', { planId: plan.id, ops: ops.length });
    return { planId: plan.id, confirmationPhrase: plan.phrase, expiresAt: new Date(plan.expiresAt).toISOString(), ...plan.summary,
      writesEnabled: this.writesEnabled,
      instructions: 'Mostra questo riepilogo all\'utente. Esegui bulk_commit_cart_change solo dopo un suo esplicito OK in un messaggio successivo.' };
  }

  async commit(planId, phrase) {
    if (!this.writesEnabled) throw new BulkError('Scritture sul carrello disattivate (ALLOW_CART_WRITES=false)', 'WRITES_DISABLED');
    const plan = this.store.getPlan(planId);
    if (!plan) throw new BulkError('Piano non trovato', 'PLAN_NOT_FOUND');
    if (plan.status !== 'prepared') throw new BulkError(`Piano già usato (stato: ${plan.status}). Non ripetere: leggi il carrello.`, 'PLAN_ALREADY_USED', { status: plan.status });
    if (Date.now() > plan.expiresAt) { this.store.finishPlan(planId, 'expired'); throw new BulkError('Piano scaduto: preparane uno nuovo', 'PLAN_EXPIRED'); }
    if (phrase !== plan.phrase) throw new BulkError('Frase di conferma errata', 'CONFIRMATION_MISMATCH');
    const ctx = await this.cartContext.read();
    if (cartFingerprint(ctx.cart) !== plan.cartFingerprint) {
      this.store.finishPlan(planId, 'stale');
      throw new BulkError('Il carrello è cambiato dopo la preparazione: preparane uno nuovo', 'CART_CHANGED');
    }
    if (!this.store.claimPlan(planId)) throw new BulkError('Piano già in esecuzione', 'PLAN_ALREADY_USED');
    const done = [];
    let cart = ctx.cart;
    try {
      for (const o of plan.ops) {
        if (o.op === 'add') cart = await this.client.addToCart(ctx.cartId, ctx.auth, o);
        else if (o.op === 'update') cart = await this.client.updateItem(ctx.cartId, ctx.auth, o.itemUid, o.quantity);
        else if (o.op === 'remove') cart = await this.client.removeItem(ctx.cartId, ctx.auth, o.itemUid);
        else if (o.op === 'coupon_apply') cart = await this.client.applyCoupon(ctx.cartId, ctx.auth, o.code);
        else if (o.op === 'coupon_remove') cart = await this.client.removeCoupon(ctx.cartId, ctx.auth);
        done.push(o.op);
      }
    } catch (e) {
      const result = { completed: done.length, total: plan.ops.length, failedAt: plan.ops[done.length]?.op, error: e.code, message: e.message };
      // A validation refusal of the first step (e.g. invalid coupon) means nothing was applied.
      const rejected = done.length === 0 && ['CART_REJECTED', 'INPUT_REJECTED'].includes(e.code);
      this.store.finishPlan(planId, rejected ? 'rejected' : done.length ? 'partial' : 'failed_or_unknown', result);
      this.store.audit('cart_commit_error', { planId, ...result });
      if (rejected) throw new BulkError(`Bulk ha rifiutato l'operazione: ${e.message.replace(/.$/, '')}. Nessuna modifica applicata.`, 'CART_REJECTED', result);
      throw new BulkError(`${e.message.replace(/.$/, '')}. Esito incerto: NON ripetere, rileggi il carrello con bulk_get_cart.`, 'COMMIT_UNCERTAIN', result);
    }
    this.store.finishPlan(planId, 'committed', { operations: done.length });
    this.store.audit('cart_commit', { planId, operations: done.length });
    return { status: 'committed', operations: done.length, cart,
      checkout: 'Il pagamento si fa sul sito: https://www.bulk.com/it/cart (accedi con lo stesso account).' };
  }

  status(planId) {
    const p = this.store.getPlan(planId);
    if (!p) throw new BulkError('Piano non trovato', 'PLAN_NOT_FOUND');
    return { planId, status: p.status, summary: p.summary, result: p.result };
  }
}

const round = n => Math.round(n * 100) / 100;

/** Free standard delivery above the store threshold (55 € on bulk.com/it, verified live). */
export function freeShippingInfo(subtotal, threshold) {
  const missing = round(Math.max(0, threshold - (subtotal ?? 0)));
  return { freeShippingThreshold: threshold, freeStandardShipping: missing === 0, missingForFreeShipping: missing,
    note: missing === 0 ? 'Consegna standard gratuita.' : `Mancano ${missing.toFixed(2)} € per la consegna standard gratuita.` };
}
