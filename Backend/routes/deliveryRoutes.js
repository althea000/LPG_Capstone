const router=require('express').Router();
const pool=require('../config/db');
const {authenticate}=require('../middleware/auth');
const asyncHandler=require('../utils/asyncHandler');
const ApiError=require('../utils/apiError');
const lifecycle=require('../services/orderLifecycle');
router.use(authenticate);
// Keep the legacy route compatible while sharing the scoped queue and state machine.
router.get('/',(req,res)=>res.redirect(307,'/orders/deliveries'));
router.post('/',(req,res,next)=>next(new ApiError(400,'Create delivery orders through POS or POST /orders.')));
router.put('/:id',asyncHandler(async(req,res)=>{
  const [[order]]=await pool.query(`SELECT o.OrderID FROM \`Order\` o JOIN Sales s ON s.OrderID=o.OrderID JOIN Delivery d ON d.SaleID=s.SaleID WHERE d.DeliveryID=:id AND o.CompanyID=:company`,{id:req.params.id,company:req.user.companyId});
  if(!order)throw new ApiError(404,'Delivery not found.');
  const action={'Out for Delivery':'dispatch',Delivered:'delivered','Failed Attempt':'failed'}[req.body.deliveryStatus] || 'assign';
  res.json(await lifecycle.transition(order.OrderID,req.user,{...req.body,action,riderId:req.body.deliveredByUserId}));
}));
module.exports=router;
