const router=require('express').Router();
const pool=require('../config/db');
const {authenticate,authorize}=require('../middleware/auth');
const asyncHandler=require('../utils/asyncHandler');
const ApiError=require('../utils/apiError');
const {randomUUID}=require('node:crypto');
const {deliveryDistance}=require('../services/deliveryDistance');
const {quote,ensureRates}=require('../services/deliveryRates');
router.use(authenticate);
router.get('/',asyncHandler(async(req,res)=>{
  await ensureRates(pool,req.user.companyId);
  const [rows]=await pool.query(`SELECT VehicleID AS id,VehicleName AS name,CapacityLabel AS capacity,MaxWeightKg AS maxWeight,BaseRate AS baseRate,PerKm AS perKm,MinSubtotalForFree AS minSubtotal,FreeDistanceKm AS freeDistance,Enabled AS enabled FROM DeliveryVehicleRate WHERE CompanyID=:company AND Enabled>=0 ORDER BY MaxWeightKg`,{company:req.user.companyId});res.json(rows);
}));
router.post('/distance',asyncHandler(async(req,res)=>res.json(await deliveryDistance(pool,req.user.companyId,req.body.address))));
router.post('/quote',asyncHandler(async(req,res)=>res.json(await quote(pool,req.user.companyId,req.body.vehicleId,req.body.distance,req.body.subtotal))));
router.put('/:id',authorize('Admin','Manager'),asyncHandler(async(req,res)=>{
  const b=validate(req.body);
  const [r]=await pool.query(`UPDATE DeliveryVehicleRate SET VehicleName=:name,CapacityLabel=:capacity,MaxWeightKg=:maxWeight,BaseRate=:baseRate,PerKm=:perKm,MinSubtotalForFree=:minSubtotal,FreeDistanceKm=:freeDistance,Enabled=:enabled WHERE VehicleID=:id AND CompanyID=:company AND Enabled>=0`,{...b,name:b.name.trim(),capacity:b.capacity.trim(),enabled:b.enabled?1:0,id:req.params.id,company:req.user.companyId});
  if(!r.affectedRows)throw new ApiError(404,'Vehicle not found.');res.json({message:'Vehicle rates saved.'});
}));
function validate(body){
  const b=body;
  if(typeof b.name!=='string' || typeof b.capacity!=='string' || !b.name.trim() || !b.capacity.trim() || b.name.length>100 || b.capacity.length>100)throw new ApiError(400,'Vehicle name and capacity are required.');
  for(const key of ['maxWeight','baseRate','perKm','minSubtotal','freeDistance'])if(b[key]===undefined || b[key]===null || typeof b[key]==='boolean' || String(b[key]).trim()===''  || !Number.isFinite(Number(b[key])) || Number(b[key])<0)throw new ApiError(400,'Rates and thresholds must be non-negative numbers.');

  return {...b,name:b.name.trim(),capacity:b.capacity.trim(),enabled:b.enabled?1:0};
}
router.post('/',authorize('Admin','Manager'),asyncHandler(async(req,res)=>{
  const b=validate(req.body),id=randomUUID();
  await ensureRates(pool,req.user.companyId);
  await pool.query(`INSERT INTO DeliveryVehicleRate(VehicleID,CompanyID,VehicleName,CapacityLabel,MaxWeightKg,BaseRate,PerKm,MinSubtotalForFree,FreeDistanceKm,Enabled) VALUES (:id,:company,:name,:capacity,:maxWeight,:baseRate,:perKm,:minSubtotal,:freeDistance,:enabled)`,{...b,id,company:req.user.companyId});
  res.status(201).json({id,message:'Vehicle type added.'});
}));
router.delete('/:id',authorize('Admin','Manager'),asyncHandler(async(req,res)=>{
  // Keep removed rate records so historical orders remain intact and defaults do not reappear.
  const [r]=await pool.query(`UPDATE DeliveryVehicleRate SET Enabled=-1 WHERE VehicleID=:id AND CompanyID=:company AND Enabled>=0`,{id:req.params.id,company:req.user.companyId});
  if(!r.affectedRows)throw new ApiError(404,'Vehicle not found.');
  res.json({message:'Vehicle type removed.'});
}));
module.exports=router;
