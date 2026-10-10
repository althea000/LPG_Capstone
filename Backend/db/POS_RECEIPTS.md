# POS, receipts, and delivery fees

Run `npm run migrate:pos` from Backend before starting the updated API. This includes the product-history and order-lifecycle migrations. It links catalog products with empty ImageURL fields to matching files in Backend/uploads, adds fiscal/payment snapshots and an atomic document sequence, normalizes legacy customer types, and preserves customer order references when assigning CUST numbers.

New order identifiers are ORD-YEAR-NNN, sales numbers SALE-YEAR-NNN, and delivery numbers DEL-YEAR-NNN. Existing order references remain unchanged and are displayed consistently in Sales. Numbers retain at least three digits and continue past 999. Sequence locks prevent concurrent checkout collisions.

POS requires a payment method. Cash requires enough tender; GCash, Card and Bank Transfer require a reference number. COD is only available for Delivery and creates no paid payment record until remittance. The POS has no separate unpaid checkout action. Legacy unpaid pickup orders retain their collection/resolution workflow.

The three-day pickup window includes the scheduled date: October 9 through October 11, ending at 18:00. Existing active pickup deadlines are updated by the migration. Scheduled pickup and delivery details cannot be edited; delivery rider assignment remains editable.

Vehicle rates are company-specific. Delivery is free within the vehicle's free-distance threshold (default 5 km), or when a positive minimum subtotal is met. Otherwise the fee is base rate plus per-kilometre rate for distance beyond the free zone. Zero minimum subtotal disables the subtotal exemption. The server calculates and saves the actual fee; a client-supplied delivery fee is ignored. Disabled vehicles are unavailable in POS. Defaults also initialize when a new company first opens its vehicle rates.

POS prints a pickup slip for pickup, a delivery slip for COD delivery, and a sales invoice for Walk-in or prepaid delivery. Completed Sales reprints use sales invoices. Cash receipts omit references; digital receipts include them. New orders snapshot VAT and subtotal, and payments snapshot tender/reference/change for consistent reprinting.

Verification: `npm run test:orders`, `npm run test:products`, and `node tests/receipts.mjs` from the project root. The API integration test uses an isolated fixture company and cleans up its records; allocated reference numbers are not reused.
