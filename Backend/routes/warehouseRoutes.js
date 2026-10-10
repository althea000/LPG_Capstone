const router = require("express").Router();
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate } = require("../middleware/auth");

router.use(authenticate);

router.get("/", asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT w.WarehouseID AS id, w.WarehouseName AS name, w.Location AS location, w.Status AS status,
            COALESCE((SELECT SUM(i.StockOnHand) FROM Inventory i WHERE i.WarehouseID=w.WarehouseID),0) AS stock
     FROM Warehouse w WHERE w.CompanyID=:company`,{company:req.user.companyId}
  );
  res.json(rows);
}));

module.exports = router;
