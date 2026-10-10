const crypto = require('crypto');
const pool = require('../config/db');
const ApiError = require('../utils/apiError');
const id = prefix => `${prefix}-${crypto.randomBytes(8).toString('hex').slice(0,19-prefix.length)}`;
const role = user => String(user.roleName || user.role || '').trim().toLowerCase();
const isRider = user => ['rider','driver','drivers'].includes(role(user));
const isManager = user => ['admin','administrator','manager','operations supervisor','store supervisor'].includes(role(user));
const money = value => Math.round(Number(value) * 100) / 100;
function requireNotes(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 255) throw new ApiError(400,'Reason / notes are required (up to 255 characters).');
  return text;
}
function pickupTime(value) {
  const text = String(value || '').replace('T',' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text) || !Number.isFinite(Date.parse(text.replace(' ','T')+'+08:00'))) throw new ApiError(400,'A valid scheduled pickup date and time is required.');
  const minutes = Number(text.slice(11,13))*60+Number(text.slice(14,16));
  if (minutes < 480 || minutes > 1080) throw new ApiError(400,'Pickup time must be between 8:00 AM and 6:00 PM.');
  return text.length===16 ? text+':00' : text;
}
async function transaction(work) {
  const conn=await pool.getConnection();
  try { await conn.beginTransaction(); const result=await work(conn); await conn.commit(); return result; }
  catch(err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
}
async function audit(conn,user,order,description) {
  await conn.query(`INSERT INTO UserActivity(UserActivityID,UserID,ActivityType,Module,RecordID,Description) VALUES (:id,:user,'Update','Orders & Delivery',:order,:description)`, {id:id('UA'),user:user.userId,order:order.OrderID,description});
}
async function lockOrder(conn,orderId,user) {
  const [[order]]=await conn.query(`SELECT *, (PickupDeadline IS NOT NULL AND NOW()>PickupDeadline) AS expired,
    (NextAttemptDate IS NULL OR NOW()>=NextAttemptDate) AS retryDue FROM \`Order\` WHERE OrderID=:id AND CompanyID=:company FOR UPDATE`,{id:orderId,company:user.companyId});
  if (!order || (isRider(user) && (order.OrderType!=='Delivery' || order.AssignedRiderID!==user.userId))) throw new ApiError(404,'Order not found.');
  const [[sale]]=await conn.query(`SELECT s.SaleID,COALESCE(SUM(p.AmountPaid),0) AS paid FROM Sales s LEFT JOIN Payment p ON p.SaleID=s.SaleID WHERE s.OrderID=:id GROUP BY s.SaleID`,{id:orderId});
  if (!sale) throw new ApiError(409,'Order has no linked sales record.');
  order.saleId=sale.SaleID; order.paid=money(sale.paid);
  const [[delivery]]=await conn.query(`SELECT * FROM Delivery WHERE SaleID=:sale`,{sale:sale.SaleID});
  order.delivery=delivery;
  return order;
}
async function restock(conn,order,user,notes) {
  if (order.RestockedAt) return;
  const [allocations]=await conn.query(`SELECT a.InventoryID,a.Quantity FROM OrderStockAllocation a WHERE a.OrderID=:id ORDER BY a.InventoryID FOR UPDATE`,{id:order.OrderID});
  const [[totals]]=await conn.query(`SELECT COALESCE(SUM(Quantity),0) AS qty FROM OrderDetails WHERE OrderID=:id`,{id:order.OrderID});
  if (allocations.reduce((sum,a)=>sum+Number(a.Quantity),0)!==Number(totals.qty)) throw new ApiError(409,'Original stock allocations are incomplete; reconcile the order before restocking.');
  for (const allocation of allocations) {
    await conn.query(`UPDATE Inventory SET StockOnHand=StockOnHand+:qty WHERE InventoryID=:id`,{qty:allocation.Quantity,id:allocation.InventoryID});
    await conn.query(`INSERT INTO InventoryTransaction(TransactionID,InventoryID,UserID,TransactionType,Quantity,Reason,ReferenceNo,Remarks) VALUES (:id,:inventory,:user,'Restock',:qty,'Adjustment',:ref,:notes)`,{id:id('T'),inventory:allocation.InventoryID,user:user.userId,qty:allocation.Quantity,ref:order.OrderNo,notes});
  }
  await conn.query(`UPDATE \`Order\` SET RestockedAt=NOW() WHERE OrderID=:id`,{id:order.OrderID});
  order.RestockedAt=true;
}
async function archive(conn,order) {
  if ((order.PickupStatus==='Claimed' || order.DeliveryStatus==='Delivered') && order.PaymentStatus==='Paid') {
    await conn.query(`UPDATE \`Order\` SET ArchivedAt=COALESCE(ArchivedAt,NOW()),OrderStatus='Completed' WHERE OrderID=:id`,{id:order.OrderID});
  }
}
async function expire(conn,order,user) {
  if (!order.expired || order.ArchivedAt || !['Preparing','Ready for Pickup'].includes(order.PickupStatus)) return;
  if (order.paid>0) {
    await conn.query(`UPDATE \`Order\` SET PickupStatus='Unclaimed',OrderStatus='Unclaimed' WHERE OrderID=:id`,{id:order.OrderID}); order.PickupStatus='Unclaimed';
  } else {
    await restock(conn,order,user,'Auto-restock: Unclaimed unpaid pickup');
    await conn.query(`UPDATE \`Order\` SET PickupStatus='Cancelled',OrderStatus='Cancelled',CancellationRemarks='Auto-restock: Unclaimed unpaid pickup',ArchivedAt=NOW() WHERE OrderID=:id`,{id:order.OrderID}); order.ArchivedAt=true;
    await conn.query(`UPDATE Sales SET TotalAmount=0 WHERE SaleID=:id`,{id:order.saleId});
  }
  await audit(conn,user,order,'Pickup deadline expired');
}
async function pay(conn,order,user,body) {
  if (['Refunded','Forfeited','Refund Pending'].includes(order.PaymentStatus) || order.RestockedAt || ['Cancelled','Unclaimed'].includes(order.PickupStatus) || ['Cancelled','Delivery Failed / Restocked'].includes(order.DeliveryStatus)) throw new ApiError(409,'This order requires settlement instead of payment.');
  const remaining=money(Number(order.TotalAmount)-order.paid);
  if (remaining<=0) { await conn.query(`UPDATE \`Order\` SET PaymentStatus='Paid' WHERE OrderID=:id`,{id:order.OrderID}); order.PaymentStatus='Paid'; await archive(conn,order); return; }
  const amount=body.amountPaid===undefined ? remaining : money(body.amountPaid);
  if (!Number.isFinite(amount) || amount!==remaining || amount<=0) throw new ApiError(400,`Collect the full remaining balance of ${remaining.toFixed(2)}.`);
  const method=String(body.paymentMethod || 'Cash');
  if (!['Cash','GCash','Card','Bank Transfer'].includes(method)) throw new ApiError(400,'Invalid payment method.');
  const reference=String(body.referenceNo || '').trim();
  if(method!=='Cash' && (!reference || reference.length>50))throw new ApiError(400,'A payment reference number is required.');
  await conn.query(`INSERT INTO Payment(PaymentID,PaymentType,SaleID,PaymentMethod,AmountPaid,ReferenceNo,AmountTendered,ChangeDue) VALUES (:id,'Sale',:sale,:method,:amount,:reference,:amount,0)`,{id:id('PAY'),sale:order.saleId,method,amount,reference:method==='Cash'?null:reference});
  await conn.query(`UPDATE \`Order\` SET PaymentStatus='Paid' WHERE OrderID=:id`,{id:order.OrderID}); order.PaymentStatus='Paid'; order.paid=money(order.paid+amount);
  await audit(conn,user,order,'Payment collected');
  await archive(conn,order);
}
async function settle(conn,order,user,body) {
  if (!isManager(user)) throw new ApiError(403,'Manager authorization is required to settle prepaid orders.');
  if (!(order.PickupStatus && ['Unclaimed','Cancelled'].includes(order.PickupStatus)) && !(order.DeliveryStatus && ['Delivery Failed / Restocked','Cancelled'].includes(order.DeliveryStatus))) throw new ApiError(409,'Cancel or exhaust fulfillment before settlement.');
  const notes=requireNotes(body.reason);
  const [[policy]]=await conn.query(`SELECT AllowIssueRefund,AllowForfeitPayment FROM CompanySettings WHERE CompanyID=:company`,{company:user.companyId});
  const action=body.resolutionAction;
  if (!['Refunded','Forfeited'].includes(action) || (action==='Refunded' && policy && !policy.AllowIssueRefund) || (action==='Forfeited' && policy && !policy.AllowForfeitPayment)) throw new ApiError(400,'Choose an enabled resolution option.');
  if (body.restockConfirmed!==true) throw new ApiError(400,'Confirm that the items will return to stock.');
  const fee=Number(order.delivery?.DeliveryCharge || 0);
  const refund=action==='Refunded' ? money(Math.max(0,order.paid-(body.refundDeliveryFee===false ? fee : 0))) : 0;
  const retained=money(order.paid-refund);
  await restock(conn,order,user,`Settlement: ${notes}`);
  await conn.query(`INSERT INTO OrderSettlement(SettlementID,OrderID,UserID,Action,PaidAmount,RefundAmount,RetainedAmount,Reason) VALUES (:id,:order,:user,:action,:paid,:refund,:retained,:reason)`,{id:id('SET'),order:order.OrderID,user:user.userId,action,paid:order.paid,refund,retained,reason:notes});
  await conn.query(`UPDATE \`Order\` SET PaymentStatus=:action,ResolutionAction=:action,ResolutionReason=:reason,ArchivedAt=NOW(),OrderStatus='Cancelled' WHERE OrderID=:id`,{action,reason:notes,id:order.OrderID});
  await conn.query(`UPDATE Sales SET TotalAmount=:retained,Remarks=CONCAT(COALESCE(Remarks,''),' | ',:label) WHERE SaleID=:id`,{retained,label:action==='Forfeited' ? `Cancellation / logistics income: ${notes}` : `Refund recorded: ${refund.toFixed(2)}; ${notes}`,id:order.saleId});
  await audit(conn,user,order,`${action}: refund ${refund.toFixed(2)}, retained ${retained.toFixed(2)}. ${notes}`);
}
async function transition(orderId,user,body) {
  const action=body.action;
  if (isRider(user) && !['delivered','failed'].includes(action)) throw new ApiError(403,'Riders may only confirm delivery or log a failed attempt.');
  return transaction(async conn=>{
    const order=await lockOrder(conn,orderId,user);
    if (order.ArchivedAt) throw new ApiError(409,'This order is already archived.');
    await expire(conn,order,user);
    if (order.ArchivedAt) return {message:'Expired unpaid pickup restocked and archived.'};
    if (action==='edit') {
      if (order.OrderType!=='Delivery') throw new ApiError(400,'Only delivery details can be edited.');
      if (body.remarks!==undefined) {
        if (typeof body.remarks!=='string' || body.remarks.length>255) throw new ApiError(400,'Notes must be at most 255 characters.');
        await conn.query(`UPDATE \`Order\` SET Remarks=:remarks WHERE OrderID=:id`,{remarks:body.remarks,id:orderId});
      }
    }
    if (action==='pay') await pay(conn,order,user,body);
    else if (action==='ready') {
      if (order.PickupStatus!=='Preparing') throw new ApiError(409,'Only preparing pickups can be marked ready.');
      await conn.query(`UPDATE \`Order\` SET PickupStatus='Ready for Pickup',OrderStatus='Ready',PickupDeadline=TIMESTAMP(DATE_ADD(DATE(ScheduledPickupTime),INTERVAL 2 DAY),'18:00:00') WHERE OrderID=:id`,{id:orderId});
    } else if (action==='claim') {
      if (order.PickupStatus!=='Ready for Pickup' || order.expired) throw new ApiError(409,'Only unexpired ready pickups can be claimed.');
      if (order.PaymentStatus!=='Paid') { if (!body.collectPayment) throw new ApiError(409,'Collect payment before completing the claim.'); await pay(conn,order,user,body); }
      await require('./cylinderStock').recordReturns(conn,orderId,user,body.emptyReturns || []);
      await conn.query(`UPDATE \`Order\` SET PickupStatus='Claimed' WHERE OrderID=:id`,{id:orderId}); order.PickupStatus='Claimed'; await archive(conn,order);
    } else if (action==='assign' || action==='dispatch' || (action==='edit' && body.riderId!==undefined && (body.riderId || null)!==(order.AssignedRiderID || null))) {
      if (!['Preparing','Failed Attempt','Out for Delivery'].includes(order.DeliveryStatus)) throw new ApiError(409,'This delivery cannot be dispatched or reassigned.');
      const rider=body.riderId===undefined ? order.AssignedRiderID : body.riderId || null;
      if (rider) {
        const [[valid]]=await conn.query(`SELECT u.UserID FROM User u JOIN Role r ON r.RoleID=u.RoleID WHERE u.UserID=:id AND u.CompanyID=:company AND u.Status='Active' AND LOWER(r.RoleName) IN ('rider','driver','drivers')`,{id:rider,company:user.companyId});
        if (!valid) throw new ApiError(400,'Select an active rider from your company.');
      }
      await conn.query(`UPDATE \`Order\` SET AssignedRiderID=:rider WHERE OrderID=:id`,{rider,id:orderId});
      if (action==='dispatch') {
        if (!rider) throw new ApiError(409,'Select a rider before dispatching. The same rider can handle all three attempts.');
        if (order.DeliveryStatus==='Out for Delivery') throw new ApiError(409,'This delivery is already dispatched. Record its delivery result before starting another attempt.');
        if (order.AttemptCount>=order.MaxAttempts) throw new ApiError(409,'This delivery has reached its maximum of three attempts.');
        if (!order.retryDue) throw new ApiError(409,`The rider is selected, but this delivery cannot be dispatched until ${order.NextAttemptDate} (Asia/Manila). Retries run on weekdays at 8:00 AM; weekends are skipped. Save the rider assignment while waiting.`);
        const attempt=Number(order.AttemptCount)+1;
        await conn.query(`UPDATE \`Order\` SET DeliveryStatus='Out for Delivery',AttemptCount=:attempt,LastAttemptDate=NOW(),NextAttemptDate=NULL WHERE OrderID=:id`,{attempt,id:orderId});
        await conn.query(`INSERT INTO DeliveryAttempt(AttemptID,OrderID,AttemptNumber,RiderID) VALUES (:id,:order,:attempt,:rider)`,{id:id('AT'),order:orderId,attempt,rider});
      }
    } else if (action==='failed') {
      if (order.DeliveryStatus!=='Out for Delivery') throw new ApiError(409,'Only dispatched deliveries can fail an attempt.');
      const reasons=['Customer Unreachable','House Closed / No Recipient','Incorrect Address','Refused Acceptance','Other'];
      if (!reasons.includes(body.failureReason)) throw new ApiError(400,'Select a failure reason.');
      const notes=requireNotes(body.driverNotes);
      await conn.query(`UPDATE DeliveryAttempt SET FailedAt=NOW(),FailureReason=:reason,DriverNotes=:notes WHERE OrderID=:id AND AttemptNumber=:attempt`,{reason:body.failureReason,notes,id:orderId,attempt:order.AttemptCount});
      if (order.AttemptCount>=order.MaxAttempts) {
        const status=order.paid>0 ? 'Delivery Failed / Restocked' : 'Cancelled';
        if (!order.paid) await restock(conn,order,user,'Failed after 3 delivery attempts');
        await conn.query(`UPDATE \`Order\` SET DeliveryStatus=:status,OrderStatus=:status,CancellationRemarks='Failed after 3 delivery attempts',ArchivedAt=CASE WHEN :paid=0 THEN NOW() ELSE NULL END WHERE OrderID=:id`,{status,paid:order.paid,id:orderId});
        if (!order.paid) await conn.query(`UPDATE Sales SET TotalAmount=0 WHERE SaleID=:id`,{id:order.saleId});
      } else await conn.query(`UPDATE \`Order\` SET DeliveryStatus='Failed Attempt',NextAttemptDate=TIMESTAMP(DATE_ADD(CURDATE(),INTERVAL CASE DAYOFWEEK(CURDATE()) WHEN 6 THEN 3 WHEN 7 THEN 2 ELSE 1 END DAY),'08:00:00') WHERE OrderID=:id`,{id:orderId});
    } else if (action==='delivered') {
      if (order.DeliveryStatus!=='Out for Delivery') throw new ApiError(409,'Only dispatched deliveries can be confirmed.');
      const due=money(Number(order.TotalAmount)-order.paid);
      if (order.PaymentStatus!=='Paid') await pay(conn,order,user,body);
      await require('./cylinderStock').recordReturns(conn,orderId,user,body.emptyReturns || []);
      await conn.query(`UPDATE \`Order\` SET DeliveryStatus='Delivered',DeliveredAt=NOW(),CashCollectedAmount=:cash WHERE OrderID=:id`,{cash:due>0 && (body.paymentMethod || 'Cash')==='Cash' ? due : 0,id:orderId}); order.DeliveryStatus='Delivered'; await archive(conn,order);
    } else if (action==='cancel') {
      if (order.PickupStatus==='Claimed' || order.DeliveryStatus==='Delivered') throw new ApiError(409,'Fulfilled orders cannot be cancelled.');
      const notes=requireNotes(body.reason);
      if (!order.paid) await restock(conn,order,user,`Cancelled: ${notes}`);
      await conn.query(`UPDATE \`Order\` SET PickupStatus=CASE WHEN OrderType='Pick-up' THEN 'Cancelled' ELSE PickupStatus END,DeliveryStatus=CASE WHEN OrderType='Delivery' THEN 'Cancelled' ELSE DeliveryStatus END,OrderStatus='Cancelled',CancellationRemarks=:notes,ArchivedAt=CASE WHEN :paid=0 THEN NOW() ELSE NULL END WHERE OrderID=:id`,{notes,paid:order.paid,id:orderId});
      if (!order.paid) await conn.query(`UPDATE Sales SET TotalAmount=0 WHERE SaleID=:id`,{id:order.saleId});
    } else if (action==='settle') await settle(conn,order,user,body);
    else if (action!=='edit') throw new ApiError(400,'Unknown lifecycle action.');
    await conn.query(`UPDATE Delivery d JOIN Sales s ON s.SaleID=d.SaleID JOIN \`Order\` o ON o.OrderID=s.OrderID SET d.DeliveryStatus=o.DeliveryStatus,d.DeliveredByUserID=o.AssignedRiderID,d.DeliveryDate=o.DeliveredAt WHERE o.OrderID=:id AND o.OrderType='Delivery'`,{id:orderId});
    await audit(conn,user,order,`Order action: ${action}`);
    return {message:'Order updated.'};
  });
}
async function sweepExpired(companyId) {
  const params=companyId ? {company:companyId} : {};
  const [rows]=await pool.query(`SELECT o.OrderID,u.UserID,u.CompanyID FROM \`Order\` o JOIN Sales s ON s.OrderID=o.OrderID JOIN User u ON u.UserID=s.UserID WHERE o.ArchivedAt IS NULL AND o.PickupStatus IN ('Preparing','Ready for Pickup') AND o.PickupDeadline<NOW() ${companyId ? 'AND o.CompanyID=:company' : ''}`,params);
  const failures=[];
  for (const row of rows) { try { await transaction(async conn=>{
    const user={userId:row.UserID,companyId:row.CompanyID,roleName:'System'};
    const order=await lockOrder(conn,row.OrderID,user); await expire(conn,order,user);
  }); } catch(err) { failures.push({orderId:row.OrderID,message:err.message}); } }
  return failures;
}
module.exports={id,isRider,isManager,money,pickupTime,transaction,lockOrder,restock,transition,sweepExpired,audit};
