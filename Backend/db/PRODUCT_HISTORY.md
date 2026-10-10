# Product history migration

Run from Backend with the environment configured for the intended database:

```sh
npm run migrate:products
```

This idempotent migration adapts the existing normalized schema (`Product`, `Brand`, `Category`, `OrderDetails`). It backfills historical names and actual order line prices, changes every existing product foreign key to nullable `ON DELETE SET NULL`, and installs insert triggers that capture snapshots for all API, import, and seed writers. Inventory rows are retained so transactions retain their warehouse linkage. Original product/brand identities support annual compliance reports after deletion. Unit values are inferred from recognizable legacy capacity/length names where available; other unknown capacities remain unset for editing.

MySQL DDL commits automatically. If interrupted, rerun the migration to complete it. Apply it before deploying the API changes. The delete endpoint refuses deletion if the final snapshot trigger is absent. Fresh databases built with `schema.sql` also need this migration to install triggers; `npm run seed` invokes it automatically.

Verify against a populated development database:

```sh
node tests/productHistory.js
```

The integration check inserts isolated fixtures, verifies hard deletion and historical preservation across all five referencing tables, then rolls back all test changes.
