const crypto=require('crypto');
const ApiError=require('../utils/apiError');
const id=()=>`T-${crypto.randomBytes(8).toString('hex')}`;
// Accessories retain ordinary stock; LPG/cylinder products have separate empty stock.
const tankSql="(LOWER(p.Unit)='kg' OR LOWER(c.Category) IN ('cylinder','gasul lpg','lpg'))";
async function recordReturns(conn,orderId,user,returns=[]){
  if(!Array.isArray(returns)) throw new ApiError(400,'Empty cylinder returns must be a list of product quantities.');
  const [[order]]=await conn.query(`SELECT OrderNo,EmptyReturnsRecordedAt FROM \`Order\` WHERE OrderID=:id FOR UPDATE`,{id:orderId});
  if(order.EmptyReturnsRecordedAt) throw new ApiError(409,'Empty cylinder returns have already been recorded for this order.');
  const [allocations]=await conn.query(`SELECT a.InventoryID,a.Quantity,i.ProductID,${tankSql} AS isTank FROM OrderStockAllocation a JOIN Inventory i ON i.InventoryID=a.InventoryID LEFT JOIN Product p ON p.ProductID=i.ProductID LEFT JOIN Category c ON c.CategoryID=p.CategoryID WHERE a.OrderID=:id ORDER BY a.InventoryID FOR UPDATE`,{id:orderId});
  const requested=new Map();
  for(const item of returns){
    if(!item || typeof item!=='object') throw new ApiError(400,'Each empty return must specify a product and quantity.');
    const qty=Number(item.quantity);
    if(!item.productId || !Number.isSafeInteger(qty) || qty<0) throw new ApiError(400,'Returned cylinders must be nonnegative whole numbers.');
    requested.set(item.productId,(requested.get(item.productId)||0)+qty);
  }
  let total=0;
  for(const [product,qty] of requested){
    const allocation=allocations.find(a=>a.ProductID===product);
    if(!allocation || !allocation.isTank || qty>Number(allocation.Quantity)) throw new ApiError(400,'Return quantities must match cylinder products in this order and cannot exceed the quantity sold.');
    if(!qty)continue;
    await conn.query(`UPDATE Inventory SET EmptyStock=EmptyStock+:qty WHERE InventoryID=:id`,{qty,id:allocation.InventoryID});
    await conn.query(`INSERT INTO InventoryTransaction(TransactionID,InventoryID,UserID,TransactionType,Quantity,Reason,ReferenceNo) VALUES (:id,:inventory,:user,'Empty Return',:qty,'Cylinder Return',:ref)`,{id:id(),inventory:allocation.InventoryID,user:user.userId,qty,ref:order.OrderNo});
    total+=qty;
  }
  await conn.query(`UPDATE \`Order\` SET EmptyCylinderReturned=:returned,EmptyReturnsRecordedAt=NOW() WHERE OrderID=:id`,{returned:total>0?1:0,id:orderId});
}
module.exports={recordReturns,tankSql};
