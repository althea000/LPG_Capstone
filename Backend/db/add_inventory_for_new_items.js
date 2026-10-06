require("dotenv").config();
const pool = require("../config/db");

const TARGET_EMAIL = "jose.villanueva@gloriouscommercial.ph";
const PRODUCT_NAMES = [
  "Cylinder 2.7 kg",
  "Cylinder LPG 7 kg",
  "Cylinder 11 kg Elite",
  "Cylinder 11 kg",
  "Cylinder 22 kg",
  "Cylinder 50 kg",
  "LPG Hose Clamp",
  "LPG Hose Clamp with 1.5 meter Hose",
  "LPG Hose (Per Meter)",
  "POL Regulator",
  "TPA Regulator",
  "Reyna Gas Stove",
];

async function nextId(conn, table, column, prefix, pad = 3) {
  const [rows] = await conn.query(
    `SELECT ${column} AS id FROM ${table} WHERE ${column} LIKE :pattern ORDER BY ${column} DESC LIMIT 500`,
    { pattern: `${prefix}-%` }
  );
  let max = 0;
  for (const row of rows) {
    const match = String(row.id || "").match(new RegExp(`^${prefix}-(\\d+)$`));
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(pad, "0")}`;
}

async function main() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[jose]] = await conn.query(
      `SELECT UserID, CompanyID FROM User WHERE Email = :email LIMIT 1`,
      { email: TARGET_EMAIL }
    );
    if (!jose) throw new Error("Jose account not found.");

    const [[pasig]] = await conn.query(
      `SELECT WarehouseID, WarehouseName
       FROM Warehouse
       WHERE CompanyID = :companyId AND WarehouseName = :name
       LIMIT 1`,
      { companyId: jose.CompanyID, name: "Pasig Warehouse" }
    );
    if (!pasig) throw new Error("Pasig Warehouse not found for Jose's company.");

    const [products] = await conn.query(
      `SELECT p.ProductID, p.ProductName, c.Category
       FROM Product p
       JOIN Category c ON c.CategoryID = p.CategoryID
       WHERE p.ProductName IN (:names)`,
      { names: PRODUCT_NAMES }
    );

    const byName = new Map(products.map((p) => [p.ProductName, p]));
    const missing = PRODUCT_NAMES.filter((n) => !byName.has(n));
    if (missing.length) throw new Error(`Missing products: ${missing.join(", ")}`);

    let inserted = 0;
    let existed = 0;
    let txInserted = 0;

    for (const name of PRODUCT_NAMES) {
      const p = byName.get(name);
      const [invRows] = await conn.query(
        `SELECT InventoryID FROM Inventory WHERE WarehouseID = :wid AND ProductID = :pid LIMIT 1`,
        { wid: pasig.WarehouseID, pid: p.ProductID }
      );

      if (invRows[0]) {
        existed += 1;
        continue;
      }

      const inventoryId = await nextId(conn, "Inventory", "InventoryID", "INT");
      const startingStock = p.Category === "Cylinder" ? 30 : 20;

      await conn.query(
        `INSERT INTO Inventory (InventoryID, WarehouseID, ProductID, StockOnHand)
         VALUES (:inventoryId, :warehouseId, :productId, :stock)`,
        {
          inventoryId,
          warehouseId: pasig.WarehouseID,
          productId: p.ProductID,
          stock: startingStock,
        }
      );
      inserted += 1;

      const transactionId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
      await conn.query(
        `INSERT INTO InventoryTransaction
          (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, ReferenceNo, Remarks)
         VALUES
          (:transactionId, :inventoryId, :userId, 'Stock In', :qty, 'Purchase', :reference, :remarks)`,
        {
          transactionId,
          inventoryId,
          userId: jose.UserID,
          qty: startingStock,
          reference: "DEMO-JOSE-2026-INVADD",
          remarks: "Seeded inventory for requested Cylinder/Accessories items",
        }
      );
      txInserted += 1;
    }

    await conn.commit();
    console.log(`Warehouse: ${pasig.WarehouseName}`);
    console.log(`Inserted inventory rows: ${inserted}`);
    console.log(`Already existing rows: ${existed}`);
    console.log(`Inserted stock-in transactions: ${txInserted}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

