const pool = require('../config/db');
async function migrate(conn = pool) {
  await require('./migrateCylinderStock')(conn);
  await require('./migrateProductHistory')(conn);
  const [columns] = await conn.query(`SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()`);
  const existing = new Set(columns.map(c => `${c.TABLE_NAME}.${c.COLUMN_NAME}`.toLowerCase()));
  async function add(table, column, type) {
    if (!existing.has(`${table}.${column}`.toLowerCase())) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`);
  }
  if(existing.has('order.fulfillmentstatus')) await conn.query(`ALTER TABLE \`Order\` DROP COLUMN FulfillmentStatus`);
  const fields = {
    CompanyID:'VARCHAR(20) NULL',
    PickupStatus:"ENUM('Preparing','Ready for Pickup','Claimed','Cancelled','Unclaimed') NULL",
    DeliveryStatus:"ENUM('Preparing','Out for Delivery','Failed Attempt','Delivered','Cancelled','Delivery Failed / Restocked') NULL",
    PaymentStatus:"ENUM('Unpaid','Paid','Refund Pending','Refunded','Forfeited') NOT NULL DEFAULT 'Unpaid'",
    ScheduledPickupTime:'DATETIME NULL', PickupDeadline:'DATETIME NULL', DeliveryNo:'VARCHAR(50) NULL',
    AssignedRiderID:'VARCHAR(20) NULL', AttemptCount:'TINYINT NOT NULL DEFAULT 0', MaxAttempts:'TINYINT NOT NULL DEFAULT 3',
    LastAttemptDate:'DATETIME NULL', NextAttemptDate:'DATETIME NULL', DeliveredAt:'DATETIME NULL',
    CancellationRemarks:'TEXT NULL', RestockedAt:'DATETIME NULL', ArchivedAt:'DATETIME NULL',
    ResolutionAction:"ENUM('None','Refunded','Forfeited') NOT NULL DEFAULT 'None'", ResolutionReason:'VARCHAR(255) NULL',
    EmptyCylinderReturned:'TINYINT(1) NOT NULL DEFAULT 0', CashCollectedAmount:'DECIMAL(12,2) NOT NULL DEFAULT 0', ReceiverName:'VARCHAR(150) NULL', ReceiverSignature:'TEXT NULL',
    Landmark:'VARCHAR(255) NULL'
  };
  for (const [column,type] of Object.entries(fields)) await add('Order',column,type);
  await conn.query(`ALTER TABLE \`Order\` MODIFY PaymentStatus ENUM('Unpaid','Paid','Refund Pending','Refunded','Forfeited') NOT NULL DEFAULT 'Unpaid'`);
  await conn.query(`ALTER TABLE InventoryTransaction MODIFY TransactionType VARCHAR(20) NOT NULL`);
  for (const [column,type] of Object.entries({UnitSnapshot:'VARCHAR(20) NULL',UnitValueSnapshot:'DECIMAL(10,1) NULL'})) await add('OrderDetails',column,type);
  await conn.query(`UPDATE OrderDetails od JOIN Product p ON p.ProductID=od.ProductID SET od.UnitSnapshot=COALESCE(od.UnitSnapshot,p.Unit),od.UnitValueSnapshot=COALESCE(od.UnitValueSnapshot,p.UnitValue)`);
  await conn.query(`DROP TRIGGER IF EXISTS snapshot_orderdetails`);
  await conn.query(`CREATE TRIGGER snapshot_orderdetails BEFORE INSERT ON OrderDetails FOR EACH ROW SET NEW.ProductNameSnapshot=(SELECT ProductName FROM Product WHERE ProductID=NEW.ProductID),NEW.UnitSnapshot=(SELECT Unit FROM Product WHERE ProductID=NEW.ProductID),NEW.UnitValueSnapshot=(SELECT UnitValue FROM Product WHERE ProductID=NEW.ProductID),NEW.UnitPriceSnapshot=NEW.UnitPrice`);
  await add('Customer','Landmark','VARCHAR(255) NULL');
  await add('CompanySettings','AllowIssueRefund','TINYINT(1) NOT NULL DEFAULT 1');
  await add('CompanySettings','AllowForfeitPayment','TINYINT(1) NOT NULL DEFAULT 1');
  const [fks] = await conn.query(`SELECT TABLE_NAME,CONSTRAINT_NAME,COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='Customer'`);
  for (const fk of fks) {
    if (!['order','sales'].includes(fk.TABLE_NAME.toLowerCase()) || fk.COLUMN_NAME !== 'CustomerID') throw new Error(`Unexpected customer reference ${fk.TABLE_NAME}`);
    await conn.query(`ALTER TABLE \`${fk.TABLE_NAME}\` DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
    await conn.query(`ALTER TABLE \`${fk.TABLE_NAME}\` MODIFY CustomerID VARCHAR(20) NULL`);
    await conn.query(`ALTER TABLE \`${fk.TABLE_NAME}\` ADD CONSTRAINT \`${fk.CONSTRAINT_NAME}\` FOREIGN KEY (CustomerID) REFERENCES Customer(CustomerID) ON DELETE SET NULL ON UPDATE CASCADE`);
  }
  await conn.query(`CREATE TABLE IF NOT EXISTS OrderStockAllocation (
    OrderID VARCHAR(20) NOT NULL, InventoryID VARCHAR(20) NOT NULL, Quantity INT NOT NULL,
    PRIMARY KEY(OrderID,InventoryID), FOREIGN KEY(OrderID) REFERENCES \`Order\`(OrderID), FOREIGN KEY(InventoryID) REFERENCES Inventory(InventoryID))`);
  await conn.query(`CREATE TABLE IF NOT EXISTS DeliveryAttempt (
    AttemptID VARCHAR(20) PRIMARY KEY, OrderID VARCHAR(20) NOT NULL, AttemptNumber TINYINT NOT NULL,
    RiderID VARCHAR(20) NULL, DispatchedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FailedAt DATETIME NULL, FailureReason VARCHAR(100) NULL, DriverNotes TEXT NULL,
    UNIQUE KEY uq_order_attempt(OrderID,AttemptNumber), FOREIGN KEY(OrderID) REFERENCES \`Order\`(OrderID))`);
  await conn.query(`CREATE TABLE IF NOT EXISTS OrderSettlement (
    SettlementID VARCHAR(20) PRIMARY KEY, OrderID VARCHAR(20) NOT NULL UNIQUE, UserID VARCHAR(20) NOT NULL,
    Action ENUM('Refunded','Forfeited') NOT NULL, PaidAmount DECIMAL(12,2) NOT NULL, RefundAmount DECIMAL(12,2) NOT NULL,
    RetainedAmount DECIMAL(12,2) NOT NULL, Reason VARCHAR(255) NOT NULL, CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(OrderID) REFERENCES \`Order\`(OrderID))`);
  await conn.query(`UPDATE \`Order\` o LEFT JOIN Sales s ON s.OrderID=o.OrderID LEFT JOIN User u ON u.UserID=s.UserID LEFT JOIN Delivery d ON d.SaleID=s.SaleID
    SET o.CompanyID=COALESCE(o.CompanyID,u.CompanyID),
    o.PickupStatus=CASE WHEN o.OrderType IN ('Pickup','Pick-up') THEN COALESCE(o.PickupStatus,CASE o.OrderStatus WHEN 'Completed' THEN 'Claimed' WHEN 'Ready' THEN 'Ready for Pickup' WHEN 'Cancelled' THEN 'Cancelled' ELSE 'Preparing' END) ELSE o.PickupStatus END,
    o.DeliveryStatus=CASE WHEN o.OrderType='Delivery' THEN COALESCE(o.DeliveryStatus,CASE d.DeliveryStatus WHEN 'Delivered' THEN 'Delivered' WHEN 'Out for Delivery' THEN 'Out for Delivery' WHEN 'Failed' THEN 'Failed Attempt' WHEN 'Cancelled' THEN 'Cancelled' ELSE 'Preparing' END) ELSE o.DeliveryStatus END,
    o.ScheduledPickupTime=CASE WHEN o.OrderType IN ('Pickup','Pick-up') THEN COALESCE(o.ScheduledPickupTime,o.OrderDate) ELSE o.ScheduledPickupTime END,
    o.DeliveryNo=COALESCE(o.DeliveryNo,d.DRNo),o.AssignedRiderID=COALESCE(o.AssignedRiderID,d.DeliveredByUserID),o.DeliveredAt=COALESCE(o.DeliveredAt,d.DeliveryDate)`);
  await conn.query(`UPDATE \`Order\` SET DeliveryStatus='Delivered' WHERE OrderType='Delivery' AND OrderStatus='Completed' AND DeliveryStatus='Preparing' AND AttemptCount=0`);
  await conn.query(`UPDATE \`Order\` SET OrderType='Pick-up' WHERE OrderType='Pickup'`);
  await conn.query(`UPDATE \`Order\` o SET PaymentStatus=CASE WHEN o.OrderType='Walk-in' OR COALESCE((SELECT SUM(pay.AmountPaid) FROM Sales s JOIN Payment pay ON pay.SaleID=s.SaleID WHERE s.OrderID=o.OrderID),0)>=o.TotalAmount THEN 'Paid' ELSE 'Unpaid' END WHERE o.ResolutionAction='None'`);
  await conn.query(`UPDATE \`Order\` SET PickupDeadline=TIMESTAMP(DATE_ADD(DATE(ScheduledPickupTime),INTERVAL 2 DAY),'18:00:00') WHERE PickupStatus IS NOT NULL AND PickupDeadline IS NULL`);
  await conn.query(`UPDATE \`Order\` SET ArchivedAt=COALESCE(ArchivedAt,OrderDate),RestockedAt=CASE WHEN OrderStatus='Cancelled' THEN COALESCE(RestockedAt,OrderDate) ELSE RestockedAt END WHERE OrderType='Walk-in' OR (PickupStatus='Claimed' AND PaymentStatus='Paid') OR (DeliveryStatus='Delivered' AND PaymentStatus='Paid') OR OrderStatus='Cancelled'`);
  await conn.query(`INSERT IGNORE INTO OrderStockAllocation (OrderID,InventoryID,Quantity)
    SELECT o.OrderID,t.InventoryID,SUM(t.Quantity) FROM \`Order\` o JOIN Sales s ON s.OrderID=o.OrderID
    JOIN InventoryTransaction t ON (t.ReferenceNo=o.OrderNo OR t.ReferenceNo=s.SaleNo)
    WHERE t.TransactionType='Stock Out' AND t.Reason='Sale' GROUP BY o.OrderID,t.InventoryID`);
  await conn.query(`UPDATE \`Order\` SET AttemptCount=GREATEST(AttemptCount,1) WHERE DeliveryStatus IN ('Out for Delivery','Failed Attempt','Delivered')`);
  await conn.query(`INSERT IGNORE INTO DeliveryAttempt (AttemptID,OrderID,AttemptNumber,RiderID,FailureReason,FailedAt)
    SELECT CONCAT('AT-',LEFT(MD5(OrderID),16)),OrderID,AttemptCount,AssignedRiderID,CASE WHEN DeliveryStatus='Failed Attempt' THEN 'Legacy failed attempt' ELSE NULL END,CASE WHEN DeliveryStatus='Failed Attempt' THEN OrderDate ELSE NULL END
    FROM \`Order\` WHERE AttemptCount>0`);
  await conn.query(`INSERT INTO Role(RoleID,RoleName) SELECT 'RL-RIDER','Rider' WHERE NOT EXISTS (SELECT 1 FROM Role WHERE LOWER(RoleName)='rider')`);
  await conn.query(`DROP TRIGGER IF EXISTS lifecycle_order_defaults`);
  await conn.query(`CREATE TRIGGER lifecycle_order_defaults BEFORE INSERT ON \`Order\` FOR EACH ROW SET
    NEW.OrderType=CASE WHEN NEW.OrderType='Pickup' THEN 'Pick-up' ELSE NEW.OrderType END,
    NEW.PickupStatus=CASE WHEN NEW.OrderType='Pick-up' THEN COALESCE(NEW.PickupStatus,'Preparing') ELSE NULL END,
    NEW.DeliveryStatus=CASE WHEN NEW.OrderType='Delivery' THEN COALESCE(NEW.DeliveryStatus,'Preparing') ELSE NULL END,
    NEW.PaymentStatus=CASE WHEN NEW.OrderType='Walk-in' THEN 'Paid' ELSE NEW.PaymentStatus END,
    NEW.ArchivedAt=CASE WHEN NEW.OrderType='Walk-in' THEN CURRENT_TIMESTAMP ELSE NEW.ArchivedAt END`);
  await conn.query(`DROP TRIGGER IF EXISTS lifecycle_sale_company`);
  await conn.query(`CREATE TRIGGER lifecycle_sale_company AFTER INSERT ON Sales FOR EACH ROW UPDATE \`Order\` SET CompanyID=COALESCE(CompanyID,(SELECT CompanyID FROM User WHERE UserID=NEW.UserID)) WHERE OrderID=NEW.OrderID`);
  console.log('Orders lifecycle migration complete.');
}
if (require.main===module) migrate().catch(err=>{console.error(err.message);process.exitCode=1;}).finally(()=>pool.end());
module.exports=migrate;
