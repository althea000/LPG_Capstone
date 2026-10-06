require("dotenv").config();
const pool = require("../config/db");

const TARGET_EMAIL = "jose.villanueva@gloriouscommercial.ph";
const TARGET_CATEGORIES = ["Cylinder", "Accessories"];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function stockForCategory(category) {
  if (category === "Cylinder") return randomInt(18, 50);
  return randomInt(8, 30);
}

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

    const [[user]] = await conn.query(
      `SELECT UserID, CompanyID FROM User WHERE Email = :email LIMIT 1`,
      { email: TARGET_EMAIL }
    );
    if (!user) throw new Error("Target user not found.");

    const [warehouses] = await conn.query(
      `SELECT WarehouseID, WarehouseName FROM Warehouse WHERE CompanyID = :companyId ORDER BY WarehouseID`,
      { companyId: user.CompanyID }
    );
    if (!warehouses.length) throw new Error("No warehouses found.");

    const [products] = await conn.query(
      `SELECT p.ProductID, p.ProductName, c.Category
       FROM Product p
       JOIN Category c ON c.CategoryID = p.CategoryID
       WHERE c.Category IN (:categories) AND p.Status = 'Active'
       ORDER BY c.Category, p.ProductName`,
      { categories: TARGET_CATEGORIES }
    );
    if (!products.length) throw new Error("No active Cylinder/Accessories products found.");

    let inserted = 0;
    let updated = 0;
    let txInserted = 0;

    for (const wh of warehouses) {
      for (const p of products) {
        const [invRows] = await conn.query(
          `SELECT InventoryID, StockOnHand FROM Inventory WHERE WarehouseID = :wid AND ProductID = :pid LIMIT 1`,
          { wid: wh.WarehouseID, pid: p.ProductID }
        );

        const newStock = stockForCategory(p.Category);
        let inventoryId;
        let oldStock = 0;

        if (invRows[0]) {
          inventoryId = invRows[0].InventoryID;
          oldStock = Number(invRows[0].StockOnHand || 0);
          await conn.query(
            `UPDATE Inventory SET StockOnHand = :stock WHERE InventoryID = :id`,
            { stock: newStock, id: inventoryId }
          );
          updated += 1;
        } else {
          inventoryId = await nextId(conn, "Inventory", "InventoryID", "INT");
          await conn.query(
            `INSERT INTO Inventory (InventoryID, WarehouseID, ProductID, StockOnHand)
             VALUES (:inventoryId, :warehouseId, :productId, :stock)`,
            { inventoryId, warehouseId: wh.WarehouseID, productId: p.ProductID, stock: newStock }
          );
          inserted += 1;
        }

        const delta = newStock - oldStock;
        if (delta !== 0) {
          const transactionId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
          await conn.query(
            `INSERT INTO InventoryTransaction
              (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, ReferenceNo, Remarks)
             VALUES
              (:transactionId, :inventoryId, :userId, :type, :qty, 'Adjustment', :reference, :remarks)`,
            {
              transactionId,
              inventoryId,
              userId: user.UserID,
              type: delta > 0 ? "Stock In" : "Stock Out",
              qty: Math.abs(delta),
              reference: "DEMO-JOSE-2026-RANDSTOCK",
              remarks: `Randomized ${p.Category} stock for demo`,
            }
          );
          txInserted += 1;
        }
      }
    }

    await conn.commit();

    const [previewRows] = await conn.query(
      `SELECT w.WarehouseID, w.WarehouseName, c.Category, p.ProductName, i.StockOnHand
       FROM Inventory i
       JOIN Warehouse w ON w.WarehouseID = i.WarehouseID
       JOIN Product p ON p.ProductID = i.ProductID
       JOIN Category c ON c.CategoryID = p.CategoryID
       WHERE w.CompanyID = :companyId AND c.Category IN (:categories)
       ORDER BY w.WarehouseID, c.Category, p.ProductName
       LIMIT 40`,
      { companyId: user.CompanyID, categories: TARGET_CATEGORIES }
    );

    console.log(`Warehouses: ${warehouses.map((w) => `${w.WarehouseID} (${w.WarehouseName})`).join(", ")}`);
    console.log(`Products randomized: ${products.length}`);
    console.log(`Inventory rows inserted: ${inserted}`);
    console.log(`Inventory rows updated: ${updated}`);
    console.log(`Adjustment transactions inserted: ${txInserted}`);
    for (const row of previewRows) {
      console.log(`${row.WarehouseID} | ${row.Category} | ${row.ProductName} | stock=${row.StockOnHand}`);
    }
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

