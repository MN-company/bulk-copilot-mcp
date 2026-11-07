import { labelFacts } from './catalog.mjs';
import { compareFields, netWeightGrams, parseNutritionTable, proteinPer100 } from './nutrition.mjs';
import { evaluateProduct } from './preferences.mjs';
import { BulkError } from './client.mjs';

/** Adds per-variant nutrition, compare fields and label facts (from the Catalog Service) to product details. */
export async function enrichDetails(client, catalog, ref, prefs) {
  const d = await client.productDetails(ref);
  let attrs = new Map();
  try { attrs = await catalog.attributesFor(d.sku); } catch { /* catalog down: details stay usable */ }
  const variantsIn = d.variants.length ? d.variants : [{ sku: d.sku, inStock: d.inStock, options: {}, price: d.price.from, regularPrice: d.price.regular }];
  const variants = variantsIn.map(v => {
    const a = attrs.get(v.sku) ?? {};
    const rows = parseNutritionTable(a.nutrition_table);
    const netWeightG = netWeightGrams({ weightNetKg: a.weight_net, sizeLabel: a.bp_size ?? Object.values(v.options).find(x => /\d\s*k?g\b/i.test(x)) });
    return { ...v, ...compareFields({ price: v.price, netWeightG, proteinPer100g: proteinPer100(rows) }), hasNutritionTable: Boolean(rows) };
  });
  const firstSku = variantsIn[0].sku;
  const facts = labelFacts(attrs.get(firstSku) ?? attrs.get(d.sku) ?? {});
  const check = evaluateProduct({ name: d.name, description: d.description, ...facts }, prefs);
  return { ...d, variants, label: { ...facts, source: attrs.size ? 'catalog_service' : 'non_disponibile', referenceVariant: firstSku },
    preferenceCheck: check };
}

/** Full nutrition table for one variant (or the first one), plus compare fields for every variant. */
export async function nutritionFor(client, catalog, ref, variantSku) {
  const d = await enrichDetails(client, catalog, ref, { diets: [], avoid: [] });
  const attrs = await catalog.attributesFor(d.sku);
  const sku = variantSku ?? d.variants.find(v => v.hasNutritionTable)?.sku ?? d.variants[0].sku;
  const a = attrs.get(sku);
  if (!a) throw new BulkError('Variante non trovata nel catalogo', 'NOT_FOUND');
  const rows = parseNutritionTable(a.nutrition_table);
  const facts = labelFacts(a);
  return { product: d.name, sku, ...(rows ? { table: rows } : { table: null, note: 'Bulk non pubblica una tabella nutrizionale per questa variante: nessun valore inventato.' }),
    servingSize: facts.servingSize, servings: facts.servings, proteinPerServingG: facts.proteinPerServingG, proteinPer100g: proteinPer100(rows),
    variants: d.variants.map(v => ({ sku: v.sku, options: v.options, price: v.price, inStock: v.inStock, netWeightG: v.netWeightG, pricePerKg: v.pricePerKg,
      proteinPer100g: v.proteinPer100g, pricePerGramProtein: v.pricePerGramProtein })) };
}
