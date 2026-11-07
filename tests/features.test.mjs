import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFields, netWeightGrams, parseNutritionTable, proteinPer100 } from '../src/nutrition.mjs';
import { evaluateProduct, mergePrefs, quickFlags, removePrefs } from '../src/preferences.mjs';
import { labelFacts } from '../src/catalog.mjs';
import { AgentStore } from '../src/store.mjs';
import { CartPlanner, freeShippingInfo } from '../src/planner.mjs';
import { BulkError } from '../src/client.mjs';

// Shape copied from the live Catalog Service (Daily Whey Vaniglia 900g).
const TABLE = JSON.stringify([
  { per_100: { 'per 100 g': '1497/353' }, nutrition: { Nutrition: 'Energia kJ / kcal' }, per_serving: { 'per porzione': '449/106' } },
  { per_100: { 'per 100 g': '59 g' }, nutrition: { Nutrition: 'Proteine' }, per_serving: { 'per porzione': '18 g' } }]);

test('nutrition table, net weight and compare fields', () => {
  const rows = parseNutritionTable(TABLE);
  assert.equal(rows.length, 2); assert.equal(proteinPer100(rows), 59);
  assert.equal(parseNutritionTable('not json'), null); assert.equal(parseNutritionTable('[]'), null);
  assert.equal(netWeightGrams({ weightNetKg: '0.9' }), 900);
  assert.equal(netWeightGrams({ sizeLabel: '2.5kg' }), 2500);
  assert.equal(netWeightGrams({ sizeLabel: '500g' }), 500);
  assert.equal(netWeightGrams({ sizeLabel: '90 compresse' }), undefined);
  assert.deepEqual(compareFields({ price: 24.99, netWeightG: 900, proteinPer100g: 59 }),
    { netWeightG: 900, proteinPer100g: 59, pricePerKg: 27.77, pricePerGramProtein: 0.0471 });
  assert.deepEqual(compareFields({ price: 10, netWeightG: undefined, proteinPer100g: undefined }), {});
});

test('label facts strip html and drop nothing invented', () => {
  const f = labelFacts({ ingredients: '<p>Siero di <strong>latte</strong></p>', bp_suitable: 'Vegetariano', no_of_servings: '30.0000', serving_size: '30g' });
  assert.equal(f.ingredients, 'Siero di latte'); assert.deepEqual(f.suitable, ['Vegetariano']); assert.equal(f.servings, 30);
  assert.equal(labelFacts({}).ingredients, undefined);
});

test('preferences: conflicts, no-conflict wording, insufficient data', () => {
  const whey = { name: 'Daily Whey', ingredients: 'Concentrato di proteine del siero di latte, proteine isolate di soia', mayContain: 'Può contenere cereali contenenti glutine', suitable: ['Vegetariano'] };
  const vegan = evaluateProduct(whey, { diets: ['vegan'], avoid: [] });
  assert.equal(vegan.status, 'possibile_conflitto'); assert.ok(vegan.reasons.some(r => r.includes('vegano')));
  const gf = evaluateProduct(whey, { diets: ['gluten_free'], avoid: [] });
  assert.equal(gf.status, 'nessun_conflitto_rilevato'); assert.ok(gf.notes.some(n => n.includes('tracce di glutine')));
  assert.ok(gf.notes.some(n => n.includes('non è una garanzia')));
  assert.equal(evaluateProduct(whey, { diets: [], avoid: ['soia'] }).status, 'possibile_conflitto');
  assert.equal(evaluateProduct({ name: 'X' }, { diets: ['lactose_free'], avoid: [] }).status, 'dati_insufficienti');
  assert.equal(evaluateProduct(whey, { diets: [], avoid: [] }).status, 'nessuna_preferenza');
  assert.deepEqual(quickFlags('Clear Whey Isolate Vaniglia', { diets: ['vegan'], avoid: [], flavours: ['vaniglia'], brands: [] }),
    { flags: ['probabilmente non vegano (dal nome)'], preferredFlavour: 'vaniglia' });
  const p = mergePrefs({ diets: ['vegan'], avoid: [] }, { diets: ['vegan', 'bogus', 'halal'], avoid: ['Soia'] });
  assert.deepEqual(p, { diets: ['vegan', 'halal'], avoid: ['Soia'], flavours: [], brands: [] });
  assert.deepEqual(removePrefs(p, { avoid: ['soia'] }).avoid, []);
});

test('free shipping info', () => {
  assert.deepEqual(freeShippingInfo(24.99, 55), { freeShippingThreshold: 55, freeStandardShipping: false, missingForFreeShipping: 30.01, note: 'Mancano 30.01 € per la consegna standard gratuita.' });
  assert.equal(freeShippingInfo(74.97, 55).freeStandardShipping, true);
});

const RAW = { sku: 'BPB-DWHE', name: 'Daily Whey Protein', stock_status: 'IN_STOCK', price_range: { minimum_price: { final_price: { value: 24.99 } } },
  configurable_options: [{ attribute_code: 'bp_flavour', label: 'Gusto', values: [{ uid: 'F1', label: 'Vaniglia' }] },
    { attribute_code: 'bp_size', label: 'Confezione', values: [{ uid: 'S1', label: '900g' }] }],
  variants: [{ attributes: [{ uid: 'F1' }, { uid: 'S1' }], product: { sku: 'BPB-DWHE-VANI-0900', stock_status: 'IN_STOCK', price_range: { minimum_price: { final_price: { value: 24.99 } } } } }] };

test('reorder expands available items, reports the rest, adds shipping info', async () => {
  const store = new AgentStore(':memory:');
  const client = {
    orderGet: async () => ({ number: '1000000001', items: [
      { name: 'Daily Whey Protein', sku: 'BPB-DWHE-VANI-0900', urlKey: 'daily-whey', quantity: 2, unitPrice: 20.99, options: { Gusto: 'Vaniglia', Confezione: '900g' } },
      { name: 'Prodotto ritirato', sku: 'OLD-1', urlKey: 'old', quantity: 1, options: {} }] }),
    rawProduct: async ({ urlKey }) => { if (urlKey === 'old') throw new BulkError('Prodotto non trovato', 'NOT_FOUND'); return RAW; }
  };
  const cartContext = { read: async () => ({ cartId: 'C', auth: true, mode: 'customer', cart: { items: [], coupons: [], subtotal: 0, grandTotal: 0 } }) };
  const planner = new CartPlanner({ client, store, cartContext, freeShippingThreshold: async () => 55 });
  const p = await planner.prepare([{ op: 'reorder', orderNumber: '1000000001' }]);
  assert.equal(p.lines.length, 1); assert.equal(p.lines[0].quantity, 2); assert.equal(p.lines[0].previousPrice, 20.99);
  assert.equal(p.warnings[0].reorderSkipped[0].sku, 'OLD-1');
  assert.equal(p.shipping.missingForFreeShipping, 5.02);
});

test('coupon on empty cart is refused at prepare; invalid coupon is a certain rejection', async () => {
  const store = new AgentStore(':memory:');
  const empty = { read: async () => ({ cartId: 'C', auth: false, mode: 'guest', cart: { items: [], coupons: [], subtotal: 0 } }) };
  const p1 = new CartPlanner({ client: {}, store, cartContext: empty });
  await assert.rejects(p1.prepare([{ op: 'coupon_apply', code: 'X' }]), e => e.code === 'INVALID_ARGUMENT');
  const full = { read: async () => ({ cartId: 'C', auth: false, mode: 'guest', cart: { items: [{ itemUid: 'I', quantity: 1 }], coupons: [], subtotal: 30 } }) };
  const client = { applyCoupon: async () => { throw new BulkError("The coupon code isn't valid.", 'INPUT_REJECTED'); } };
  const p2 = new CartPlanner({ client, store, cartContext: full });
  const plan = await p2.prepare([{ op: 'coupon_apply', code: 'NOPE' }]);
  await assert.rejects(p2.commit(plan.planId, plan.confirmationPhrase), e => e.code === 'CART_REJECTED');
  assert.equal(p2.status(plan.planId).status, 'rejected');
});
