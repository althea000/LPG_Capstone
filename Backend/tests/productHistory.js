const assert = require('node:assert/strict');
const pool = require('../config/db');
const { normalizeOption, validateUnit, resolveOption } = require('../utils/productOptions');
async function verify() {
  assert.equal(normalizeOption('  SOLANE  '), 'Solane');
  assert.equal(normalizeOption('  lpg   HOSE '), 'LPG Hose');
  for (const value of ['', '!!!', ' Other ']) assert.throws(() => normalizeOption(value));
  for (const value of [0, -1, 1.25, '']) assert.throws(() => validateUnit({ unit: 'kg', unitValue: value }));
  validateUnit({ unit: 'meter', unitValue: 1.5 });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const option = await resolveOption(conn, 'Brand', 'History Test Brand');
    const duplicate = await resolveOption(conn, 'Brand', ' history   TEST brand ');
    assert.equal(option.id, duplicate.id);
    const [[product]] = await conn.query('SELECT * FROM Product LIMIT 1');
    assert.ok(product, 'Need one product fixture');
    const pid = 'P-TEST-HISTORY';
    await conn.query(`INSERT INTO Product (ProductID,ProductName,CategoryID,BrandID,SupplierID,Unit,UnitValue,UnitPrice,CostPrice,ReorderLevel) VALUES (:pid,'Snapshot test 2.7 kg',:category,:brand,:supplier,'kg',2.7,100,50,1)`, { pid, category:product.CategoryID, brand:product.BrandID, supplier:product.SupplierID });
    const [[warehouse]] = await conn.query('SELECT WarehouseID FROM Warehouse LIMIT 1');
    const [[testUser]] = await conn.query('SELECT UserID FROM User LIMIT 1');
    await conn.query(`INSERT INTO Transfer (TransferID,FromWarehouseID,ToWarehouseID,UserID,Status) VALUES ('TEST-TF',:warehouse,:warehouse,:user,'Completed')`,{warehouse:warehouse.WarehouseID,user:testUser.UserID});
    await conn.query(`INSERT INTO PurchaseOrder (PurchaseOrderID,SupplierID,CreatedByUserID,PONo,OrderDate,Status,TotalAmount) VALUES ('TEST-PO',:supplier,:user,'TEST-HISTORY-PO',NOW(),'Pending',50)`,{supplier:product.SupplierID,user:testUser.UserID});
    const tables = ['Inventory', 'OrderDetails', 'TransferDetail', 'PurchaseOrderItem', 'RestockRecommendation'];
    const ids = {};
    for (const table of tables) {
      let [[sample]] = await conn.query(`SELECT * FROM ${table} LIMIT 1`);
      if (!sample && table === 'TransferDetail') sample = { TransferID:'TEST-TF', Quantity:1 };
      if (!sample && table === 'PurchaseOrderItem') sample = { PurchaseOrderID:'TEST-PO', Quantity:1, UnitCost:50, Subtotal:50 };
      if (!sample && table === 'RestockRecommendation') sample = { SupplierID:product.SupplierID, StockOnHand:0, PredictedDemand:1, RecommendedQuantity:1, ForecastDate:'2026-10-09', Status:'Pending' };
      assert.ok(sample, `Need a ${table} fixture`);
      const [columns] = await conn.query(`SHOW COLUMNS FROM ${table}`);
      const primary = columns.find(c => c.Key === 'PRI').Field;
      const id = `TEST-${table.slice(0,12)}`; ids[table] = id;
      const fields = columns.filter(c => !c.Field.endsWith('Snapshot') && (c.Field === primary || c.Field === 'ProductID' || sample[c.Field] !== undefined)).map(c => c.Field);
      const values = fields.map(c => c === primary ? id : c === 'ProductID' ? pid : sample[c]);
      await conn.query(`INSERT INTO ${table} (${fields.map(c => '\x60'+c+'\x60').join(',')}) VALUES (${fields.map(() => '?').join(',')})`,values);
    }
    const [[user]] = await conn.query('SELECT UserID FROM User LIMIT 1');
    await conn.query(`INSERT INTO InventoryTransaction (TransactionID,InventoryID,UserID,TransactionType,Quantity,Reason) VALUES ('TEST-TX',:inventory,:user,'Stock In',1,'Adjustment')`,{inventory:ids.Inventory,user:user.UserID});
    await conn.query(`DELETE FROM Product WHERE ProductID = :pid`, {pid});
    const [[deleted]] = await conn.query(`SELECT COUNT(*) AS count FROM Product WHERE ProductID = :pid`,{pid}); assert.equal(deleted.count,0);
    for (const table of tables) {
      const [[row]] = await conn.query(`SELECT * FROM ${table} WHERE ${table === 'OrderDetails' ? 'OrderDetailID' : table === 'TransferDetail' ? 'TransferDetailID' : table === 'PurchaseOrderItem' ? 'PurchaseOrderItemID' : table === 'RestockRecommendation' ? 'RestockID' : 'InventoryID'} = :id`,{id:ids[table]});
      assert.equal(row.ProductID,null); assert.equal(row.ProductNameSnapshot,'Snapshot test 2.7 kg');
      if (table === 'OrderDetails') assert.equal(Number(row.UnitPriceSnapshot),Number(row.UnitPrice));
    }
    const [[tx]] = await conn.query(`SELECT COALESCE(p.ProductName,t.ProductNameSnapshot,'Deleted Product') AS name,t.OriginalProductID FROM InventoryTransaction t JOIN Inventory i ON i.InventoryID=t.InventoryID LEFT JOIN Product p ON p.ProductID=i.ProductID WHERE t.TransactionID='TEST-TX'`);
    assert.equal(tx.name,'Snapshot test 2.7 kg'); assert.equal(tx.OriginalProductID,pid);
    console.log('PASS: normalization, deduplication, unit validation, hard deletion, all five foreign keys, transaction and sale snapshots. Fixtures rolled back.');
  } finally { await conn.rollback(); conn.release(); }
}
verify().catch(err => { console.error(err.message); process.exitCode=1; }).finally(() => pool.end());
