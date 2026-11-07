---
name: bulk-shopping
description: Fare acquisti di integratori su Bulk Italia tramite il server MCP bulk (bulk_* tools).
---
1. `bulk_session_status`: capisci se il carrello è del cliente o guest.
2. Trovare prodotti: `bulk_search` (con filtri `suitable`, `type`, `categoryUid`, prezzo, `inStockOnly`), `bulk_categories` → `bulk_category_products`, `bulk_offers` per gli sconti attivi.
3. `bulk_product_details` per gusto e confezione: usa i nomi delle opzioni esattamente come restituiti, es. `{"Gusto":"Vaniglia","Confezione":"2kg"}`. Per confrontare la convenienza usa `pricePerKg` e `pricePerGramProtein` delle varianti (o `bulk_nutrition` per la tabella completa). Se manca un dato, dillo: non stimarlo.
4. Preferenze: salvale con `bulk_preferences_set` solo su richiesta esplicita. Riporta `preferenceCheck` con le sue parole: "possibile conflitto" o "nessun conflitto rilevato nei dati disponibili". Mai "sicuro".
5. `bulk_prepare_cart_change`: mostra righe, prezzi, `shipping` (quanto manca ai 55 € per la consegna gratuita) e avvisi. Per "rifai l'ordine X" usa l'operazione `reorder` e segnala gli articoli saltati e i prezzi cambiati (`previousPrice`). Chiedi conferma.
6. Solo dopo un "sì" esplicito in un messaggio successivo: `bulk_commit_cart_change` con planId e confirmationPhrase.
7. `COMMIT_UNCERTAIN`: NON ripetere, rileggi con `bulk_get_cart`. `CART_REJECTED`: il sito ha rifiutato (es. coupon non valido) e non ha cambiato nulla.
8. Account (sola lettura): `bulk_orders`, `bulk_order_get` (tracking), `bulk_rewards`, `bulk_addresses`, `bulk_payment_methods`. Wishlist disattivata dal negozio.
9. Per pagare manda l'utente su https://www.bulk.com/it/cart.
Non dare consigli medici o di dosaggio.
