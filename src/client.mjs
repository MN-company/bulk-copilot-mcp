import { GRAPHQL_URL, SITE, STORE_PATH, STORE_VIEW } from './config.mjs';

export class BulkError extends Error {
  constructor(message, code = 'BULK_ERROR', details) { super(message); this.code = code; this.details = details; }
}

const MONEY = 'value currency';
const CART_FIELDS = `id total_quantity
  items{ uid quantity
    product{ sku name url_key }
    prices{ row_total{${MONEY}} price{${MONEY}} }
    ... on ConfigurableCartItem{ configurable_options{ option_label value_label } configured_variant{ sku stock_status } } }
  applied_coupons{ code }
  prices{ grand_total{${MONEY}} subtotal_including_tax{${MONEY}} discounts{ label amount{${MONEY}} } }`;

const PRODUCT_FIELDS = `__typename uid sku name url_key stock_status
  price_range{ minimum_price{ final_price{${MONEY}} regular_price{${MONEY}} } maximum_price{ final_price{${MONEY}} } }`;

const stripHtml = h => String(h ?? '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const norm = s => String(s ?? '').toLocaleLowerCase('it').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '');

export function productUrl(p) { return p?.url_key ? `${SITE}${STORE_PATH}/products/${p.url_key}/${String(p.sku).toLowerCase()}` : undefined; }

function mapPrice(pr) {
  const min = pr?.minimum_price, max = pr?.maximum_price;
  return { from: min?.final_price?.value, to: max?.final_price?.value, regular: min?.regular_price?.value, currency: min?.final_price?.currency ?? 'EUR' };
}

export function mapProduct(p) {
  return { sku: p.sku, uid: p.uid, name: p.name, urlKey: p.url_key, type: p.__typename, inStock: p.stock_status === 'IN_STOCK',
    price: mapPrice(p.price_range), url: productUrl(p) };
}

export function mapCart(c) {
  if (!c) return null;
  return {
    totalQuantity: c.total_quantity,
    items: (c.items ?? []).filter(Boolean).map(i => ({
      itemUid: i.uid, sku: i.configured_variant?.sku ?? i.product?.sku, parentSku: i.product?.sku, name: i.product?.name,
      urlKey: i.product?.url_key, quantity: i.quantity,
      options: Object.fromEntries((i.configurable_options ?? []).map(o => [o.option_label, o.value_label])),
      unitPrice: i.prices?.price?.value, rowTotal: i.prices?.row_total?.value
    })),
    coupons: (c.applied_coupons ?? []).map(x => x.code),
    subtotal: c.prices?.subtotal_including_tax?.value,
    discounts: (c.prices?.discounts ?? []).map(d => ({ label: d.label, amount: d.amount?.value })),
    grandTotal: c.prices?.grand_total?.value, currency: c.prices?.grand_total?.currency ?? 'EUR'
  };
}

/** Picks the variant matching the requested option labels, e.g. {Gusto:'Vaniglia', Confezione:'2kg'} or {flavour:'vaniglia', size:'2kg'}. */
export function resolveVariant(product, wanted = {}) {
  const opts = product.configurable_options ?? [];
  if (!opts.length) return { sku: product.sku, selectedOptions: [], label: {} };
  const aliases = { flavour: ['bp_flavour', 'gusto'], flavor: ['bp_flavour', 'gusto'], gusto: ['bp_flavour', 'gusto'], size: ['bp_size', 'confezione'], formato: ['bp_size', 'confezione'], confezione: ['bp_size', 'confezione'] };
  const selected = [], label = {}, missing = [];
  for (const o of opts) {
    const keys = [o.attribute_code, o.label].map(norm);
    const entry = Object.entries(wanted).find(([k]) => keys.includes(norm(k)) || (aliases[norm(k)] ?? []).some(a => keys.includes(norm(a))));
    if (!entry) { missing.push({ option: o.label, values: o.values.map(v => v.label) }); continue; }
    const v = o.values.find(v => norm(v.label) === norm(entry[1]));
    if (!v) throw new BulkError(`"${entry[1]}" non è un valore valido per ${o.label}`, 'INVALID_OPTION', { option: o.label, values: o.values.map(v => v.label) });
    selected.push(v.uid); label[o.label] = v.label;
  }
  if (missing.length) throw new BulkError('Scegli tutte le opzioni del prodotto', 'OPTIONS_REQUIRED', { missing });
  const variant = (product.variants ?? []).find(vr => vr.attributes.every(a => selected.includes(a.uid)));
  if (!variant) throw new BulkError('Combinazione non disponibile', 'VARIANT_NOT_FOUND', { label });
  return { sku: product.sku, variantSku: variant.product.sku, inStock: variant.product.stock_status === 'IN_STOCK',
    unitPrice: variant.product.price_range?.minimum_price?.final_price?.value, selectedOptions: selected, label };
}

export class BulkClient {
  #last = 0; #queue = Promise.resolve();
  constructor({ getSession = () => null, minIntervalMs = 600, fetchImpl = fetch } = {}) {
    this.getSession = getSession; this.minIntervalMs = minIntervalMs; this.fetch = fetchImpl;
  }

  /** Serialized, rate-limited GraphQL call. Never retried automatically. */
  gql(query, variables = {}, { auth = false } = {}) {
    const run = async () => {
      const wait = this.#last + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.#last = Date.now();
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Store: STORE_VIEW, 'User-Agent': 'bulk-copilot-mcp/0.2 (personal shopping assistant)' };
      if (auth) {
        const session = await this.getSession();
        if (!session) throw new BulkError('Non sei collegato a Bulk: esegui `npm run login`', 'AUTH_REQUIRED');
        headers.Cookie = session;
      }
      let res;
      try { res = await this.fetch(GRAPHQL_URL, { method: 'POST', headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000) }); }
      catch { throw new BulkError('Bulk non raggiungibile', 'NETWORK_ERROR'); }
      if (res.status === 429) throw new BulkError('Bulk sta limitando le richieste, riprova tra poco', 'RATE_LIMITED');
      let body; try { body = await res.json(); } catch { throw new BulkError(`Risposta non valida da Bulk (HTTP ${res.status})`, 'BAD_RESPONSE'); }
      if (body.errors?.length) {
        const e = body.errors[0], cat = e.extensions?.category;
        if (cat === 'graphql-authorization' || /isn't authorized|not authorized/i.test(e.message))
          throw new BulkError('Sessione Bulk scaduta: esegui di nuovo `npm run login`', 'AUTH_EXPIRED');
        throw new BulkError(e.message, cat === 'graphql-no-such-entity' ? 'NOT_FOUND' : cat === 'graphql-input' ? 'INPUT_REJECTED' : 'GRAPHQL_ERROR');
      }
      return body.data;
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => {});
    return p;
  }

  // ---- catalog (public)
  /**
   * Catalog listing. `query` and/or `categoryUid`; `suitable` / `type` are labels resolved to option ids
   * through the live aggregations. Price range and in-stock filtering are applied locally (the API
   * has no price filter), so totals refer to the server-side filters.
   */
  async search(query, { page = 1, pageSize = 12, sort = 'relevance', categoryUid, suitable, type, minPrice, maxPrice, inStockOnly } = {}) {
    const sortArg = sort === 'price_asc' ? '{price:ASC}' : sort === 'price_desc' ? '{price:DESC}' : sort === 'name' ? '{name:ASC}' : query ? '{relevance:DESC}' : '{position:ASC}';
    const filter = {};
    if (categoryUid) filter.category_uid = { eq: categoryUid };
    if (suitable) filter.grouped_bp_suitable = { eq: await this.#optionId('grouped_bp_suitable', suitable) };
    if (type) filter.grouped_type = { eq: await this.#optionId('grouped_type', type) };
    const d = await this.gql(`query(${query ? '$q:String!,' : ''}$p:Int!,$s:Int!,$f:ProductAttributeFilterInput){ products(${query ? 'search:$q,' : ''}filter:$f,currentPage:$p,pageSize:$s,sort:${sortArg}){
      total_count page_info{ current_page total_pages } items{ ${PRODUCT_FIELDS} } } }`, { ...(query ? { q: query } : {}), p: page, s: pageSize, f: filter });
    let products = d.products.items.map(mapProduct);
    if (inStockOnly) products = products.filter(p => p.inStock);
    if (minPrice !== undefined) products = products.filter(p => (p.price.to ?? p.price.from) >= minPrice);
    if (maxPrice !== undefined) products = products.filter(p => p.price.from <= maxPrice);
    return { total: d.products.total_count, page: d.products.page_info.current_page, totalPages: d.products.page_info.total_pages, products,
      ...(minPrice !== undefined || maxPrice !== undefined || inStockOnly ? { note: 'Filtri prezzo/disponibilità applicati su questa pagina di risultati.' } : {}) };
  }

  #options = new Map();
  /** Resolves a filter label (e.g. "Vegano", "Powder") to its option id using live aggregations. */
  async #optionId(code, label) {
    if (!this.#options.has(code)) {
      const d = await this.gql('{ products(search:"",pageSize:1){ aggregations{ attribute_code options{ label value } } } }');
      for (const a of d.products.aggregations ?? []) this.#options.set(a.attribute_code, a.options);
    }
    const opts = this.#options.get(code) ?? [];
    const o = opts.find(x => x.label.toLowerCase() === String(label).toLowerCase());
    if (!o) throw new BulkError(`Filtro "${label}" non disponibile`, 'INVALID_OPTION', { values: opts.map(x => x.label) });
    return o.value;
  }
  async filterOptions() {
    await this.#optionId('grouped_bp_suitable', '__probe__').catch(() => {});
    return { suitable: (this.#options.get('grouped_bp_suitable') ?? []).map(o => o.label), type: (this.#options.get('grouped_type') ?? []).map(o => o.label) };
  }

  async categories() {
    const node = `uid name url_path product_count include_in_menu`;
    const d = await this.gql(`{ categories(filters:{}){ items{ children{ ${node} children{ ${node} children{ ${node} } } } } } }`);
    const walk = (list, depth) => (list ?? []).filter(c => c.product_count > 0 || c.children?.length)
      .map(c => ({ uid: c.uid, name: c.name.trim(), path: c.url_path, products: c.product_count, inMenu: Boolean(c.include_in_menu),
        ...(c.children?.length && depth < 3 ? { children: walk(c.children, depth + 1) } : {}) }));
    return walk(d.categories.items[0]?.children, 1);
  }

  /** Discounted products from the store's "Offerte" category, sorted by discount. */
  async offers({ page = 1, pageSize = 24 } = {}) {
    const cats = await this.gql('{ categories(filters:{url_path:{eq:"todays-offers-eu"}}){ items{ uid name } } }');
    const cat = cats.categories.items[0];
    const d = await this.gql(`query($f:ProductAttributeFilterInput,$p:Int!,$s:Int!){ products(filter:$f,currentPage:$p,pageSize:$s){ total_count page_info{ total_pages }
      items{ ${PRODUCT_FIELDS} price_range{ minimum_price{ discount{ percent_off amount_off } } } } } }`,
      { f: cat ? { category_uid: { eq: cat.uid } } : {}, p: page, s: pageSize });
    const products = d.products.items.map(i => ({ ...mapProduct(i), discountPercent: Math.round(i.price_range?.minimum_price?.discount?.percent_off ?? 0) }))
      .filter(p => p.discountPercent > 0 || !cat).sort((a, b) => b.discountPercent - a.discountPercent);
    return { category: cat?.name ?? null, total: d.products.total_count, totalPages: d.products.page_info.total_pages, products };
  }

  async orderGet(number) {
    const d = await this.gql(`query($n:String!){ customer{ orders(filter:{number:{eq:$n}}){ items{ number order_date status carrier shipping_method
      total{ grand_total{${MONEY}} subtotal_incl_tax{${MONEY}} total_shipping{${MONEY}} discounts{ label amount{${MONEY}} } }
      items{ product_name product_sku product_url_key quantity_ordered quantity_shipped quantity_canceled selected_options{ label value } product_sale_price{${MONEY}} }
      shipments{ number tracking{ carrier number title } } payment_methods{ name } applied_coupons{ code } } } } }`, { n: String(number) }, { auth: true });
    const o = d.customer.orders.items[0];
    if (!o) throw new BulkError('Ordine non trovato', 'NOT_FOUND');
    return { number: o.number, date: o.order_date, status: o.status, shippingMethod: o.shipping_method,
      totals: { grandTotal: o.total?.grand_total?.value, subtotal: o.total?.subtotal_incl_tax?.value, shipping: o.total?.total_shipping?.value,
        discounts: (o.total?.discounts ?? []).map(x => ({ label: x.label, amount: x.amount?.value })) },
      items: o.items.map(i => ({ name: i.product_name, sku: i.product_sku, urlKey: i.product_url_key, quantity: i.quantity_ordered, shipped: i.quantity_shipped,
        canceled: i.quantity_canceled, unitPrice: i.product_sale_price?.value, options: Object.fromEntries((i.selected_options ?? []).map(s => [s.label, s.value])) })),
      shipments: (o.shipments ?? []).map(s => ({ number: s.number, tracking: (s.tracking ?? []).map(t => ({ carrier: t.carrier, number: t.number })) })),
      payment: (o.payment_methods ?? []).map(p => p.name), coupons: (o.applied_coupons ?? []).map(c => c.code) };
  }

  async rewards() {
    const d = await this.gql(`{ customer{ reward_points{ balance{ points money{${MONEY}} } exchange_rates{ earning{ points currency_amount } redemption{ points currency_amount } } }
      store_credit{ enabled current_balance{${MONEY}} } } }`, {}, { auth: true });
    const r = d.customer.reward_points, s = d.customer.store_credit;
    return { points: r?.balance?.points ?? null, pointsValue: r?.balance?.money?.value ?? null,
      earning: r?.exchange_rates?.earning ? `${r.exchange_rates.earning.points} punto ogni ${r.exchange_rates.earning.currency_amount} €` : null,
      redemption: r?.exchange_rates?.redemption ? `${r.exchange_rates.redemption.points} punto = ${r.exchange_rates.redemption.currency_amount} €` : null,
      storeCredit: s?.enabled ? s.current_balance?.value ?? 0 : null };
  }

  async addresses() {
    const d = await this.gql('{ customer{ addresses{ id firstname lastname street city postcode region{ region } country_code default_shipping default_billing } } }', {}, { auth: true });
    return d.customer.addresses.map(a => ({ id: a.id, name: [a.firstname, a.lastname].filter(Boolean).join(' '), street: (a.street ?? []).join(', '),
      city: a.city, postcode: a.postcode, region: a.region?.region, country: a.country_code, defaultShipping: Boolean(a.default_shipping), defaultBilling: Boolean(a.default_billing) }));
  }

  async paymentMethods(cartId, auth) {
    const d = await this.gql('query($c:String!){ cart(cart_id:$c){ available_payment_methods{ code title } } }', { c: cartId }, { auth });
    return (d.cart.available_payment_methods ?? []).map(m => ({ code: m.code, title: m.title }));
  }

  async wishlistEnabled() {
    const d = await this.gql('{ storeConfig{ magento_wishlist_general_is_enabled } }');
    return d.storeConfig.magento_wishlist_general_is_enabled === '1';
  }

  /** Shipping options for Italy without saving any address (Magento estimate). */
  async estimateShipping(cartId, auth) {
    const d = await this.gql(`mutation($c:String!){ estimateShippingMethods(input:{cart_id:$c,address:{country_code:IT}}){ carrier_title method_title amount{ value } available error_message } }`,
      { c: cartId }, { auth });
    return (d.estimateShippingMethods ?? []).filter(m => m.available).map(m => ({ method: m.method_title, cost: m.amount?.value }));
  }

  async rawProduct({ urlKey, sku }) {
    if (!urlKey && !sku) throw new BulkError('Serve urlKey o sku', 'INVALID_ARGUMENT');
    const q = `query(${urlKey ? '$k:String!' : '$q:String!'}){ products(${urlKey ? 'filter:{url_key:{eq:$k}}' : 'search:$q'},pageSize:${urlKey ? 1 : 20}){ items{ ${PRODUCT_FIELDS}
      description{ html } short_description{ html }
      ... on ConfigurableProduct{ configurable_options{ attribute_code label values{ uid label } }
        variants{ attributes{ code label uid } product{ sku stock_status price_range{ minimum_price{ final_price{${MONEY}} regular_price{${MONEY}} } } } } } } } }`;
    const d = await this.gql(q, urlKey ? { k: urlKey } : { q: sku });
    const items = d.products.items;
    const hit = urlKey ? items[0] : items.find(i => i.sku === sku || i.variants?.some(v => v.product.sku === sku));
    if (!hit) throw new BulkError('Prodotto non trovato', 'NOT_FOUND');
    return hit;
  }

  async productDetails(ref) {
    const p = await this.rawProduct(ref);
    return { ...mapProduct(p),
      options: (p.configurable_options ?? []).map(o => ({ name: o.label, code: o.attribute_code, values: o.values.map(v => v.label) })),
      variants: (p.variants ?? []).map(v => ({ sku: v.product.sku, inStock: v.product.stock_status === 'IN_STOCK',
        options: Object.fromEntries(v.attributes.map(a => [p.configurable_options.find(o => o.attribute_code === a.code)?.label ?? a.code, a.label])),
        price: v.product.price_range?.minimum_price?.final_price?.value, regularPrice: v.product.price_range?.minimum_price?.regular_price?.value })),
      description: stripHtml(p.description?.html || p.short_description?.html).slice(0, 3000) };
  }

  // ---- account
  async verifyCustomer() {
    try { await this.gql('{ customer{ firstname } }', {}, { auth: true }); return 'verified'; }
    catch (e) { if (['AUTH_REQUIRED', 'AUTH_EXPIRED'].includes(e.code)) return e.code === 'AUTH_REQUIRED' ? 'guest' : 'expired'; throw e; }
  }

  async orders({ page = 1, pageSize = 10 } = {}) {
    const d = await this.gql(`query($p:Int!,$s:Int!){ customer{ orders(currentPage:$p,pageSize:$s,sort:{sort_field:CREATED_AT,sort_direction:DESC}){ total_count
      items{ number order_date status total{ grand_total{${MONEY}} } items{ product_name product_sku quantity_ordered } } } } }`, { p: page, s: pageSize }, { auth: true });
    const o = d.customer.orders;
    return { total: o.total_count, orders: o.items.map(i => ({ number: i.number, date: i.order_date, status: i.status, total: i.total?.grand_total?.value,
      items: i.items.map(x => ({ name: x.product_name, sku: x.product_sku, quantity: x.quantity_ordered })) })) };
  }

  // ---- cart
  async customerCartId() { return (await this.gql('{ customerCart{ id } }', {}, { auth: true })).customerCart.id; }
  async createGuestCart() { return (await this.gql('mutation{ createGuestCart{ cart{ id } } }')).createGuestCart.cart.id; }
  async readCart(cartId, auth) { return mapCart((await this.gql(`query($c:String!){ cart(cart_id:$c){ ${CART_FIELDS} } }`, { c: cartId }, { auth })).cart); }

  async addToCart(cartId, auth, { sku, quantity, selectedOptions }) {
    const d = await this.gql(`mutation($c:String!,$i:[CartItemInput!]!){ addProductsToCart(cartId:$c,cartItems:$i){ cart{ ${CART_FIELDS} } user_errors{ code message } } }`,
      { c: cartId, i: [{ sku, quantity, selected_options: selectedOptions }] }, { auth });
    const r = d.addProductsToCart;
    if (r.user_errors?.length) throw new BulkError(r.user_errors.map(e => e.message).join('; '), 'CART_REJECTED');
    return mapCart(r.cart);
  }
  async updateItem(cartId, auth, itemUid, quantity) {
    const d = await this.gql(`mutation($c:String!,$u:ID!,$q:Float!){ updateCartItems(input:{cart_id:$c,cart_items:[{cart_item_uid:$u,quantity:$q}]}){ cart{ ${CART_FIELDS} } } }`, { c: cartId, u: itemUid, q: quantity }, { auth });
    return mapCart(d.updateCartItems.cart);
  }
  async removeItem(cartId, auth, itemUid) {
    const d = await this.gql(`mutation($c:String!,$u:ID!){ removeItemFromCart(input:{cart_id:$c,cart_item_uid:$u}){ cart{ ${CART_FIELDS} } } }`, { c: cartId, u: itemUid }, { auth });
    return mapCart(d.removeItemFromCart.cart);
  }
  async applyCoupon(cartId, auth, code) {
    const d = await this.gql(`mutation($c:String!,$k:String!){ applyCouponToCart(input:{cart_id:$c,coupon_code:$k}){ cart{ ${CART_FIELDS} } } }`, { c: cartId, k: code }, { auth });
    return mapCart(d.applyCouponToCart.cart);
  }
  async removeCoupon(cartId, auth) {
    const d = await this.gql(`mutation($c:String!){ removeCouponFromCart(input:{cart_id:$c}){ cart{ ${CART_FIELDS} } } }`, { c: cartId }, { auth });
    return mapCart(d.removeCouponFromCart.cart);
  }
}
