const router=require('express').Router();
const pool=require('../config/db');
const asyncHandler=require('../utils/asyncHandler');
const ApiError=require('../utils/apiError');
const {authenticate}=require('../middleware/auth');
const lifecycle=require('../services/orderLifecycle');
const createOrder=require('../services/createOrder');
const {tankSql}=require('../services/cylinderStock');
router.use(authenticate);
const SELECT=`SELECT o.OrderID AS orderId,o.OrderNo AS id,o.CustomerID AS customerId,
  COALESCE(c.CustomerName,' — ') AS customerName,c.ContactNo AS customerPhone,c.Address AS customerAddress,c.Landmark AS customerLandmark,
  o.OrderType AS type,o.OrderStatus AS status,o.OrderDate AS date,o.TotalAmount AS totalAmount,o.Remarks AS remarks,
  o.PickupStatus AS pickupStatus,o.DeliveryStatus AS deliveryStatus,o.PaymentStatus AS paymentStatus,
  o.ScheduledPickupTime AS scheduledPickupTime,o.PickupDeadline AS pickupDeadline,o.ArchivedAt AS archivedAt,
  o.AttemptCount AS attemptCount,o.MaxAttempts AS maxAttempts,o.NextAttemptDate AS nextAttemptDate,o.LastAttemptDate AS lastAttemptDate,
  (o.NextAttemptDate IS NULL OR NOW()>=o.NextAttemptDate) AS retryDue,
  o.DeliveredAt AS deliveredAt,o.DeliveryNo AS drNo,o.AssignedRiderID AS deliveryRiderId,o.EmptyCylinderReturned AS emptyCylinderReturned,
  o.ReceiverName AS receiverName,o.ReceiverSignature AS receiverSignature,o.CashCollectedAmount AS cashCollectedAmount,
  o.CancellationRemarks AS cancellationRemarks,o.ResolutionAction AS resolutionAction,o.ResolutionReason AS resolutionReason,o.RestockedAt AS restockedAt,
  o.DeliveryInstructions AS deliveryInstructions,o.SubtotalSnapshot AS subtotal,o.VatSnapshot AS vat,o.TaxRateSnapshot AS taxRate,s.SalesDiscount AS discount,CONCAT(cashier.FirstName,' ',cashier.LastName) AS cashierName,o.Landmark AS landmark,s.SaleID AS saleId,s.SaleNo AS saleNo,
  COALESCE(pay.amountPaid,0) AS amountPaid,COALESCE(pay.paymentMethod,o.PaymentMethod) AS paymentMethod,pay.referenceNo,pay.amountTendered AS amountCollected,pay.changeDue,d.DeliveryID AS deliveryId,d.DeliveryCharge AS deliveryFee,d.DeliveryAddress AS deliveryAddress,
  CASE WHEN rider.UserID IS NULL THEN NULL ELSE CONCAT(rider.FirstName,' ',rider.LastName) END AS deliveryRiderName
  FROM \`Order\` o LEFT JOIN Customer c ON c.CustomerID=o.CustomerID
  LEFT JOIN Sales s ON s.OrderID=o.OrderID LEFT JOIN User cashier ON cashier.UserID=s.UserID
  LEFT JOIN (SELECT SaleID,SUM(AmountPaid) AS amountPaid,MAX(PaymentMethod) AS paymentMethod,MAX(ReferenceNo) AS referenceNo,SUM(COALESCE(AmountTendered,AmountPaid)) AS amountTendered,SUM(COALESCE(ChangeDue,0)) AS changeDue FROM Payment GROUP BY SaleID) pay ON pay.SaleID=s.SaleID
  LEFT JOIN Delivery d ON d.SaleID=s.SaleID LEFT JOIN User rider ON rider.UserID=o.AssignedRiderID`;
async function list(req,res,deliveryOnly=false) {
  const failures=await lifecycle.sweepExpired(req.user.companyId);
  let sql=SELECT+` WHERE o.CompanyID=:company AND o.OrderType IN ('Pick-up','Delivery') AND o.ArchivedAt IS NULL`;
  const params={company:req.user.companyId};
  if (lifecycle.isRider(req.user)) { sql+=` AND o.OrderType='Delivery' AND o.AssignedRiderID=:rider`; params.rider=req.user.userId; }
  else if (deliveryOnly || req.query.type==='Delivery') sql+=` AND o.OrderType='Delivery'`;
  else if (['Pickup','Pick-up'].includes(req.query.type)) sql+=` AND o.OrderType='Pick-up'`;
  if (req.query.search) { sql+=` AND (o.OrderNo LIKE :search OR c.CustomerName LIKE :search OR o.DeliveryNo LIKE :search)`; params.search=`%${req.query.search}%`; }
  if (req.query.status) { sql+=` AND (o.PickupStatus=:status OR o.DeliveryStatus=:status)`; params.status=req.query.status; }
  const [rows]=await pool.query(sql+` ORDER BY o.OrderDate DESC,o.OrderID DESC`,params); res.json(rows.map(row=>({...row,lifecycleWarning:failures.find(f=>f.orderId===row.orderId)?.message || null})));
}
router.get('/',asyncHandler((req,res)=>list(req,res)));
router.get('/deliveries',asyncHandler((req,res)=>list(req,res,true)));
router.get('/policy',asyncHandler(async(req,res)=>{
  const [[row]]=await pool.query(`SELECT AllowIssueRefund,AllowForfeitPayment FROM CompanySettings WHERE CompanyID=:id`,{id:req.user.companyId});
  res.json({allowIssueRefund:row ? !!row.AllowIssueRefund:true,allowForfeitPayment:row ? !!row.AllowForfeitPayment:true,canSettle:lifecycle.isManager(req.user)});
}));
router.get('/riders',asyncHandler(async(req,res)=>{
  if(lifecycle.isRider(req.user)) throw new ApiError(403,'Riders cannot reassign deliveries.');
  const [rows]=await pool.query(`SELECT u.UserID AS id,CONCAT(u.FirstName,' ',u.LastName) AS name FROM User u JOIN Role r ON r.RoleID=u.RoleID WHERE u.CompanyID=:company AND u.Status='Active' AND LOWER(r.RoleName) IN ('rider','driver','drivers') ORDER BY name`,{company:req.user.companyId});res.json(rows);
}));
router.get('/:id',asyncHandler(async(req,res)=>{
  let sql=SELECT+` WHERE o.OrderID=:id AND o.CompanyID=:company`;const params={id:req.params.id,company:req.user.companyId};
  if(lifecycle.isRider(req.user)){sql+=` AND o.OrderType='Delivery' AND o.AssignedRiderID=:rider`;params.rider=req.user.userId;}
  const [[order]]=await pool.query(sql,params);if(!order)throw new ApiError(404,'Order not found.');
  const [items]=await pool.query(`SELECT od.ProductID AS productId,COALESCE(p.ProductName,od.ProductNameSnapshot,'Deleted Product') AS name,od.Quantity AS qty,od.UnitPriceSnapshot AS unitPrice,od.Subtotal AS subtotal,od.UnitSnapshot AS unit,od.UnitValueSnapshot AS unitValue,${tankSql} AS isTank FROM OrderDetails od LEFT JOIN Product p ON p.ProductID=od.ProductID LEFT JOIN Category c ON c.CategoryID=p.CategoryID WHERE od.OrderID=:id`,{id:req.params.id});
  const [attempts]=await pool.query(`SELECT AttemptNumber AS attempt,DispatchedAt AS dispatchedAt,FailedAt AS failedAt,FailureReason AS reason,DriverNotes AS notes FROM DeliveryAttempt WHERE OrderID=:id ORDER BY AttemptNumber`,{id:req.params.id});
  const [[settlement]]=await pool.query(`SELECT * FROM OrderSettlement WHERE OrderID=:id`,{id:req.params.id});
  res.json({...order,items,attempts,settlement:settlement || null});
}));
router.post('/',asyncHandler(async(req,res)=>res.status(201).json(await createOrder(req.user,req.body))));
router.post('/:id/actions',asyncHandler(async(req,res)=>res.json(await lifecycle.transition(req.params.id,req.user,req.body))));
router.put('/:id/payment',asyncHandler(async(req,res)=>res.json(await lifecycle.transition(req.params.id,req.user,{...req.body,action:'pay'}))));
router.put('/:id/delivery',asyncHandler(async(req,res)=>{
  const map={'Out for Delivery':'dispatch',Delivered:'delivered','Failed Attempt':'failed'};
  const action=map[req.body.deliveryStatus] || 'assign';
  res.json(await lifecycle.transition(req.params.id,req.user,{...req.body,action,riderId:req.body.deliveryRiderId}));
}));
router.put('/:id',asyncHandler(async(req,res)=>{
  if(Object.keys(req.body).some(key=>!['riderId','remarks'].includes(key)))throw new ApiError(400,'Only the assigned delivery rider and notes can be edited.');
  res.json(await lifecycle.transition(req.params.id,req.user,{...req.body,action:'edit'}));
}));
router.delete('/:id',asyncHandler(async(req,res)=>res.json(await lifecycle.transition(req.params.id,req.user,{...req.body,action:'cancel'}))));
module.exports=router;
