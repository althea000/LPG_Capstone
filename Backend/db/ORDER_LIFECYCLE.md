# Orders & Delivery lifecycle

Run from `Backend` against the intended configured database before deploying the new API:

```sh
npm run migrate:pos
```

The migration includes the Products history migration. It uses this application's existing `Order`, `OrderDetails`, `Delivery`, `Customer`, `Sales`, and `Inventory` tables and VARCHAR IDs. It adds independent pickup/delivery/payment states, unit snapshots, pickup deadlines, rider assignment, attempt logs, stock allocations, settlement records, and refund policy settings. Customer references on both Order and Sales use nullable `ON DELETE SET NULL`. `npm run seed` installs the same migrations after seeding; fresh `schema.sql` installations must still run the migration to install snapshot/lifecycle triggers.

Pickup deadlines are the scheduled calendar date plus two days at 18:00 (a three-day inclusive pickup window), using the database's Asia/Manila (+08:00) session timezone. The server checks expired pickups every minute and on queue reads. Unpaid pickups are restocked automatically; prepaid pickups become Unclaimed until a manager resolves them. Each order is locked during transitions; restocking and settlements are recorded once. Legacy completed orders remain archived. Historical sale prices are copied from order lines, rather than current catalog prices.

Each dispatch counts as one attempt. Failure reports update that attempt without incrementing again. Retries are scheduled for the next Monday–Friday business day at 08:00; holiday calendars are not configured. Attempts are capped at three. COD delivery confirmation records collected cash and retains Delivered + Unpaid until staff records remittance. Receiver signatures and empty-cylinder collection are captured.

Refund and forfeiture decisions are manager-only, are validated against current company settings, and preserve original payments. `OrderSettlement` records refunded and retained amounts. Archived Sales uses the retained amount for cancellation/logistics income; completed-sale reports exclude active fulfillment queues. This records settlement decisions and amounts; no external payment-provider integration is configured.

Rider (and existing Driver/Drivers) roles can only read their assigned delivery queue and confirm delivery or report failure. The app limits their navigation to `/orders-delivery?tab=delivery`; the API independently enforces the restriction, including legacy delivery routes.

New transactions save exact warehouse stock allocations. Migration backfills legacy allocations from matching stock-out transaction references. Orders with missing legacy allocation evidence cannot silently restock an arbitrary warehouse: the queue shows a reconciliation warning and leaves the order intact. Product stock edits require a warehouse and produce audited inventory adjustments.

Verification:

```sh
node tests/productHistory.js
node tests/orderLifecycle.js
```

The order integration test launches a local API with a separate fixture company and warehouse. It checks pickup expiry, payment/claim, concurrent settlement, current policy enforcement, refunds/forfeiture, delivery retry limits, rider isolation, COD remittance, unit snapshots, audited stock edits, Walk-in queue exclusion, and hard-delete history preservation. Fixture records are removed afterward. The product test rolls back its fixtures.

MySQL DDL commits automatically. Rerun the idempotent migration if interrupted. Neither migration resets existing data.
