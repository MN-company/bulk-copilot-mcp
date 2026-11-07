# Bulk Copilot MCP — istruzioni per agenti

Server MCP locale per bulk.com/it (Adobe Commerce GraphQL `https://www.bulk.com/it/graphql/`, header `Store: bp_italy_view`). Dati nutrizionali e di etichetta per variante: Catalog Service `/it/cs-graphql` (config da `/it/configs.json`). Leggi `skills/bulk-shopping/SKILL.md` prima di usare i tool.

Regole non negoziabili: le modifiche al carrello passano da prepare → riepilogo all'utente → approvazione esplicita → commit una sola volta. Non ripetere mai una scrittura dall'esito incerto. Mai chiedere la password: il login lo fa l'utente con `npm run login`. Mai definire un prodotto "sicuro" per allergie o salute. Niente checkout dall'MCP.

Sviluppo: `npm ci`, `npm run check`, `npm test`, `npm run smoke`. Non committare `.env`, `*.sqlite`, la cartella dati.
