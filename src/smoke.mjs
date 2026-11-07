/** Read-only live check against bulk.com public endpoints. Creates no cart. */
import { BulkClient } from './client.mjs';
const c = new BulkClient();
const s = await c.search('whey', { pageSize: 3 });
console.log('search:', s.total, s.products.map(p => `${p.name} €${p.price.from}`).join(' | '));
const d = await c.productDetails({ urlKey: s.products[0].urlKey });
console.log('details:', d.name, 'options:', d.options.map(o => `${o.name}=${o.values.length}`).join(','), 'variants:', d.variants.length);
console.log('account:', await c.verifyCustomer());
