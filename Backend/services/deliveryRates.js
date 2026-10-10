const ApiError=require('../utils/apiError');
async function ensureRates(conn,companyId){
  for(const [key,name,weight,base,km,min] of [['motorcycle','Motorcycle',20,60,12,0],['cargo','L300 / Cargo Van',1000,450,40,6000],['truck','Open Truck (4W/6W)',2000,1200,60,15000]])await conn.query(`INSERT IGNORE INTO DeliveryVehicleRate(VehicleID,CompanyID,VehicleName,CapacityLabel,MaxWeightKg,BaseRate,PerKm,MinSubtotalForFree) VALUES (:id,:company,:name,:capacity,:weight,:base,:km,:min)`,{id:`${companyId}-${key}`,company:companyId,name,capacity:`Up to ${weight.toLocaleString('en-US')} kg`,weight,base,km,min});
}
async function quote(conn,companyId,vehicleId,distance,subtotal) {
  distance=Number(distance);subtotal=Number(subtotal);
  if(!vehicleId || !Number.isFinite(distance) || distance<0 || distance>1000 || !Number.isFinite(subtotal) || subtotal<0) throw new ApiError(400,'Select a vehicle and enter a valid delivery distance.');
  const [[rate]]=await conn.query(`SELECT * FROM DeliveryVehicleRate WHERE VehicleID=:id AND CompanyID=:company AND Enabled=1`,{id:vehicleId,company:companyId});
  if(!rate)throw new ApiError(400,'Selected delivery vehicle is unavailable.');
  const free=distance<=Number(rate.FreeDistanceKm) || (Number(rate.MinSubtotalForFree)>0 && subtotal>=Number(rate.MinSubtotalForFree));
  const fee=free?0:Math.round((Number(rate.BaseRate)+Math.max(0,distance-Number(rate.FreeDistanceKm))*Number(rate.PerKm))*100)/100;
  return {fee,vehicleId,vehicleName:rate.VehicleName,distance,freeDistanceKm:Number(rate.FreeDistanceKm)};
}
module.exports={quote,ensureRates};
