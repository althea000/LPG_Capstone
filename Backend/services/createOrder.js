const ApiError=require('../utils/apiError');
const {nextSequence}=require('../utils/generateNumbers');
const {id,money,pickupTime,transaction,isRider}=require('./orderLifecycle');
async function createOrder(user,body) {
  if (isRider(user)) throw new ApiError(403,'Riders cannot create orders.');
  const type=body.orderType || body.customerType || 'Walk-in';
  const orderType=type==='Pickup' ? 'Pick-up' : type;
  if (!['Walk-in','Pick-up','Delivery'].includes(orderType)) throw new ApiError(400,'Invalid order type.');
  const details=orderType==='Pick-up' ? body.pickupDetails || {} : body.deliveryDetails || {};
  const customerId=body.customerId || details.customerId;
  if (orderType!=='Walk-in' && !customerId) throw new ApiError(400,'Select a customer for pickup or delivery.');
  const schedule=orderType==='Pick-up' ? pickupTime(body.scheduledPickupTime || `${details.pickupDate || ''} ${details.pickupTime || ''}`) : null;
  const address=body.deliveryAddress || details.address;
  if (orderType==='Delivery' && !String(address || '').trim()) throw new ApiError(400,'Delivery address is required.');
  const items=body.items;
  if(body.emptyReturns!==undefined && !Array.isArray(body.emptyReturns)) throw new ApiError(400,'Empty cylinder returns must be a list of product quantities.');
  if(body.emptyReturns?.some(item=>!item || typeof item!=='object' || !item.productId || !Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity)<0)) throw new ApiError(400,'Each empty return requires a product and a nonnegative whole-number quantity.');
  if (!Array.isArray(items) || !items.length || items.length>100) throw new ApiError(400,'Include 1 to 100 order items.');
  const merged=new Map();
  for (const item of items) {
    if (!item.productId || !Number.isInteger(Number(item.qty)) || Number(item.qty)<=0) throw new ApiError(400,'Item quantities must be positive whole numbers.');
    const qty=Number(item.qty); const key=String(item.productId);
    merged.set(key,(merged.get(key)||0)+qty);
  }
  return transaction(async conn=>{
    if (customerId) { const [[customer]]=await conn.query(`SELECT CustomerID FROM Customer WHERE CustomerID=:id`,{id:customerId}); if (!customer) throw new ApiError(400,'Customer not found.'); }
    const warehouseId=body.warehouseId || user.warehouseId || 'WH-001';
    const [[warehouse]]=await conn.query(`SELECT WarehouseID FROM Warehouse WHERE WarehouseID=:id AND CompanyID=:company`,{id:warehouseId,company:user.companyId});
    if (!warehouse) throw new ApiError(400,'Select a warehouse from your company.');
    const [[policy]]=await conn.query(`SELECT TaxRate,TaxEnabled FROM CompanySettings WHERE CompanyID=:id`,{id:user.companyId});
    const products=[];
    for (const [productId,qty] of [...merged.entries()].sort(([a],[b])=>a.localeCompare(b))) {
      const [[product]]=await conn.query(`SELECT * FROM Product WHERE ProductID=:id AND Status='Active' FOR UPDATE`,{id:productId});
      if (!product) throw new ApiError(400,'Product not available.');
      const [[inventory]]=await conn.query(`SELECT * FROM Inventory WHERE ProductID=:product AND WarehouseID=:warehouse FOR UPDATE`,{product:productId,warehouse:warehouseId});
      if (!inventory || Number(inventory.StockOnHand)<qty) throw new ApiError(409,`Insufficient stock for ${product.ProductName}.`);
      products.push({product,inventory,qty});
    }
    const subtotal=money(products.reduce((sum,p)=>sum+Number(p.product.UnitPrice)*p.qty,0));
    const discount=money(body.discount || 0);
    const deliveryQuote=orderType==='Delivery'?await require('./deliveryRates').quote(conn,user.companyId,details.vehicleId || body.vehicleId,details.distanceKm ?? body.distanceKm,subtotal-discount):null;
    const fee=deliveryQuote?.fee || 0;
    if (!Number.isFinite(discount) || discount<0 || discount>subtotal || !Number.isFinite(fee) || fee<0) throw new ApiError(400,'Invalid discount or delivery fee.');
    // Catalog prices are VAT inclusive, as displayed by the POS.
    const totalAmount=money(subtotal-discount+fee);
    const taxRate=policy?.TaxEnabled ? Number(policy.TaxRate)/100 : 0;
    const vat=taxRate ? money((subtotal-discount)*taxRate/(1+taxRate)) : 0;
    const method=String(body.paymentMethod || '').trim();
    if(!['Cash','GCash','Card','Bank Transfer','Cash on Delivery (COD)'].includes(method))throw new ApiError(400,'Select a payment method.');
    const cod=method==='Cash on Delivery (COD)';
    if(cod && orderType!=='Delivery')throw new ApiError(400,'Cash on Delivery is available for deliveries only.');
    const reference=String(body.referenceNo || '').trim();
    if(!cod && method!=='Cash' && (!reference || reference.length>50))throw new ApiError(400,'A payment reference number (up to 50 characters) is required.');
    const paid=!cod;
    if(method==='Cash' && body.amountCollected===undefined)throw new ApiError(400,'Enter the cash amount collected.');
    if (paid && body.amountCollected!==undefined && (!Number.isFinite(Number(body.amountCollected)) || Number(body.amountCollected)<totalAmount)) throw new ApiError(400,'Collected amount must cover the order total.');
    const saleId=id('S');
    const orderNo=await nextSequence(conn,'`Order`','OrderNo','ORD');
    const orderId=orderNo;
    const saleNo=await nextSequence(conn,'Sales','SaleNo','SALE');
    await conn.query(`INSERT INTO \`Order\`(OrderID,CustomerID,CompanyID,OrderNo,OrderType,OrderStatus,TotalAmount,Remarks,ScheduledPickupTime,PickupDeadline,PaymentStatus,Landmark,PaymentMethod,SubtotalSnapshot,VatSnapshot,TaxRateSnapshot,DeliveryInstructions,DeliveryVehicleID,DeliveryDistanceKm)
      VALUES (:id,:customer,:company,:number,:type,:status,:total,:remarks,:schedule,CASE WHEN :schedule IS NULL THEN NULL ELSE TIMESTAMP(DATE_ADD(DATE(:schedule),INTERVAL 2 DAY),'18:00:00') END,:payment,:landmark,:method,:subtotal,:vat,:taxRate,:instructions,:vehicle,:distance)`,
      {id:orderId,customer:customerId || null,company:user.companyId,number:orderNo,type:orderType,status:orderType==='Walk-in' ? 'Completed' : 'Preparing',total:totalAmount,remarks:body.remarks || details.instructions || null,schedule,payment:paid ? 'Paid':'Unpaid',landmark:null,method,subtotal,vat,taxRate,instructions:details.instructions || null,vehicle:deliveryQuote?.vehicleId || null,distance:deliveryQuote?.distance ?? null});
    for (const {product,inventory,qty} of products) {
      await conn.query(`INSERT INTO OrderDetails(OrderDetailID,OrderID,ProductID,Quantity,UnitPrice,Subtotal) VALUES (:id,:order,:product,:qty,:price,:subtotal)`,{id:id('OD'),order:orderId,product:product.ProductID,qty,price:product.UnitPrice,subtotal:money(qty*Number(product.UnitPrice))});
      await conn.query(`UPDATE Inventory SET StockOnHand=StockOnHand-:qty WHERE InventoryID=:id`,{qty,id:inventory.InventoryID});
      await conn.query(`INSERT INTO OrderStockAllocation(OrderID,InventoryID,Quantity) VALUES (:order,:inventory,:qty)`,{order:orderId,inventory:inventory.InventoryID,qty});
      await conn.query(`INSERT INTO InventoryTransaction(TransactionID,InventoryID,UserID,TransactionType,Quantity,Reason,ReferenceNo) VALUES (:id,:inventory,:user,'Stock Out',:qty,'Sale',:ref)`,{id:id('T'),inventory:inventory.InventoryID,user:user.userId,qty,ref:orderNo});
    }
    await conn.query(`INSERT INTO Sales(SaleID,OrderID,CustomerID,UserID,SaleNo,SalesDiscount,TotalAmount,Remarks) VALUES (:id,:order,:customer,:user,:number,:discount,:total,:remarks)`,{id:saleId,order:orderId,customer:customerId || null,user:user.userId,number:saleNo,discount,total:totalAmount,remarks:body.remarks || null});
    if (paid && totalAmount>0) await conn.query(`INSERT INTO Payment(PaymentID,PaymentType,SaleID,PaymentMethod,AmountPaid,ReferenceNo,AmountTendered,ChangeDue) VALUES (:id,'Sale',:sale,:method,:amount,:reference,:tendered,:change)`,{id:id('PAY'),sale:saleId,method,amount:totalAmount,reference:method==='Cash'?null:reference,tendered:method==='Cash'?Number(body.amountCollected):totalAmount,change:method==='Cash'?money(Number(body.amountCollected)-totalAmount):0});
    let deliveryNo=null;
    if (orderType==='Delivery') {
      deliveryNo=await nextSequence(conn,'Delivery','DRNo','DEL');
      const riderId=details.riderId || body.riderId || null;
      if (riderId) {
        const [[rider]]=await conn.query(`SELECT u.UserID FROM User u JOIN Role r ON r.RoleID=u.RoleID WHERE u.UserID=:id AND u.CompanyID=:company AND u.Status='Active' AND LOWER(r.RoleName) IN ('rider','driver','drivers')`,{id:riderId,company:user.companyId});
        if (!rider) throw new ApiError(400,'Invalid assigned rider.');
      }
      await conn.query(`INSERT INTO Delivery(DeliveryID,SaleID,DRNo,DeliveryCharge,DeliveryAddress,DeliveryStatus,DeliveredByUserID) VALUES (:id,:sale,:number,:fee,:address,'Preparing',:rider)`,{id:id('D'),sale:saleId,number:deliveryNo,fee,address:String(address).trim(),rider:riderId});
      await conn.query(`UPDATE \`Order\` SET DeliveryNo=:number,AssignedRiderID=:rider WHERE OrderID=:id`,{number:deliveryNo,rider:riderId,id:orderId});
    }
    if(orderType==='Walk-in') await require('./cylinderStock').recordReturns(conn,orderId,user,body.emptyReturns || []);
    else if(body.emptyReturns?.some(item=>Number(item.quantity)>0)) throw new ApiError(400,'Record returned cylinders when the pickup is claimed or the delivery is completed.');
    await conn.query(`INSERT INTO UserActivity(UserActivityID,UserID,ActivityType,Module,RecordID,Description) VALUES (:id,:user,'Create','Orders & Delivery',:order,:description)`,{id:id('UA'),user:user.userId,order:orderId,description:`Created ${orderType} transaction`});
    return {orderId,orderNo,saleId,saleNo,deliveryNo,paymentMethod:method,referenceNo:reference,paymentStatus:paid?'Paid':'Unpaid',amountCollected:cod?null:method==='Cash'?Number(body.amountCollected):totalAmount,pickupDeadline:schedule?new Date(new Date(schedule.replace(' ','T')).getTime()+2*86400000).toISOString().slice(0,10)+' 18:00:00':null,subtotal,discount,vat,taxRate,totalAmount,deliveryFee:fee,changeDue:method==='Cash' && body.amountCollected!==undefined ? money(Number(body.amountCollected)-totalAmount):0};
  });
}
module.exports=createOrder;
