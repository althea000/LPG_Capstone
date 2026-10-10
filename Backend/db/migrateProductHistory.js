const pool = require('../config/db');

// Idempotent migration; never reset data or disable foreign-key checks.
async function migrate(conn = pool) {
  const [columns] = await conn.query(`SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);
  const existing = new Set(columns.map(c => `${c.TABLE_NAME}.${c.COLUMN_NAME}`.toLowerCase()));
  async function add(table, column, type) {
    if (!existing.has(`${table}.${column}`.toLowerCase())) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
  }
  await conn.query(`ALTER TABLE Product MODIFY Unit VARCHAR(30) NULL`);
  await conn.query(`UPDATE Product SET Unit = CASE WHEN LOWER(Unit) IN ('kg','kilogram') THEN 'kg' WHEN LOWER(Unit) IN ('m','meter') THEN 'meter' ELSE 'piece' END`);
  await conn.query(`ALTER TABLE Product MODIFY Unit ENUM('kg','meter','piece') NOT NULL DEFAULT 'piece'`);
  await add('Product', 'UnitValue', 'DECIMAL(10,1) NULL AFTER Unit');
  await conn.query(`UPDATE Product SET UnitValue = 1.0 WHERE Unit = 'piece'`);
  const [legacyUnits] = await conn.query(`SELECT ProductID,ProductName,Unit FROM Product WHERE UnitValue IS NULL AND Unit IN ('kg','meter')`);
  for (const product of legacyUnits) {
    const pattern = product.Unit === 'kg' ? /(\d+(?:\.\d+)?)\s*kg\b/i : /(\d+(?:\.\d+)?)\s*(?:meter|meters|m)\b/i;
    const match = product.ProductName.match(pattern);
    if (match && Number(match[1]) > 0) await conn.query(`UPDATE Product SET UnitValue = :value WHERE ProductID = :id`, { value: Number(match[1]), id: product.ProductID });
  }
  const { resolveOption } = require('../utils/productOptions');
  for (const name of ['Gasul LPG', 'Cylinder', 'Accessories']) await resolveOption(conn, 'Category', name);
  for (const name of ['Gasul']) await resolveOption(conn, 'Brand', name);
  const tables = ['Inventory', 'OrderDetails', 'TransferDetail', 'PurchaseOrderItem', 'RestockRecommendation'];
  for (const table of tables) {
    await add(table, 'ProductNameSnapshot', 'VARCHAR(150) NULL');
    await conn.query(`UPDATE \`${table}\` c JOIN Product p ON p.ProductID = c.ProductID SET c.ProductNameSnapshot = p.ProductName WHERE c.ProductNameSnapshot IS NULL`);
  }
  await add('Inventory', 'OriginalProductID', 'VARCHAR(20) NULL');
  await conn.query(`UPDATE Inventory SET OriginalProductID = ProductID WHERE OriginalProductID IS NULL`);
  await add('OrderDetails', 'UnitPriceSnapshot', 'DECIMAL(12,2) NULL');
  await add('OrderDetails', 'UnitSnapshot', 'VARCHAR(20) NULL');
  await add('OrderDetails', 'UnitValueSnapshot', 'DECIMAL(10,1) NULL');
  await conn.query(`UPDATE OrderDetails od JOIN Product p ON p.ProductID=od.ProductID SET od.UnitSnapshot=COALESCE(od.UnitSnapshot,p.Unit),od.UnitValueSnapshot=COALESCE(od.UnitValueSnapshot,p.UnitValue)`);
  // Preserve the actual historical sale price, rather than today's catalog price.
  await conn.query(`UPDATE OrderDetails SET UnitPriceSnapshot = UnitPrice WHERE UnitPriceSnapshot IS NULL`);
  await add('InventoryTransaction', 'ProductNameSnapshot', 'VARCHAR(150) NULL');
  await add('InventoryTransaction', 'BrandIDSnapshot', 'VARCHAR(20) NULL');
  await add('InventoryTransaction', 'OriginalProductID', 'VARCHAR(20) NULL');
  await conn.query(`UPDATE InventoryTransaction t JOIN Inventory i ON i.InventoryID = t.InventoryID JOIN Product p ON p.ProductID = i.ProductID SET t.ProductNameSnapshot = COALESCE(t.ProductNameSnapshot,p.ProductName), t.BrandIDSnapshot = COALESCE(t.BrandIDSnapshot,p.BrandID), t.OriginalProductID = COALESCE(t.OriginalProductID,p.ProductID)`);
  // Discover actual constraint names instead of assuming generated MySQL names.
  const [fks] = await conn.query(`SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'Product'`);
  for (const fk of fks) {
    if (!tables.some(table => table.toLowerCase() === fk.TABLE_NAME.toLowerCase()) || fk.COLUMN_NAME !== 'ProductID') throw new Error(`Unexpected Product reference: ${fk.TABLE_NAME}.${fk.COLUMN_NAME}`);
    await conn.query(`ALTER TABLE \`${fk.TABLE_NAME}\` DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
    await conn.query(`ALTER TABLE \`${fk.TABLE_NAME}\` MODIFY ProductID VARCHAR(20) NULL`);
    await conn.query(`ALTER TABLE \`${fk.TABLE_NAME}\` ADD CONSTRAINT \`${fk.CONSTRAINT_NAME}\` FOREIGN KEY (ProductID) REFERENCES Product(ProductID) ON DELETE SET NULL`);
  }
  // DB-level snapshots cover every writer, including imports and seed scripts.
  for (const table of tables) {
    const name = `snapshot_${table.toLowerCase()}`;
    await conn.query(`DROP TRIGGER IF EXISTS \`${name}\``);
    await conn.query(`CREATE TRIGGER \`${name}\` BEFORE INSERT ON \`${table}\` FOR EACH ROW SET NEW.ProductNameSnapshot = (SELECT ProductName FROM Product WHERE ProductID = NEW.ProductID)${table === 'OrderDetails' ? ', NEW.UnitPriceSnapshot = NEW.UnitPrice, NEW.UnitSnapshot = (SELECT Unit FROM Product WHERE ProductID=NEW.ProductID), NEW.UnitValueSnapshot = (SELECT UnitValue FROM Product WHERE ProductID=NEW.ProductID)' : table === 'Inventory' ? ', NEW.OriginalProductID = NEW.ProductID' : ''}`);
  }
  await conn.query(`DROP TRIGGER IF EXISTS snapshot_inventorytransaction`);
  await conn.query(`CREATE TRIGGER snapshot_inventorytransaction BEFORE INSERT ON InventoryTransaction FOR EACH ROW SET NEW.ProductNameSnapshot = (SELECT COALESCE(p.ProductName,i.ProductNameSnapshot) FROM Inventory i LEFT JOIN Product p ON p.ProductID = i.ProductID WHERE i.InventoryID = NEW.InventoryID), NEW.BrandIDSnapshot = (SELECT p.BrandID FROM Inventory i JOIN Product p ON p.ProductID = i.ProductID WHERE i.InventoryID = NEW.InventoryID), NEW.OriginalProductID = (SELECT COALESCE(ProductID,OriginalProductID) FROM Inventory WHERE InventoryID = NEW.InventoryID)`);
}
if (require.main === module) migrate().then(() => console.log('Product history migration complete.')).catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
module.exports = migrate;
