# Filled and empty cylinder stock

Run `npm run migrate:cylinders` from Backend before starting the updated API.
The migration is additive and can be rerun.

- `Inventory.StockOnHand` is filled/sellable stock. Existing balances are preserved.
- `Inventory.EmptyStock` is a separate empty cylinder count, initially zero.
- Both counts belong to a product and warehouse. Cylinder/LPG categories and kg products track empties; accessories retain ordinary sellable stock.
- POS reserves or sells only StockOnHand. EmptyStock never contributes to sale availability or the reorder calculation for filled stock.
- Walk-in payment, pickup claim, and delivery completion accept `emptyReturns: [{productId, quantity}]`. The Empty tank received checkbox supplies one returned empty for each cylinder sold; leaving it unchecked records no returns. Inventory is updated when the transaction or fulfillment is confirmed. Quantities cannot exceed the corresponding cylinder quantities sold.
- Return stock is credited to the original allocated warehouse in the same database transaction as fulfillment/payment. Repeated completion cannot credit returns twice. Cancelled/unfulfilled orders restore filled stock without generating empty returns.
- Inventory stock-in/out and transfers accept `stockType: "filled" | "empty"`, defaulting to filled for older clients. Transactions identify empty movements separately; transfers store StockType.
- `POST /inventory/:id/cylinders` supports `refill` and `set-empty` with quantity, remarks, and expectedEmptyStock. Remarks are optional for refill and required for set-empty. Refill subtracts from empties and adds the same count to filled stock atomically. Set-empty reconciles a physical count without changing filled stock. Stale counts are rejected.

Use the Inventory Edit action to select Edit Filled Stock, Edit Empty Stock, or
Refill Empty Tanks. Enter physically counted opening empty balances with Edit
Empty Stock. Historical
EmptyCylinderReturned flags are preserved but are not backfilled: they do not
establish cylinder quantities or reliable stock allocations. Existing mixed stock
must be counted and separated using the filled stock edit and empty stock count.
