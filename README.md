# Bulk Copilot MCP

Server MCP locale per fare acquisti su **bulk.com/it**. È il primo della suite integratori, poi arrivano Tsunami e Prozis, ognuno come MCP separato. Usa l'API GraphQL ufficiale di Adobe Commerce del sito, senza scraping.

## Avvio
```bash
npm ci
npm start            # http://127.0.0.1:3789/mcp
npm run smoke        # controllo live in sola lettura
npm test
```
Registrazione in Claude Code: `claude mcp add --transport http -s user bulk http://127.0.0.1:3789/mcp`

## Account (opzionale)
Senza login si lavora con un **carrello guest** locale. Per usare il tuo carrello e vedere gli ordini:
```bash
npx playwright install chromium   # solo la prima volta
npm run login                     # accedi TU nella finestra del browser, poi premi INVIO
npm run login -- --logout         # rimuove la sessione locale
```
Bulk usa la sessione Magento classica (cookie `PHPSESSID` su `/it`), che l'API GraphQL accetta. I cookie restano in `~/.bulk-copilot/session-cookies.json` (0600) e nessun tool li restituisce. Quando un tool risponde `AUTH_EXPIRED`, ripeti il login. Se il profilo del browser è ancora collegato basta `npm run login -- --from-profile`, che non apre finestre.

Se `npx playwright install` non va, puoi usare un Chromium già presente: `BROWSER_EXECUTABLE=<percorso chrome.exe>` (vedi `login-local.ps1`).

## Tool (v0.2.0)
| Area | Tool | Note |
|---|---|---|
| Sessione | `bulk_session_status`, `bulk_release_info` | |
| Catalogo | `bulk_search` (filtri: categoria, "Adatto a" Vegano/Vegetariano/halal, tipo Powder/Capsule…, prezzo min/max, solo disponibili), `bulk_filters`, `bulk_categories`, `bulk_category_products`, `bulk_offers` | il filtro prezzo è applicato localmente sulla pagina di risultati |
| Prodotto | `bulk_product_details` (varianti + `netWeightG`, `pricePerKg`, `proteinPer100g`, `pricePerGramProtein`, ingredienti, allergeni, controllo preferenze), `bulk_nutrition`, `bulk_reviews` | nutrizione dal Catalog Service per variante; recensioni Yotpo solo aggregate |
| Carrello | `bulk_get_cart` (con soglia spedizione gratuita 55 € e costi stimati per l'Italia), `bulk_prepare_cart_change` → `bulk_commit_cart_change`, `bulk_cart_plan_status` | operazioni: add, **reorder**, update, remove, coupon_apply, coupon_remove |
| Account | `bulk_orders`, `bulk_order_get` (articoli, totali, tracking), `bulk_rewards` (punti e credito), `bulk_addresses`, `bulk_payment_methods` | sola lettura, serve il login |
| Wishlist | `bulk_wishlist` | disattivata dal negozio Bulk Italia: il tool lo verifica e lo dice |
| Preferenze | `bulk_preferences_get/set/remove` | locali: vegan, vegetarian, gluten_free, lactose_free, halal, ingredienti da evitare, gusti e marchi |
| Altro | `bulk_price_history` | |

Le preferenze producono solo segnali: `possibile_conflitto`, `nessun_conflitto_rilevato` (nei dati disponibili) o `dati_insufficienti`. Non dicono mai che un prodotto è "sicuro".

Fonti: core GraphQL `/it/graphql/` (catalogo, carrello, account), Catalog Service `/it/cs-graphql` (attributi per variante, configurazione pubblica letta da `/it/configs.json`), Yotpo widget API (valutazioni).

Il checkout e il pagamento si fanno **solo sul sito**. Per disattivare le scritture: `ALLOW_CART_WRITES=false`.

## Variabili
`PORT` (3789), `BIND_HOST`, `BULK_DATA_DIR`, `BULK_PROFILE_DIR`, `BROWSER_CHANNEL=chrome`, `ALLOW_CART_WRITES`, `BULK_MIN_INTERVAL_MS` (600).

## Docker
```bash
docker compose up -d --build
```
Il container non ha browser: il login si fa sull'host con `npm run login`, e i cookie di sessione vengono letti dalla cartella `~/.bulk-copilot` montata in `/data`.
