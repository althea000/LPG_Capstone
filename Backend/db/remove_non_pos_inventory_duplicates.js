require("dotenv").config();
const pool = require("../config/db");

const TARGET_EMAIL = "jose.villanueva@gloriouscommercial.ph";
const POS_WAREHOUSE_ID = "WH-001";

async function main() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[user]] = await conn.query(
      `SELECT CompanyID FROM User WHERE Email = :email LIMIT 1`,
      { email: TARGET_EMAIL }
    );
    if (!user) throw new Error("Target user not found.");

    const [dupeRows] = await conn.query(
      `SELECT p.ProductID, p.ProductName, COUNT(*) AS rowCount,
              GROUP_CONCAT(CONCAT(i.WarehouseID, ':', i.StockOnHand) ORDER BY i.WarehouseID SEPARATOR ' | ') AS stocks
       FROM Inventory i
       JOIN Product p ON p.ProductID = i.ProductID
       JOIN Warehouse w ON w.WarehouseID = i.WarehouseID
       WHERE w.CompanyID = :companyId
       GROUP BY p.ProductID, p.ProductName
       HAVING COUNT(*) > 1
       ORDER BY p.ProductName`,
      { companyId: user.CompanyID }
    );

    const [toDelete] = await conn.query(
      `SELECT i.InventoryID, i.ProductID, p.ProductName, i.WarehouseID
       FROM Inventory i
       JOIN Product p ON p.ProductID = i.ProductID
       JOIN Warehouse w ON w.WarehouseID = i.WarehouseID
       WHERE w.CompanyID = :companyId
         AND i.WarehouseID <> :posWarehouse
         AND EXISTS (
           SELECT 1
           FROM Inventory keepi
           WHERE keepi.ProductID = i.ProductID
             AND keepi.WarehouseID = :posWarehouse
         )
       ORDER BY p.ProductName, i.WarehouseID`,
      { companyId: user.CompanyID, posWarehouse: POS_WAREHOUSE_ID }
    );

    if (!toDelete.length) {
      await conn.rollback();
      console.log("No non-POS duplicate inventory rows found.");
      return;
    }

    const inventoryIds = toDelete.map((r) => r.InventoryID);

    const [txDeleteResult] = await conn.query(
      `DELETE FROM InventoryTransaction WHERE InventoryID IN (:ids)`,
      { ids: inventoryIds }
    );

    const [invDeleteResult] = await conn.query(
      `DELETE FROM Inventory WHERE InventoryID IN (:ids)`,
      { ids: inventoryIds }
    );

    await conn.commit();

    console.log(`Duplicate product groups before cleanup: ${dupeRows.length}`);
    console.log(`Deleted InventoryTransaction rows: ${txDeleteResult.affectedRows}`);
    console.log(`Deleted Inventory rows: ${invDeleteResult.affectedRows}`);
    toDelete.forEach((row) => {
      console.log(`Removed ${row.InventoryID} | ${row.ProductName} | ${row.WarehouseID}`);
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

