const router = require("express").Router();
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const { authenticate } = require("../middleware/auth");

router.use(authenticate);

router.get("/", asyncHandler(async (req, res) => {
  const { type } = req.query;
  let sql = `SELECT * FROM Payment WHERE 1=1`;
  const params = {};
  if (type) { sql += ` AND PaymentType = :type`; params.type = type; }
  sql += ` ORDER BY PaymentDate DESC`;
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}));

router.post("/", asyncHandler(async (req, res) => {
  const { paymentType, saleId, purchaseOrderId, paymentMethod, amountPaid, referenceNo, remarks } = req.body;
  if (!paymentType || !paymentMethod || !amountPaid) {
    throw new ApiError(400, "paymentType, paymentMethod and amountPaid are required.");
  }
  if (paymentType==='Sale') {
    const [[order]]=await pool.query(`SELECT o.OrderID FROM Sales s JOIN \`Order\` o ON o.OrderID=s.OrderID WHERE s.SaleID=:id AND o.CompanyID=:company`,{id:saleId,company:req.user.companyId});
    if(!order)throw new ApiError(404,'Order not found.');
    return res.json(await require('../services/orderLifecycle').transition(order.OrderID,req.user,{action:'pay',paymentMethod,amountPaid}));
  }
  const [result] = await pool.query(
    `INSERT INTO Payment (PaymentType, SaleID, PurchaseOrderID, PaymentMethod, AmountPaid, ReferenceNo, Remarks)
     VALUES (:paymentType, :saleId, :purchaseOrderId, :paymentMethod, :amountPaid, :referenceNo, :remarks)`,
    {
      paymentType, saleId: saleId || null, purchaseOrderId: purchaseOrderId || null,
      paymentMethod, amountPaid, referenceNo: referenceNo || null, remarks: remarks || null,
    }
  );
  res.status(201).json({ id: result.insertId });
}));

module.exports = router;