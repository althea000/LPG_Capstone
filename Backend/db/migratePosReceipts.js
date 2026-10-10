const pool=require('../config/db');
const fs=require('node:fs');
const path=require('node:path');
async function migrate(conn=pool){
  await require('./migrateOrderLifecycle')(conn);
  const [cols]=await conn.query(`SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()`);
  const existing=new Set(cols.map(c=>`${c.TABLE_NAME}.${c.COLUMN_NAME}`.toLowerCase()));
  const fields={Order:{PaymentMethod:'VARCHAR(30) NULL',SubtotalSnapshot:'DECIMAL(12,2) NULL',VatSnapshot:'DECIMAL(12,2) NULL',TaxRateSnapshot:'DECIMAL(8,4) NULL',DeliveryInstructions:'VARCHAR(255) NULL',DeliveryVehicleID:'VARCHAR(50) NULL',DeliveryDistanceKm:'DECIMAL(10,1) NULL'},Payment:{AmountTendered:'DECIMAL(12,2) NULL',ChangeDue:'DECIMAL(12,2) NULL'}};
  for(const [table,columns] of Object.entries(fields))for(const [col,type] of Object.entries(columns))if(!existing.has(`${table}.${col}`.toLowerCase()))await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${type}`);
  await conn.query(`CREATE TABLE IF NOT EXISTS DocumentSequence (SequenceKey VARCHAR(100) PRIMARY KEY,LastNumber INT NOT NULL)`);
  await conn.query(`CREATE TABLE IF NOT EXISTS DeliveryVehicleRate (VehicleID VARCHAR(50) PRIMARY KEY,CompanyID VARCHAR(20) NOT NULL,VehicleName VARCHAR(100) NOT NULL,CapacityLabel VARCHAR(100) NOT NULL,MaxWeightKg DECIMAL(10,1) NOT NULL,BaseRate DECIMAL(10,2) NOT NULL,PerKm DECIMAL(10,2) NOT NULL,MinSubtotalForFree DECIMAL(12,2) NOT NULL DEFAULT 0,FreeDistanceKm DECIMAL(10,1) NOT NULL DEFAULT 5,Enabled TINYINT(1) NOT NULL DEFAULT 1,FOREIGN KEY(CompanyID) REFERENCES Company(CompanyID) ON DELETE CASCADE)`);
  const [companies]=await conn.query('SELECT CompanyID FROM Company');
  for(const c of companies)for(const [key,name,weight,base,km,min] of [['motorcycle','Motorcycle',20,60,12,0],['cargo','L300 / Cargo Van',1000,450,40,6000],['truck','Open Truck (4W/6W)',2000,1200,60,15000]])await conn.query(`INSERT IGNORE INTO DeliveryVehicleRate(VehicleID,CompanyID,VehicleName,CapacityLabel,MaxWeightKg,BaseRate,PerKm,MinSubtotalForFree) VALUES (:id,:company,:name,:capacity,:weight,:base,:km,:min)`,{id:`${c.CompanyID}-${key}`,company:c.CompanyID,name,capacity:`Up to ${weight.toLocaleString('en-US')} kg`,weight,base,km,min});
  await conn.query(`UPDATE \`Order\` SET PickupDeadline=TIMESTAMP(DATE_ADD(DATE(ScheduledPickupTime),INTERVAL 2 DAY),'18:00:00') WHERE PickupStatus IS NOT NULL AND ArchivedAt IS NULL`);
  await conn.query(`UPDATE \`Order\` o LEFT JOIN Sales s ON s.OrderID=o.OrderID SET o.PaymentMethod=COALESCE(o.PaymentMethod,(SELECT p.PaymentMethod FROM Payment p WHERE p.SaleID=s.SaleID ORDER BY p.PaymentDate DESC LIMIT 1),CASE WHEN o.OrderType='Delivery' AND o.PaymentStatus='Unpaid' THEN 'Cash on Delivery (COD)' ELSE NULL END),o.DeliveryInstructions=COALESCE(o.DeliveryInstructions,o.Landmark,o.Remarks),o.SubtotalSnapshot=COALESCE(o.SubtotalSnapshot,(SELECT SUM(od.Subtotal) FROM OrderDetails od WHERE od.OrderID=o.OrderID))`);
  await conn.query(`UPDATE Payment SET AmountTendered=COALESCE(AmountTendered,AmountPaid),ChangeDue=COALESCE(ChangeDue,0)`);
  await conn.query(`UPDATE Customer SET CustomerType='Residential' WHERE CustomerType NOT IN ('Residential','Commercial')`);
  // Existing customer foreign keys use ON UPDATE CASCADE, preserving order/sales links.
  const {nextSequence}=require('../utils/generateNumbers');
  const [customers]=await conn.query(`SELECT CustomerID FROM Customer ORDER BY CreatedAt,CustomerID`);
  for(const c of customers)if(!/^CUST-\d+$/.test(c.CustomerID)){
    const newId=await nextSequence(conn,'Customer','CustomerID','CUST',false);
    await conn.query(`UPDATE Customer SET CustomerID=:newId WHERE CustomerID=:oldId`,{newId,oldId:c.CustomerID});
  }
  const [products]=await conn.query(`SELECT ProductID,ProductName,ImageURL FROM Product`);
  const accessories={'lpg hose (per meter)':'acc-lpg-hose.png','lpg hose clamp':'acc-lpg-hoseclamp.png','lpg hose clamp with 1.5 meter hose':'acc-lpg-hoseclamp-1.5.png','pol regulator':'acc-pol-regulator.png','tpa regulator':'acc-tpa-regulator.png','reyna gas stove':'acc-reyna-gasstove.png'};
  for(const p of products){
    if(p.ImageURL)continue;
    const name=p.ProductName.toLowerCase(),size=name.match(/(\d+(?:\.\d+)?)\s*kg/);
    const file=accessories[name] || (size && /^(gasul|cylinder)/.test(name)?`${name.startsWith('cylinder')?'cylinder':'gasul'}-${name.includes('elite')?'elite':''}${size[1]}kg.png`:null);
    if(file && fs.existsSync(path.join(__dirname,'../uploads',file)))await conn.query(`UPDATE Product SET ImageURL=:url WHERE ProductID=:id`,{url:`/uploads/${file}`,id:p.ProductID});
  }
  console.log('POS receipts, customer numbers, delivery rates and product images migrated.');
}
if(require.main===module)migrate().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());
module.exports=migrate;
