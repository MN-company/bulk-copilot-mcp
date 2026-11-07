import { SITE, STORE_PATH } from './config.mjs';
import { BulkError } from './client.mjs';

/**
 * Public storefront configuration (/it/configs.json) and the Adobe Catalog Service it points to.
 * The Catalog Service exposes per-variant attributes (nutrition table, ingredients, allergens,
 * suitability, net weight) that the core GraphQL API does not.
 */
const FALLBACK = {
  'commerce-endpoint': `${SITE}${STORE_PATH}/cs-graphql`,
  'commerce-environment-id': 'bf658f50-a0ce-4baa-b707-a7622f75a311',
  'commerce-website-code': 'bp_italy', 'commerce-store-code': 'bulkpowders_italy', 'commerce-store-view-code': 'bp_italy_view',
  'commerce-x-api-key': 'd3f6d917148f42d5bb7eb7eb3272cf0e', 'minimum-order-threshold': '55'
};
// Attributes we expose; internal ones (cost_price, supplier, feeds...) are deliberately left out.
const KEEP = ['nutrition_table', 'protein_per_serving_g', 'serving_size', 'no_of_servings', 'servings', 'weight_net', 'bp_size', 'bp_flavour',
  'bp_suitable', 'ingredients', 'allergens_may_contain', 'allergens_may_contain_statement', 'directions', 'protein_type', 'sale_text', 'sale_text_end', 'brand', 'barcode'];

const ACCENT = { grave: '̀', acute: '́' };
export const stripHtml = h => String(h ?? '').replace(/<\/?(strong|b|em|i|span)[^>]*>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&([a-z])(grave|acute);/gi, (_, c, k) => (c + ACCENT[k.toLowerCase()]).normalize('NFC')).replace(/&rsquo;|&lsquo;/g, "'")
  .replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/\(\s+/g, '(').trim();

export class StorefrontConfig {
  #cfg; #at = 0;
  constructor({ fetchImpl = fetch, ttlMs = 6 * 3600 * 1000 } = {}) { this.fetch = fetchImpl; this.ttlMs = ttlMs; }
  async get() {
    if (this.#cfg && Date.now() - this.#at < this.ttlMs) return this.#cfg;
    try {
      const r = await this.fetch(`${SITE}${STORE_PATH}/configs.json`, { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      this.#cfg = { ...FALLBACK, ...Object.fromEntries((j.prod?.data ?? []).map(x => [x.key, x.value])) };
    } catch { this.#cfg = { ...FALLBACK }; }
    this.#at = Date.now();
    return this.#cfg;
  }
  async freeShippingThreshold() { return Number((await this.get())['minimum-order-threshold']) || 55; }
}

export class CatalogService {
  #cache = new Map();
  constructor(storefront, { fetchImpl = fetch } = {}) { this.storefront = storefront; this.fetch = fetchImpl; }

  async #query(query, variables) {
    const c = await this.storefront.get();
    let res;
    try {
      res = await this.fetch(c['commerce-endpoint'], { method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', 'Magento-Environment-Id': c['commerce-environment-id'], 'Magento-Website-Code': c['commerce-website-code'],
          'Magento-Store-Code': c['commerce-store-code'], 'Magento-Store-View-Code': c['commerce-store-view-code'],
          'Magento-Customer-Group': 'b6589fc6ab0dc82cf12099d1c2d40ab994e8410c', 'x-api-key': c['commerce-x-api-key'] },
        body: JSON.stringify({ query, variables }) });
    } catch { throw new BulkError('Catalogo Bulk non raggiungibile', 'NETWORK_ERROR'); }
    const j = await res.json().catch(() => ({}));
    if (j.errors?.length) throw new BulkError(j.errors[0].message, 'GRAPHQL_ERROR');
    return j.data;
  }

  /** Map sku → selected attributes for a product and all its variants (cached 10 minutes). */
  async attributesFor(parentSku) {
    const hit = this.#cache.get(parentSku);
    if (hit && Date.now() - hit.at < 600000) return hit.map;
    const pick = attrs => Object.fromEntries((attrs ?? []).filter(a => KEEP.includes(a.name) && a.value !== '' && a.value !== null).map(a => [a.name, a.value]));
    const map = new Map();
    const v = await this.#query('query($s:String!){ variants(sku:$s){ variants{ product{ sku attributes{ name value } } } } }', { s: parentSku });
    for (const x of v.variants?.variants ?? []) map.set(x.product.sku, pick(x.product.attributes));
    const p = await this.#query('query($s:[String]){ products(skus:$s){ sku attributes{ name value } } }', { s: [parentSku] });
    for (const x of p.products ?? []) map.set(x.sku, pick(x.attributes));
    this.#cache.set(parentSku, { at: Date.now(), map });
    return map;
  }
}

/** Human-readable label facts from a variant's attributes. */
export function labelFacts(attrs = {}) {
  const list = v => Array.isArray(v) ? v : (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : []);
  return {
    ingredients: stripHtml(attrs.ingredients) || undefined,
    allergens: stripHtml(attrs.allergens_may_contain) || undefined,
    mayContain: stripHtml(attrs.allergens_may_contain_statement) || undefined,
    suitable: list(attrs.bp_suitable),
    directions: stripHtml(attrs.directions) || undefined,
    proteinType: list(attrs.protein_type),
    servingSize: attrs.serving_size || undefined,
    servings: Number(attrs.no_of_servings || attrs.servings) || undefined,
    proteinPerServingG: Number(attrs.protein_per_serving_g) || undefined,
    promo: stripHtml(attrs.sale_text) || undefined, promoEnds: attrs.sale_text_end || undefined
  };
}

/** Yotpo public widget API: aggregate rating for a product (entity id = decoded Magento uid). */
export async function yotpoBottomline(storefront, productUid, fetchImpl = fetch) {
  const key = (await storefront.get())['yotpo-api-key'];
  if (!key) throw new BulkError('Recensioni non disponibili', 'NOT_AVAILABLE');
  const id = Buffer.from(String(productUid), 'base64').toString('utf8');
  if (!/^\d+$/.test(id)) throw new BulkError('Identificativo prodotto non valido', 'INVALID_ARGUMENT');
  let j;
  try { j = await (await fetchImpl(`https://api-cdn.yotpo.com/v1/widget/${encodeURIComponent(key)}/products/${id}/reviews.json?per_page=5`, { signal: AbortSignal.timeout(15000) })).json(); }
  catch { throw new BulkError('Servizio recensioni non raggiungibile', 'NETWORK_ERROR'); }
  const b = j.response?.bottomline ?? {};
  return { totalReviews: b.total_review ?? 0, averageScore: b.average_score ? Math.round(b.average_score * 100) / 100 : null,
    starDistribution: b.star_distribution ?? null,
    reviews: (j.response?.reviews ?? []).map(r => ({ score: r.score, title: r.title, text: String(r.content ?? '').slice(0, 600), date: r.created_at })) };
}
