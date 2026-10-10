const ApiError=require('../utils/apiError');
const {id}=require('./orderLifecycle');
async function updateProductStock(conn,productId,user,body) {
  if(body.stock===undefined)return;
  const stock=Number(body.stock);
  if(!Number.isInteger(stock) || stock<0 || !body.warehouseId)throw new ApiError(400,'A warehouse and nonnegative whole stock quantity are required.');
  const [[warehouse]]=await conn.query(`SELECT WarehouseID FROM Warehouse WHERE WarehouseID=:id AND CompanyID=:company`,{id:body.warehouseId,company:user.companyId});
  if(!warehouse)throw new ApiError(400,'Select a warehouse from your company.');
  let [[inventory]]=await conn.query(`SELECT InventoryID,StockOnHand FROM Inventory WHERE ProductID=:product AND WarehouseID=:warehouse FOR UPDATE`,{product:productId,warehouse:body.warehouseId});
  if(!inventory){inventory={InventoryID:id('INT'),StockOnHand:0};await conn.query(`INSERT INTO Inventory(InventoryID,WarehouseID,ProductID,StockOnHand) VALUES (:id,:warehouse,:product,0)`,{id:inventory.InventoryID,warehouse:body.warehouseId,product:productId});}
  if (body.expectedStock!==undefined && Number(body.expectedStock)!==Number(inventory.StockOnHand)) throw new ApiError(409,'Stock has changed since opening the form. Reopen the product and try again.');
  const difference=stock-Number(inventory.StockOnHand);
  if(!difference)return;
  await conn.query(`UPDATE Inventory SET StockOnHand=:stock WHERE InventoryID=:id`,{stock,id:inventory.InventoryID});
  await conn.query(`INSERT INTO InventoryTransaction(TransactionID,InventoryID,UserID,TransactionType,Quantity,Reason,ReferenceNo,Remarks) VALUES (:id,:inventory,:user,:type,:quantity,'Adjustment',:product,'Product form stock adjustment')`,{id:id('T'),inventory:inventory.InventoryID,user:user.userId,type:difference>0?'Stock In':'Stock Out',quantity:Math.abs(difference),product:productId});
}
module.exports=updateProductStock;
