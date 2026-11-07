/** Pure helpers: nutrition tables, net weight and the normalized compare fields shared by the suite. */

const num = s => { const m = String(s ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : undefined; };
const round = (n, d = 2) => (n === undefined || !Number.isFinite(n)) ? undefined : Math.round(n * 10 ** d) / 10 ** d;

/** Bulk's `nutrition_table` attribute: JSON rows {nutrition:{Nutrition}, per_100:{...}, per_serving:{...}}. */
export function parseNutritionTable(raw) {
  let rows;
  try { rows = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!Array.isArray(rows) || !rows.length) return null;
  const out = rows.map(r => ({
    name: String(Object.values(r.nutrition ?? {})[0] ?? '').trim(),
    per100: String(Object.values(r.per_100 ?? {})[0] ?? '').trim() || undefined,
    perServing: String(Object.values(r.per_serving ?? {})[0] ?? '').trim() || undefined
  })).filter(r => r.name);
  return out.length ? out : null;
}

export function proteinPer100(rows) {
  const r = rows?.find(x => /^(proteine|protein)/i.test(x.name));
  return r ? num(r.per100) : undefined;
}

/** Net weight in grams from an attribute in kg (e.g. "0.9") or a size label ("900g", "2.5kg", "1 kg"). Counts (capsules, tablets) are not weights. */
export function netWeightGrams({ weightNetKg, sizeLabel } = {}) {
  const kg = num(weightNetKg);
  if (kg && kg > 0) return Math.round(kg * 1000);
  const m = String(sizeLabel ?? '').toLowerCase().replace(',', '.').match(/(\d+(?:\.\d+)?)\s*(kg|g)\b/);
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (m[2] === 'kg' ? 1000 : 1));
}

/** Normalized fields used by the cross-site comparison: only computed when the inputs exist. */
export function compareFields({ price, netWeightG, proteinPer100g }) {
  const out = {};
  if (netWeightG) out.netWeightG = netWeightG;
  if (proteinPer100g !== undefined) out.proteinPer100g = proteinPer100g;
  if (price && netWeightG) out.pricePerKg = round(price / (netWeightG / 1000));
  if (price && netWeightG && proteinPer100g) out.pricePerGramProtein = round(price / (netWeightG * proteinPer100g / 100), 4);
  return out;
}
