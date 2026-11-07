/**
 * Local dietary preferences and allergen checks. The output is a signal, never a guarantee:
 * "possibile_conflitto" or "nessun_conflitto_rilevato" (in the available data) or "dati_insufficienti".
 */
export const DIETS = ['vegan', 'vegetarian', 'gluten_free', 'lactose_free', 'halal'];
export const EMPTY_PREFS = { diets: [], avoid: [], flavours: [], brands: [] };

const norm = s => String(s ?? '').toLocaleLowerCase('it').normalize('NFD').replace(/[̀-ͯ]/g, '');
const ANIMAL = ['latte', 'siero', 'whey', 'caseina', 'uova', 'uovo', 'miele', 'gelatina', 'collagene', 'pesce', 'carne', 'manzo', 'lanolina'];
const MEAT_FISH = ['gelatina', 'collagene', 'pesce', 'carne', 'manzo', 'krill'];
const GLUTEN = ['glutine', 'frumento', 'grano', 'orzo', 'segale', 'avena', 'farro', 'kamut'];
const LACTOSE = ['latte', 'lattosio', 'siero', 'whey', 'caseina', 'burro', 'panna'];

const mentions = (text, words) => words.filter(w => new RegExp(`\\b${w}`, 'i').test(text));

/**
 * product: { name, description, ingredients, allergens, mayContain, suitable: ['Vegano', ...], flavour }
 * Returns { status, reasons[], notes[] }.
 */
export function evaluateProduct(product, prefs = EMPTY_PREFS) {
  const reasons = [], notes = [];
  const ingredients = norm(product.ingredients);
  const mayContain = norm(product.mayContain);
  const all = norm([product.name, product.description, product.ingredients, product.allergens].join(' '));
  const suitable = (product.suitable ?? []).map(norm);
  const hasIngredients = Boolean(ingredients.trim());
  const diets = prefs.diets ?? [];
  if (!diets.length && !(prefs.avoid ?? []).length) return { status: 'nessuna_preferenza', reasons, notes };

  for (const d of diets) {
    if (d === 'vegan') {
      if (suitable.length && !suitable.some(s => s.startsWith('vegan'))) reasons.push('non indicato come vegano');
      const hit = mentions(ingredients, ANIMAL); if (hit.length) reasons.push(`ingredienti di origine animale: ${hit.join(', ')}`);
    } else if (d === 'vegetarian') {
      if (suitable.length && !suitable.some(s => s.startsWith('vegan') || s.startsWith('vegetarian'))) reasons.push('non indicato come vegetariano');
      const hit = mentions(ingredients, MEAT_FISH); if (hit.length) reasons.push(`ingredienti non vegetariani: ${hit.join(', ')}`);
    } else if (d === 'halal') {
      if (suitable.length && !suitable.includes('halal')) reasons.push('non indicato come halal');
    } else if (d === 'gluten_free') {
      const hit = mentions(ingredients, GLUTEN); if (hit.length) reasons.push(`ingredienti con glutine: ${hit.join(', ')}`);
      if (mentions(mayContain, ['glutine']).length) notes.push('può contenere tracce di glutine (dichiarazione del produttore)');
    } else if (d === 'lactose_free') {
      const hit = mentions(ingredients, LACTOSE); if (hit.length) reasons.push(`ingredienti derivati dal latte: ${hit.join(', ')}`);
      if (mentions(mayContain, ['latte']).length) notes.push('può contenere tracce di latte');
    }
  }
  for (const a of prefs.avoid ?? []) {
    if (norm(a) && all.includes(norm(a))) reasons.push(`contiene o menziona "${a}"`);
    if (norm(a) && mayContain.includes(norm(a))) notes.push(`può contenere tracce di "${a}"`);
  }
  const status = reasons.length ? 'possibile_conflitto' : hasIngredients ? 'nessun_conflitto_rilevato' : 'dati_insufficienti';
  if (status === 'nessun_conflitto_rilevato') notes.push('Nessun conflitto rilevato nei dati disponibili: non è una garanzia, verifica sempre l\'etichetta.');
  if (status === 'dati_insufficienti') notes.push('Ingredienti non disponibili: impossibile valutare.');
  return { status, reasons, notes };
}

/** Lightweight check for search results (name only, no ingredients). */
export function quickFlags(name, prefs = EMPTY_PREFS) {
  const n = norm(name), flags = [];
  for (const a of prefs.avoid ?? []) if (norm(a) && n.includes(norm(a))) flags.push(`nome contiene "${a}"`);
  if ((prefs.diets ?? []).includes('vegan') && /\b(whey|siero|caseina|collagene)/.test(n)) flags.push('probabilmente non vegano (dal nome)');
  const preferredFlavour = (prefs.flavours ?? []).find(f => n.includes(norm(f)));
  const preferredBrand = (prefs.brands ?? []).find(b => n.includes(norm(b)));
  return { flags, ...(preferredFlavour ? { preferredFlavour } : {}), ...(preferredBrand ? { preferredBrand } : {}) };
}

export function mergePrefs(current, patch) {
  const uniq = a => [...new Set(a.map(x => String(x).trim()).filter(Boolean))];
  return {
    diets: uniq([...(current.diets ?? []), ...(patch.diets ?? [])]).filter(d => DIETS.includes(d)),
    avoid: uniq([...(current.avoid ?? []), ...(patch.avoid ?? [])]),
    flavours: uniq([...(current.flavours ?? []), ...(patch.flavours ?? [])]),
    brands: uniq([...(current.brands ?? []), ...(patch.brands ?? [])])
  };
}
export function removePrefs(current, patch) {
  const drop = (a, b) => (a ?? []).filter(x => !(b ?? []).map(norm).includes(norm(x)));
  return { diets: drop(current.diets, patch.diets), avoid: drop(current.avoid, patch.avoid), flavours: drop(current.flavours, patch.flavours), brands: drop(current.brands, patch.brands) };
}
