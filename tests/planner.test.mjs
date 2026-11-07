import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/store.mjs';
import { CartPlanner } from '../src/planner.mjs';
import { resolveVariant } from '../src/client.mjs';

const RAW = { sku: 'BPB-DWHE', name: 'Daily Whey Protein', stock_status: 'IN_STOCK',
  price_range: { minimum_price: { final_price: { value: 24.99 } } },
  configurable_options: [
    { attribute_code: 'bp_flavour', label: 'Gusto', values: [{ uid: 'F1', label: 'Vaniglia' }, { uid: 'F2', label: 'Cioccolato' }] },
    { attribute_code: 'bp_size', label: 'Confezione', values: [{ uid: 'S1', label: '900g' }, { uid: 'S2', label: '2kg' }] }],
  variants: [
    { attributes: [{ uid: 'F1' }, { uid: 'S2' }], product: { sku: 'V-2000', stock_status: 'IN_STOCK', price_range: { minimum_price: { final_price: { value: 49.99 } } } } },
    { attributes: [{ uid: 'F2' }, { uid: 'S1' }], product: { sku: 'C-0900', stock_status: 'OUT_OF_STOCK', price_range: { minimum_price: { final_price: { value: 24.99 } } } } }] };

function setup() {
  const store = new AgentStore(':memory:');
  let cart = { items: [], coupons: [], subtotal: 0, grandTotal: 0 };
  const calls = [];
  const client = {
    rawProduct: async () => RAW,
    addToCart: async (_c, _a, o) => { calls.push(o); cart = { ...cart, items: [...cart.items, { itemUid: 'I1', quantity: o.quantity }] }; return cart; }
  };
  const cartContext = { read: async () => ({ cartId: 'C', auth: false, mode: 'guest', cart }) };
  return { store, calls, planner: new CartPlanner({ client, store, cartContext }), mutate: () => { cart = { ...cart, items: [{ itemUid: 'X', quantity: 1 }] }; } };
}

test('resolveVariant matches labels and aliases case-insensitively', () => {
  const v = resolveVariant(RAW, { flavour: 'vaniglia', Confezione: '2KG' });
  assert.equal(v.variantSku, 'V-2000'); assert.deepEqual(v.selectedOptions, ['F1', 'S2']);
  assert.throws(() => resolveVariant(RAW, { Gusto: 'Vaniglia' }), e => e.code === 'OPTIONS_REQUIRED');
  assert.throws(() => resolveVariant(RAW, { Gusto: 'Mango', Confezione: '2kg' }), e => e.code === 'INVALID_OPTION');
});

test('prepare is read-only and commit runs exactly once', async () => {
  const { planner, calls } = setup();
  const p = await planner.prepare([{ op: 'add', urlKey: 'daily-whey', quantity: 2, options: { Gusto: 'Vaniglia', Confezione: '2kg' } }]);
  assert.equal(calls.length, 0); assert.equal(p.estimatedDelta, 99.98);
  await assert.rejects(planner.commit(p.planId, 'WRONG'), e => e.code === 'CONFIRMATION_MISMATCH');
  const r = await planner.commit(p.planId, p.confirmationPhrase);
  assert.equal(r.status, 'committed'); assert.equal(calls.length, 1);
  await assert.rejects(planner.commit(p.planId, p.confirmationPhrase), e => e.code === 'PLAN_ALREADY_USED');
  assert.equal(calls.length, 1);
});

test('out-of-stock variant is refused at prepare', async () => {
  const { planner } = setup();
  await assert.rejects(planner.prepare([{ op: 'add', urlKey: 'x', quantity: 1, options: { Gusto: 'Cioccolato', Confezione: '900g' } }]), e => e.code === 'OUT_OF_STOCK');
});

test('commit refuses when the cart changed after prepare', async () => {
  const { planner, calls, mutate } = setup();
  const p = await planner.prepare([{ op: 'add', urlKey: 'x', quantity: 1, options: { Gusto: 'Vaniglia', Confezione: '2kg' } }]);
  mutate();
  await assert.rejects(planner.commit(p.planId, p.confirmationPhrase), e => e.code === 'CART_CHANGED');
  assert.equal(calls.length, 0);
});
