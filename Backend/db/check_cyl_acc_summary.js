require("dotenv").config();
const pool = require("../config/db");

async function main() {
  const [[user]] = await pool.query(
    `SELECT CompanyID FROM User WHERE Email = :email LIMIT 1`,
    { email: "jose.villanueva@gloriouscommercial.ph" }
  );

  const [rows] = await pool.query(
    `SELECT w.WarehouseName, c.Category, COUNT(*) AS itemCount, COALESCE(SUM(i.StockOnHand), 0) AS totalStock
     FROM Inventory i
     JOIN Product p ON p.ProductID = i.ProductID
     JOIN Category c ON c.CategoryID = p.CategoryID
     JOIN Warehouse w ON w.WarehouseID = i.WarehouseID
     WHERE w.CompanyID = :companyId
       AND c.Category IN ('Cylinder', 'Accessories')
     GROUP BY w.WarehouseName, c.Category
     ORDER BY w.WarehouseName, c.Category`,
    { companyId: user.CompanyID }
  );

  rows.forEach((row) => {
    console.log(`${row.WarehouseName} | ${row.Category} | items=${row.itemCount} | stock=${row.totalStock}`);
  });

  await pool.end();
}

main().catch(async (err) => {
  console.error(err.message || err);
  await pool.end();
  process.exit(1);
});

