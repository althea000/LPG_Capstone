// Integration test: isolated company/warehouse fixtures; never modifies existing stock or policies.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const net=require('node:net');
const jwt=require('jsonwebtoken');
const pool=require('../config/db');
const {id,pickupTime}=require('../services/orderLifecycle');
const company=id('C'),warehouse=id('WH'),product=id('P'),inventory=id('INT'),admin=id('U'),rider=id('U'),otherRider=id('U');
const orders=[];let child,customer;
const warehouse2=id('WH'),inventory2=id('INT');
async function run(){
  assert.throws(()=>pickupTime('2026-10-09T07:59'));assert.equal(pickupTime('2026-10-09T18:00'),'2026-10-09 18:00:00');
  const [[preset]]=await pool.query('SELECT CategoryID,BrandID,SupplierID FROM Product LIMIT 1');assert.ok(preset);
  const [[adminRole]]=await pool.query(`SELECT RoleID FROM Role WHERE LOWER(RoleName) IN ('administrator','admin') LIMIT 1`);
  const [[riderRole]]=await pool.query(`SELECT RoleID FROM Role WHERE RoleName='Rider' LIMIT 1`);
  await pool.query(`INSERT INTO Company(CompanyID,CompanyName,DTIRegNo,Address) VALUES (:id,:id,:id,'Test')`,{id:company});
  await pool.query(`INSERT INTO CompanySettings(CompanyID) VALUES (:id)`,{id:company});
  await pool.query(`INSERT INTO Warehouse(WarehouseID,CompanyID,WarehouseName,Location) VALUES (:id,:company,'Lifecycle Test','Test')`,{id:warehouse,company});
  for (const [user,role] of [[admin,adminRole.RoleID],[rider,riderRole.RoleID],[otherRider,riderRole.RoleID]]) await pool.query(`INSERT INTO User(UserID,CompanyID,RoleID,FirstName,LastName,Email,PasswordHash) VALUES (:id,:company,:role,'Lifecycle','Test',:email,'test-only')`,{id:user,company,role,email:`${user}@lifecycle.invalid`});
  await pool.query(`INSERT INTO Product(ProductID,ProductName,CategoryID,BrandID,SupplierID,Unit,UnitValue,UnitPrice,CostPrice,ReorderLevel) VALUES (:id,'Lifecycle Test 2.7 kg',:category,:brand,:supplier,'kg',2.7,100,50,1)`,{id:product,category:preset.CategoryID,brand:preset.BrandID,supplier:preset.SupplierID});
  await pool.query(`INSERT INTO Inventory(InventoryID,WarehouseID,ProductID,StockOnHand) VALUES (:id,:warehouse,:product,1000)`,{id:inventory,warehouse,product});
  await pool.query(`INSERT INTO Warehouse(WarehouseID,CompanyID,WarehouseName,Location) VALUES (:id,:company,'Cylinder Transfer Test','Test')`,{id:warehouse2,company});
  await pool.query(`INSERT INTO Inventory(InventoryID,WarehouseID,ProductID,StockOnHand) VALUES (:id,:warehouse,:product,0)`,{id:inventory2,warehouse:warehouse2,product});
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
  child=spawn(process.execPath,['server.js'],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let startupError='';child.stderr.on('data',data=>startupError+=data.toString());
  for(let attempt=0;attempt<50;attempt++){try{await fetch(`http://127.0.0.1:${port}/health`);break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}if(attempt===49)throw new Error(startupError || 'API did not start');}
  const tokens={admin:jwt.sign({userId:admin,companyId:company,roleName:'Administrator'},process.env.JWT_SECRET),rider:jwt.sign({userId:rider,companyId:company,roleName:'Rider'},process.env.JWT_SECRET),other:jwt.sign({userId:otherRider,companyId:company,roleName:'Rider'},process.env.JWT_SECRET)};
  async function request(path,body,who='admin',method=body?'POST':'GET',expected=200){
    const res=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{Authorization:`Bearer ${tokens[who]}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const data=await res.json();if(expected===null)return {status:res.status,data};assert.equal(res.status,expected,`${method} ${path}: ${JSON.stringify(data)}`);return data;
  }
  const created=await request('/customers',{name:'Lifecycle Test',customerType:'Residential',phone:'09999999999',address:'Fixture address',landmark:'Test landmark'},'admin','POST',201);customer=created.id;
  const stock=async()=>{const [[row]]=await pool.query(`SELECT StockOnHand FROM Inventory WHERE InventoryID=:id`,{id:inventory});return Number(row.StockOnHand);};
  const vehicle=`${company}-test`;
  await pool.query(`INSERT INTO DeliveryVehicleRate(VehicleID,CompanyID,VehicleName,CapacityLabel,MaxWeightKg,BaseRate,PerKm,MinSubtotalForFree,FreeDistanceKm) VALUES (:id,:company,'Fixture','20 kg',20,10,0,0,5)`,{id:vehicle,company});
  const create=async(type,paid=false)=>{
    const result=await request('/orders',{customerId:customer,orderType:type,scheduledPickupTime:'2099-10-09T09:00',deliveryAddress:'Fixture address',vehicleId:vehicle,distanceKm:6,warehouseId:warehouse,paymentMethod:type==='Delivery'&&!paid?'Cash on Delivery (COD)':'Cash',amountCollected:type==='Delivery'&&!paid?undefined:type==='Delivery'?210:200,items:[{productId:product,qty:2}]},'admin','POST',201);
    orders.push(result.orderId);
    // Preserve coverage of legacy unpaid pickups without offering unpaid POS checkout.
    if(type==='Pick-up'&&!paid){await pool.query('DELETE FROM Payment WHERE SaleID=:id',{id:result.saleId});await pool.query("UPDATE `Order` SET PaymentStatus='Unpaid' WHERE OrderID=:id",{id:result.orderId});}
    assert.match(result.orderId,/^ORD-\d{4}-\d{3,}$/);
    return result;
  };
  const action=(order,action,extra={},who='admin',expected=200)=>request(`/orders/${order.orderId}/actions`,{action,...extra},who,'POST',expected);
  const detail=order=>request(`/orders/${order.orderId}`);
  // Server-side payment rules, persisted reference/tender, and settings-based fees.
  const base={customerType:'Walk-in',warehouseId:warehouse,items:[{productId:product,qty:1}]};
  const beforeInvalid=await stock();
  await request('/sales',base,'admin','POST',400);
  await request('/sales',{...base,paymentMethod:'GCash'},'admin','POST',400);
  await request('/sales',{...base,paymentMethod:'Cash on Delivery (COD)'},'admin','POST',400);
  assert.equal(await stock(),beforeInvalid);
  for(const method of ['GCash','Card','Bank Transfer']){
    const digital=await request('/sales',{...base,paymentMethod:method,referenceNo:'REF-TEST-123'},'admin','POST',201);orders.push(digital.orderId);
    const sale=await request(`/sales/${digital.saleId}`);
    assert.equal(sale.paymentMethod,method);assert.equal(sale.referenceNo,'REF-TEST-123');assert.equal(Number(sale.amountCollected),100);assert.equal(Number(sale.changeDue),0);assert.equal(sale.orderId,digital.orderNo);
  }
  const rateRows=await request('/delivery-rates');assert.ok(rateRows.some(r=>r.name==='Motorcycle'));
  const q=distance=>request('/delivery-rates/quote',{vehicleId:vehicle,distance,subtotal:200},'admin','POST');
  assert.equal((await q(5)).fee,0);assert.equal((await q(6)).fee,10);
  const rateEdit={name:'Fixture',capacity:'20 kg',maxWeight:20,baseRate:60,perKm:12,minSubtotal:1000,freeDistance:5,enabled:true};
  await request(`/delivery-rates/${vehicle}`,rateEdit,'admin','PUT');
  assert.equal((await q(7)).fee,84);
  assert.equal((await request('/delivery-rates/quote',{vehicleId:vehicle,distance:7,subtotal:1000},'admin','POST')).fee,0);
  await request(`/delivery-rates/${vehicle}`,{...rateEdit,enabled:false},'admin','PUT');
  await request('/delivery-rates/quote',{vehicleId:vehicle,distance:7,subtotal:200},'admin','POST',400);
  await request(`/delivery-rates/${vehicle}`,{...rateEdit,enabled:true,baseRate:10,perKm:0,minSubtotal:0},'admin','PUT');
  await request(`/delivery-rates/${vehicle}`,{name:'Fixture',capacity:'20 kg',maxWeight:20,baseRate:10,perKm:2,minSubtotal:500,freeDistance:5,enabled:true},'rider','PUT',403);
  // Admin vehicle creation/removal, validation and persistent removal of defaults.
  const newVehicle=await request('/delivery-rates',{...rateEdit,name:'Custom Van'},'admin','POST',201);
  assert.ok((await request('/delivery-rates')).some(r=>r.id===newVehicle.id));
  await request('/delivery-rates',{...rateEdit,name:''},'admin','POST',400);
  await request('/delivery-rates',rateEdit,'rider','POST',403);
  await request(`/delivery-rates/${newVehicle.id}`,{},'rider','DELETE',403);
  await request(`/delivery-rates/${newVehicle.id}`,{},'admin','DELETE');
  assert.ok(!(await request('/delivery-rates')).some(r=>r.id===newVehicle.id));
  await request('/delivery-rates/quote',{vehicleId:newVehicle.id,distance:7,subtotal:200},'admin','POST',400);
  const defaultVehicle=rateRows.find(r=>r.name==='Motorcycle');
  await request(`/delivery-rates/${defaultVehicle.id}`,{},'admin','DELETE');
  assert.ok(!(await request('/delivery-rates')).some(r=>r.id===defaultVehicle.id),'Removed default must not return');
  await request(`/delivery-rates/${defaultVehicle.id}`,rateEdit,'admin','PUT',404);
  await request('/delivery-rates/distance',{address:''},'admin','POST',400);
  // Snapshot units and unpaid claim collecting payment atomically.
  const pickup=await create('Pick-up');let row=await detail(pickup);assert.equal(row.items[0].unit,'kg');assert.equal(Number(row.items[0].unitValue),2.7);assert.equal(row.paymentStatus,'Unpaid');
  await request(`/orders/${pickup.orderId}`,{scheduledPickupTime:'2099-11-01T09:00'},'admin','PUT',400);
  assert.equal(row.pickupDeadline,'2099-10-11 18:00:00');
  await action(pickup,'ready');await action(pickup,'claim',{},'admin',409);
  await action(pickup,'claim',{collectPayment:true,paymentMethod:'Cash',amountPaid:200});row=await detail(pickup);assert.equal(row.pickupStatus,'Claimed');assert.ok(row.archivedAt);
  await action(pickup,'claim',{collectPayment:true},'admin',409);
  let sales=await request('/sales');assert.ok(sales.some(s=>s.id===pickup.saleId));
  // Auto expiration restores the exact source allocation once.
  const expired=await create('Pick-up');const beforeExpire=await stock();
  await pool.query(`UPDATE \`Order\` SET PickupDeadline=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE OrderID=:id`,{id:expired.orderId});
  await request('/orders');await request('/orders');row=await detail(expired);assert.equal(row.pickupStatus,'Cancelled');assert.ok(row.restockedAt);assert.equal(await stock(),beforeExpire+2);
  // Prepaid expired pickup is retained until a manager settles it.
  const prepaid=await create('Pick-up',true);await pool.query(`UPDATE \`Order\` SET PickupDeadline=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE OrderID=:id`,{id:prepaid.orderId});await request('/orders');row=await detail(prepaid);assert.equal(row.pickupStatus,'Unclaimed');assert.equal(row.archivedAt,null);
  await action(prepaid,'claim',{},'admin',409);
  await request('/settings/pickup-policy',{allowIssueRefund:false,allowForfeitPayment:false},'admin','PUT',400);
  await request('/settings/pickup-policy',{allowIssueRefund:false,allowForfeitPayment:true},'admin','PUT');
  await action(prepaid,'settle',{resolutionAction:'Refunded',restockConfirmed:true,reason:'Fixture refund'},'admin',400);
  const beforeSettle=await stock();const results=await Promise.all([action(prepaid,'settle',{resolutionAction:'Forfeited',restockConfirmed:true,reason:'Fixture forfeiture'},'admin',null),action(prepaid,'settle',{resolutionAction:'Forfeited',restockConfirmed:true,reason:'Repeated request'},'admin',null)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(await stock(),beforeSettle+2);row=await detail(prepaid);assert.equal(row.paymentStatus,'Forfeited');assert.ok(row.archivedAt);assert.equal(Number(row.settlement.RetainedAmount),200);
  await request('/settings/pickup-policy',{allowIssueRefund:true,allowForfeitPayment:true},'admin','PUT');
  // Rider API isolation and three dispatches, not six counted attempts.
  const delivery=await create('Delivery');
  await request(`/orders/${delivery.orderId}`,{remarks:'Call on arrival',riderId:rider},'admin','PUT');
  assert.equal((await detail(delivery)).remarks,'Call on arrival');
  assert.equal((await detail(delivery)).deliveryRiderId,rider);
  await request(`/orders/${delivery.orderId}`,{remarks:'x'.repeat(256)},'admin','PUT',400);
  await request(`/orders/${delivery.orderId}`,{remarks:'Rider edit'},'rider','PUT',403);
  await request(`/orders/${delivery.orderId}`,{remarks:''},'admin','PUT');
  assert.equal((await detail(delivery)).remarks,'');
  await request(`/orders/${delivery.orderId}`,{deliveryAddress:'Changed'},'admin','PUT',400);
  await request(`/orders/${delivery.orderId}`,{riderId:rider},'admin','PUT');
  await action(delivery,'dispatch',{riderId:rider});
  const riderQueue=await request('/api/orders/deliveries',null,'rider');assert.ok(riderQueue.some(o=>o.orderId===delivery.orderId));
  const otherQueue=await request('/orders/deliveries',null,'other');assert.equal(otherQueue.length,0);
  await request(`/orders/${delivery.orderId}`,null,'other','GET',404);await request('/products',null,'rider','GET',403);
  await action(delivery,'cancel',{reason:'Not permitted'},'rider',403);await action(delivery,'failed',{failureReason:'Customer Unreachable',driverNotes:'No answer'},'rider');
  row=await detail(delivery);assert.equal(row.attemptCount,1);assert.equal(row.deliveryStatus,'Failed Attempt');assert.ok(row.nextAttemptDate);
  await action(delivery,'dispatch',{riderId:rider},'admin',409);
  await action(delivery,'assign',{riderId:rider});
  row=await detail(delivery);assert.equal(row.deliveryRiderId,rider);assert.equal(row.attemptCount,1);assert.equal(Number(row.retryDue),0);
  for(let attempt=2;attempt<=3;attempt++){
    await pool.query(`UPDATE \`Order\` SET NextAttemptDate=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE OrderID=:id`,{id:delivery.orderId});
    assert.equal(Number((await detail(delivery)).retryDue),1);
    await action(delivery,'dispatch',{});await action(delivery,'failed',{failureReason:'Refused Acceptance',driverNotes:'Fixture failure'},'rider');
    row=await detail(delivery);assert.equal(row.attemptCount,attempt);
  }
  assert.equal(row.deliveryStatus,'Cancelled');assert.ok(row.restockedAt);assert.ok(row.archivedAt);assert.equal(row.attempts.length,3);
  // Delivery confirmation records payment and fulfillment together.
  const cod=await create('Delivery');await action(cod,'dispatch',{riderId:rider});
  await action(cod,'delivered',{paymentMethod:'GCash'},'rider',400);
  row=await detail(cod);assert.equal(row.deliveryStatus,'Out for Delivery');assert.equal(row.paymentStatus,'Unpaid');
  const emptyStock=async()=>{const [[r]]=await pool.query(`SELECT EmptyStock FROM Inventory WHERE InventoryID=:id`,{id:inventory});return Number(r.EmptyStock);};
  await action(cod,'delivered',{paymentMethod:'GCash',referenceNo:'DELIVERY-REF-123',amountPaid:210,emptyReturns:[{productId:product,quantity:3}]},'rider',400);
  assert.equal(await emptyStock(),0);assert.equal((await detail(cod)).paymentStatus,'Unpaid');
  await action(cod,'delivered',{paymentMethod:'GCash',referenceNo:'DELIVERY-REF-123',amountPaid:210,emptyReturns:[{productId:product,quantity:1}]},'rider');
  assert.equal(await emptyStock(),1);
  await action(cod,'delivered',{emptyReturns:[{productId:product,quantity:1}]},'rider',409);assert.equal(await emptyStock(),1);
  row=await detail(cod);assert.equal(row.deliveryStatus,'Delivered');assert.equal(row.paymentStatus,'Paid');assert.ok(row.archivedAt);assert.equal(row.emptyCylinderReturned,1);
  const [[deliveryPayment]]=await pool.query('SELECT PaymentMethod,ReferenceNo,AmountPaid FROM Payment p JOIN Sales s ON s.SaleID=p.SaleID WHERE s.OrderID=:id',{id:cod.orderId});
  assert.equal(deliveryPayment.PaymentMethod,'GCash');assert.equal(deliveryPayment.ReferenceNo,'DELIVERY-REF-123');assert.equal(Number(deliveryPayment.AmountPaid),210);
  // Paid failed delivery can refund the net amount while retaining its fee.
  const failedPaid=await create('Delivery',true);for(let attempt=1;attempt<=3;attempt++){
    await pool.query(`UPDATE \`Order\` SET NextAttemptDate=NULL WHERE OrderID=:id`,{id:failedPaid.orderId});
    await action(failedPaid,'dispatch',{riderId:rider});await action(failedPaid,'failed',{failureReason:'Other',driverNotes:'Fixture prepaid failure'},'rider');
  }
  row=await detail(failedPaid);assert.equal(row.deliveryStatus,'Delivery Failed / Restocked');assert.equal(row.archivedAt,null);
  await action(failedPaid,'settle',{resolutionAction:'Refunded',refundDeliveryFee:false,restockConfirmed:true,reason:'Retain delivery fee'});row=await detail(failedPaid);assert.equal(Number(row.settlement.RefundAmount),200);assert.equal(Number(row.settlement.RetainedAmount),10);assert.equal(row.paymentStatus,'Refunded');
  // Walk-ins complete immediately with a nullable customer and never enter queues.
  const walkinSuccess=await request('/sales',{customerType:'Walk-in',paymentMethod:'Cash',warehouseId:warehouse,items:[{productId:product,qty:1}],amountCollected:150},'admin','POST',201);
  assert.equal(walkinSuccess.changeDue,50);
  const cashReceipt=await request(`/sales/${walkinSuccess.saleId}`);assert.equal(Number(cashReceipt.amountCollected),150);assert.equal(Number(cashReceipt.changeDue),50);assert.equal(cashReceipt.referenceNo,null);
  orders.push(walkinSuccess.orderId);sales=await request('/sales');const walkinSale=sales.find(s=>s.id===walkinSuccess.saleId);assert.ok(walkinSale);assert.equal(walkinSale.customerName,' — ');
  const active=await request('/orders');assert.ok(!active.some(o=>o.orderId===walkinSuccess.orderId));
  // Returned empties are separate stock; only refilling makes them sellable.
  const walkinReturn=await request('/sales',{customerType:'Walk-in',paymentMethod:'Cash',warehouseId:warehouse,items:[{productId:product,qty:2}],amountCollected:200,emptyReturns:[{productId:product,quantity:2}]},'admin','POST',201);
  orders.push(walkinReturn.orderId);assert.equal(await emptyStock(),3);
  const pickupReturn=await create('Pick-up',true);await action(pickupReturn,'ready');
  await pool.query(`UPDATE \`Order\` SET PickupDeadline=DATE_ADD(NOW(),INTERVAL 1 DAY) WHERE OrderID=:id`,{id:pickupReturn.orderId});
  await action(pickupReturn,'claim',{emptyReturns:[{productId:product,quantity:1}]});assert.equal(await emptyStock(),4);
  const beforeRefill=await stock();
  await request(`/inventory/${inventory}/cylinders`,{action:'refill',quantity:5,expectedEmptyStock:4,remarks:'Too many'},'admin','POST',409);
  await request(`/inventory/${inventory}/cylinders`,{action:'refill',quantity:1,expectedEmptyStock:4,remarks:'Unauthorized'},'rider','POST',403);
  await request(`/inventory/${inventory}/cylinders`,{action:'refill',quantity:2,expectedEmptyStock:4,remarks:'Fixture refill'});
  assert.equal(await stock(),beforeRefill+2);assert.equal(await emptyStock(),2);
  await request(`/inventory/${inventory}/cylinders`,{action:'refill',quantity:1,expectedEmptyStock:4,remarks:'Stale form'},'admin','POST',409);
  await request(`/inventory/${inventory}/cylinders`,{action:'set-empty',quantity:5,expectedEmptyStock:2,remarks:'Physical empty count'});assert.equal(await stock(),beforeRefill+2);assert.equal(await emptyStock(),5);
  const inventoryRows=await request('/inventory');const tankRow=inventoryRows.find(i=>i.inventoryId===inventory);assert.equal(tankRow.emptyStock,5);assert.equal(tankRow.currentStock,beforeRefill+2);
  const catalog=await request(`/products?warehouseId=${warehouse}`);assert.equal(Number(catalog.find(p=>p.productId===product).stock),beforeRefill+2);
  await pool.query(`UPDATE Inventory SET StockOnHand=0 WHERE InventoryID=:id`,{id:inventory});
  await request('/sales',{customerType:'Walk-in',paymentMethod:'Cash',warehouseId:warehouse,items:[{productId:product,qty:1}],amountCollected:100},'admin','POST',409);
  assert.equal(await emptyStock(),5);
  await pool.query(`UPDATE Inventory SET StockOnHand=:qty WHERE InventoryID=:id`,{qty:beforeRefill+2,id:inventory});
  await request('/inventory/stock-in',{warehouseId:warehouse,stockType:'empty',items:[{productId:product,quantity:2}]},'admin','POST',201);assert.equal(await emptyStock(),7);assert.equal(await stock(),beforeRefill+2);
  await request('/inventory/stock-out',{warehouseId:warehouse,stockType:'empty',reason:'Damaged',items:[{productId:product,quantity:1}]},'admin','POST',201);assert.equal(await emptyStock(),6);
  await request('/inventory/stock-out',{warehouseId:warehouse,stockType:'empty',items:[{productId:product,quantity:7}]},'admin','POST',400);
  await request('/inventory/stock-in',{warehouseId:warehouse,stockType:'empty',items:[{productId:product,quantity:-1}]},'admin','POST',400);
  await request('/inventory/stock-in',{warehouseId:warehouse,stockType:'empty',items:[{productId:product,quantity:1.5}]},'admin','POST',400);
  await request('/inventory/transfer',{fromWarehouseId:warehouse,toWarehouseId:warehouse2,stockType:'empty',items:[{productId:product,quantity:2}]},'admin','POST',201);
  assert.equal(await emptyStock(),4);assert.equal(await stock(),beforeRefill+2);
  const [[destination]]=await pool.query(`SELECT StockOnHand,EmptyStock FROM Inventory WHERE InventoryID=:id`,{id:inventory2});assert.equal(destination.StockOnHand,0);assert.equal(destination.EmptyStock,2);
  assert.equal((await request('/inventory/transfers')).find(t=>t.fromWarehouseId===warehouse).stockType,'empty');
  const refillBody={action:'refill',quantity:1,expectedEmptyStock:4};
  const concurrent=await Promise.all([request(`/inventory/${inventory}/cylinders`,refillBody,'admin','POST',null),request(`/inventory/${inventory}/cylinders`,refillBody,'admin','POST',null)]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);assert.equal(await emptyStock(),3);assert.equal(await stock(),beforeRefill+3);
  // Stock adjustments are audited and roll back prices when validation fails.
  await request(`/products/${product}`,{unitPrice:120,stock:-1,warehouseId:warehouse},'admin','PUT',400);
  const unchanged=await request(`/products/${product}`);assert.equal(Number(unchanged.UnitPrice),100);
  const oldStock=await stock();await request(`/products/${product}`,{unit:'meter',unitValue:1.5,stock:oldStock+1,warehouseId:warehouse},'admin','PUT');assert.equal(await stock(),oldStock+1);
  row=await detail(pickup);assert.equal(row.items[0].unit,'kg');assert.equal(Number(row.items[0].unitValue),2.7);
  await request(`/products/${product}`,{unit:'kg',unitValue:2.7,stock:oldStock,warehouseId:warehouse},'admin','PUT');
  // Product and customer hard deletes retain sales, order unit snapshots and stock linkage.
  const deletedProduct=await create('Pick-up',true);
  await request(`/products/${product}`,{},'admin','DELETE');
  row=await detail(deletedProduct);assert.equal(row.items[0].productId,null);assert.equal(row.items[0].name,'Lifecycle Test 2.7 kg');assert.equal(Number(row.items[0].unitValue),2.7);
  await action(deletedProduct,'cancel',{reason:'Deleted catalog product'});await action(deletedProduct,'settle',{resolutionAction:'Refunded',restockConfirmed:true,reason:'Fixture refund after delete'});
  await request(`/customers/${customer}`,{},'admin','DELETE');row=await detail(pickup);assert.equal(row.customerId,null);assert.equal(row.customerName,' — ');
  // Walk-ins skip both fulfillment queues and are already completed.
  const walkin=await request('/sales',{customerType:'Walk-in',paymentMethod:'Cash',warehouseId:warehouse,items:[{productId:product,qty:1}],amountCollected:100},'admin','POST',400);assert.ok(walkin.error);
  const [[counts]]=await pool.query(`SELECT COUNT(*) AS count FROM OrderDetails WHERE OrderID=:id`,{id:pickup.orderId});assert.equal(counts.count,1);
  console.log('PASS: order lifecycle, cylinder returns for walk-in/pickup/delivery, filled-only sales, empty stock movements/transfers, atomic refill, stale/concurrent refill protection, and product/customer history.');
}
async function cleanup(){
  if(child){child.kill();await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});}
  const [saved]=await pool.query(`SELECT OrderID,SaleID FROM Sales WHERE UserID=:admin`,{admin});
  for(const order of saved){
    await pool.query(`DELETE FROM OrderSettlement WHERE OrderID=:id`,{id:order.OrderID});await pool.query(`DELETE FROM DeliveryAttempt WHERE OrderID=:id`,{id:order.OrderID});await pool.query(`DELETE FROM OrderStockAllocation WHERE OrderID=:id`,{id:order.OrderID});
    await pool.query(`DELETE FROM Delivery WHERE SaleID=:id`,{id:order.SaleID});await pool.query(`DELETE FROM Payment WHERE SaleID=:id`,{id:order.SaleID});await pool.query(`DELETE FROM Sales WHERE SaleID=:id`,{id:order.SaleID});await pool.query(`DELETE FROM OrderDetails WHERE OrderID=:id`,{id:order.OrderID});await pool.query(`DELETE FROM \`Order\` WHERE OrderID=:id`,{id:order.OrderID});
  }
  await pool.query(`DELETE td FROM TransferDetail td JOIN Transfer t ON t.TransferID=td.TransferID WHERE t.FromWarehouseID=:warehouse`,{warehouse});
  await pool.query(`DELETE FROM Transfer WHERE FromWarehouseID=:warehouse`,{warehouse});
  await pool.query(`DELETE FROM InventoryTransaction WHERE InventoryID IN (:id,:id2)`,{id:inventory,id2:inventory2});await pool.query(`DELETE FROM Inventory WHERE InventoryID IN (:id,:id2)`,{id:inventory,id2:inventory2});await pool.query(`DELETE FROM Product WHERE ProductID=:id`,{id:product});
  if(customer)await pool.query(`DELETE FROM Customer WHERE CustomerID=:id`,{id:customer});
  for(const user of [admin,rider,otherRider]){await pool.query(`DELETE FROM UserActivity WHERE UserID=:id`,{id:user});await pool.query(`DELETE FROM User WHERE UserID=:id`,{id:user});}
  await pool.query(`DELETE FROM Warehouse WHERE WarehouseID IN (:id,:id2)`,{id:warehouse,id2:warehouse2});await pool.query(`DELETE FROM DeliveryVehicleRate WHERE CompanyID=:id`,{id:company});
  await pool.query(`DELETE FROM CompanySettings WHERE CompanyID=:id`,{id:company});await pool.query(`DELETE FROM Company WHERE CompanyID=:id`,{id:company});
}
run().catch(err=>{console.error(err.stack);process.exitCode=1;}).finally(async()=>{try{await cleanup();}catch(err){console.error('Fixture cleanup:',err.message);process.exitCode=1;}await pool.end();});
