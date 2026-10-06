require("dotenv").config();
const pool = require("../config/db");

const TARGET_EMAIL = "jose.villanueva@gloriouscommercial.ph";
const FROM_WAREHOUSE_NAME = "San Juan Warehouse";
const TO_WAREHOUSE_NAME = "Pasig Warehouse";

async function main() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[user]] = await conn.query(
      `SELECT CompanyID FROM User WHERE Email = :email LIMIT 1`,
      { email: TARGET_EMAIL }
    );
    if (!user) throw new Error("Target user not found.");

    const [[fromWh]] = await conn.query(
      `SELECT WarehouseID FROM Warehouse WHERE CompanyID = :companyId AND WarehouseName = :name LIMIT 1`,
      { companyId: user.CompanyID, name: FROM_WAREHOUSE_NAME }
    );
    const [[toWh]] = await conn.query(
      `SELECT WarehouseID FROM Warehouse WHERE CompanyID = :companyId AND WarehouseName = :name LIMIT 1`,
      { companyId: user.CompanyID, name: TO_WAREHOUSE_NAME }
    );
    if (!fromWh || !toWh) throw new Error("Required warehouse(s) not found.");

    const [rowsToMove] = await conn.query(
      `SELECT i.InventoryID, i.ProductID, p.ProductName, i.StockOnHand
       FROM Inventory i
       JOIN Product p ON p.ProductID = i.ProductID
       JOIN Category c ON c.CategoryID = p.CategoryID
       WHERE i.WarehouseID = :fromWid
         AND c.Category = 'Cylinder'`,
      { fromWid: fromWh.WarehouseID }
    );

    if (!rowsToMove.length) {
      await conn.rollback();
      console.log("No Cylinder inventory rows found in San Juan Warehouse.");
      return;
    }

    // Ensure destination has no conflicting product rows (unique warehouse+product key)
    const productIds = rowsToMove.map((r) => r.ProductID);
    const [conflicts] = await conn.query(
      `SELECT InventoryID, ProductID
       FROM Inventory
       WHERE WarehouseID = :toWid
         AND ProductID IN (:pids)`,
      { toWid: toWh.WarehouseID, pids: productIds }
    );
    if (conflicts.length) {
      throw new Error(
        `Cannot move: ${conflicts.length} cylinder product(s) already exist in ${TO_WAREHOUSE_NAME}.`
      );
    }

    const [updateResult] = await conn.query(
      `UPDATE Inventory i
       JOIN Product p ON p.ProductID = i.ProductID
       JOIN Category c ON c.CategoryID = p.CategoryID
       SET i.WarehouseID = :toWid
       WHERE i.WarehouseID = :fromWid
         AND c.Category = 'Cylinder'`,
      { fromWid: fromWh.WarehouseID, toWid: toWh.WarehouseID }
    );

    await conn.commit();

    console.log(`Moved Cylinder rows: ${updateResult.affectedRows}`);
    rowsToMove.forEach((row) => {
      console.log(`${row.InventoryID} | ${row.ProductName} | stock=${row.StockOnHand}`);
    });
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

