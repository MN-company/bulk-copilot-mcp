---
name: supplements-compare
description: Confrontare prezzi e convenienza di integratori tra Bulk, Tsunami Nutrition e Prozis usando i tre MCP della suite (bulk_*, tsunami_*, prozis_*). Usala per "dove conviene comprare X", "quanto costa al grammo di proteina", "carrello più economico".
---
# Confronto integratori tra Bulk, Tsunami e Prozis

I tre MCP sono separati: questa skill li usa insieme. Usa solo i server attivi (`*_release_info`); se uno non risponde, dillo e confronta gli altri.

## 1. Cercare lo stesso tipo di prodotto
Chiama in parallelo `bulk_search`, `tsunami_search`, `prozis_search` con lo stesso termine (es. "whey", "creatina"). Tieni 2–4 candidati pertinenti per sito, scartando bundle, campioni e prodotti di altro tipo.

## 2. Ottenere i numeri normalizzati
Per ogni candidato:
- Bulk: `bulk_product_details` (ogni variante ha `netWeightG`, `pricePerKg`, `proteinPer100g`, `pricePerGramProtein`).
- Tsunami: `tsunami_product_details` (+ `tsunami_nutrition` se servono i dettagli).
- Prozis: `prozis_product_details` con `withNutrition: true` (blocco `compare` per variante), oppure `prozis_nutrition`.

Metriche:
- **Proteine** (whey, isolate, vegetali, barrette): `€/g di proteina` = prezzo / (peso netto g × proteine per 100 g / 100). È la metrica principale.
- **Altro** (creatina, aminoacidi, vitamine): `€/kg` o `€/dose` (stessa dose!).
- Se un dato manca, scrivi "dato non disponibile" e non stimarlo. Non confrontare una variante senza peso o proteine con una che li ha.

Attenzione:
- Prozis: il prezzo in scheda può dipendere da un codice promo (`priceCoupons`/`priceNote`) e nel carrello può essere diverso (`priceChanges`). Riportalo sempre.
- Tsunami: la tabella nutrizionale può riferirsi a un solo gusto (`tableFlavour`).
- Usa la stessa confezione (o il formato più conveniente di ciascun sito) e dichiara quale.

## 3. Costo vero con la spedizione
Soglie di spedizione gratuita (verificate dagli MCP, rileggile con `*_get_cart` o `*_release_info` se servono valori aggiornati):
- Bulk: gratis da 55 €, altrimenti 4,95 € (standard).
- Tsunami: gratis da 29 €, altrimenti 7 €.
- Prozis: gratis da 29,99 €, altrimenti ~4,60 € (vale il valore del carrello).

Per una lista ("1 kg whey vaniglia + 500 g creatina"):
1. Per ogni articolo trova l'opzione migliore per sito (metrica del punto 2).
2. Calcola il totale per ogni scenario: tutto su un sito (per ciascuno dei 3), oppure divisione su due siti solo se il risparmio supera le spedizioni aggiuntive.
3. Somma prodotti + spedizione (0 se sopra soglia). Indica quanto manca alla soglia e se aggiungere un articolo utile la supera.

## 4. Presentare il risultato
Tabella con: sito, prodotto, variante, prezzo, €/kg, €/g proteina (o €/dose), disponibilità, note (promo, preordine, prezzo carrello diverso). Poi il carrello consigliato con totale e spedizione, e la seconda scelta.

## 5. Regole
- Nessuna modifica ai carrelli durante il confronto. Se l'utente sceglie, per ogni sito: `*_prepare_cart_change` → riepilogo → OK esplicito → `*_commit_cart_change` una volta. Il pagamento si fa sui siti.
- Applica le preferenze dell'utente (`*_preferences_get`): segnala "possibile conflitto"; mai dire che un prodotto è "sicuro" per allergie.
- Niente consigli medici o di dosaggio. I prezzi cambiano: indica che sono rilevati ora.
