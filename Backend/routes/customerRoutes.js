const router = require("express").Router();
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const { transaction } = require("../services/orderLifecycle");
const { authenticate } = require("../middleware/auth");

router.use(authenticate);
// GET /customers?search=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { search } = req.query;
    let sql = `
      SELECT CustomerID AS id, COALESCE(NULLIF(CustomerName,''),CASE WHEN ContactNo='WALKIN' THEN 'Walk-in Record' ELSE 'Customer' END) AS name, CustomerType AS type, ContactNo AS phone,
             Landmark AS landmark, (SELECT COUNT(*) FROM \`Order\` o WHERE o.CustomerID=Customer.CustomerID) AS totalOrders, CASE WHEN ContactNo IN ('WALKIN','IMPORTED') OR LOWER(CustomerName) LIKE 'walk-in%' THEN NULL ELSE Address END AS address, Status AS status, CreatedAt AS created, UpdatedAt AS updated
      FROM Customer WHERE 1=1`;
    const params = {};
    if (search) {
      sql += ` AND (CustomerName LIKE :s OR ContactNo LIKE :s OR CustomerID = :sid)`;
      params.s = `%${search}%`;
      params.sid = String(search);
    }
    sql += ` ORDER BY CustomerID DESC`;
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT CustomerID AS id, COALESCE(NULLIF(CustomerName,''),CASE WHEN ContactNo='WALKIN' THEN 'Walk-in Record' ELSE 'Customer' END) AS name, CustomerType AS type, ContactNo AS phone,
              Landmark AS landmark, (SELECT COUNT(*) FROM \`Order\` o WHERE o.CustomerID=Customer.CustomerID) AS totalOrders, CASE WHEN ContactNo IN ('WALKIN','IMPORTED') OR LOWER(CustomerName) LIKE 'walk-in%' THEN NULL ELSE Address END AS address, Status AS status, CreatedAt AS created, UpdatedAt AS updated
       FROM Customer WHERE CustomerID = :id`,
      { id: req.params.id }
    );
    if (!rows[0]) throw new ApiError(404, "Customer not found.");
    res.json(rows[0]);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, customerType, phone, address, landmark, status } = req.body;
    if (!name || !phone) throw new ApiError(400, "name and phone are required.");
    if(!['Residential','Commercial'].includes(customerType || 'Residential'))throw new ApiError(400,'Customer type must be Residential or Commercial.');
    const customerId=await transaction(async conn=>{
    const customerId=await require('../utils/generateNumbers').nextSequence(conn,'Customer','CustomerID','CUST',false);
    await conn.query(
      `INSERT INTO Customer (CustomerID, CustomerName, CustomerType, ContactNo, Address, Landmark, Status)
       VALUES (:id, :name, :type, :phone, :address, :landmark, :status)`,
      {
        id:customerId, landmark:landmark || null, name,
        type: customerType || "Residential",
        phone,
        address: address || "N/A",
        status: status || "Active",
      }
    );
    return customerId;
    });
    res.status(201).json({ id: customerId });
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const { name, phone, address, landmark, status, customerType } = req.body;
    if(customerType && !['Residential','Commercial'].includes(customerType))throw new ApiError(400,'Customer type must be Residential or Commercial.');
    const [result] = await pool.query(
      `UPDATE Customer SET
         CustomerName = COALESCE(:name, CustomerName),
         ContactNo = COALESCE(:phone, ContactNo),
         Address = COALESCE(:address, Address),
         Landmark = COALESCE(:landmark, Landmark),
         CustomerType = COALESCE(:type, CustomerType),
         Status = COALESCE(:status, Status)
       WHERE CustomerID = :id`,
      {
        id: req.params.id,
        name: name || null,
        phone: phone || null,
        address: address || null, landmark:landmark ?? null,
        type: customerType || null,
        status: status || null,
      }
    );
    if (!result.affectedRows) throw new ApiError(404, "Customer not found.");
    res.json({ message: "Customer updated." });
  })
);

router.get("/:id/history", asyncHandler(async(req,res)=>{
  const [rows]=await pool.query(`SELECT OrderID AS orderId,OrderNo AS id,OrderType AS type,OrderDate AS date,OrderStatus AS status,PaymentStatus AS paymentStatus,TotalAmount AS totalAmount FROM \`Order\` WHERE CustomerID=:id AND CompanyID=:company ORDER BY OrderDate DESC`,{id:req.params.id,company:req.user.companyId});res.json(rows);
}));
// Historical Order and Sales references become NULL; payments and totals remain intact.
router.delete("/:id",asyncHandler(async(req,res)=>{
  const conn=await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result]=await conn.query(`DELETE FROM Customer WHERE CustomerID=:id`,{id:req.params.id});
    if(!result.affectedRows)throw new ApiError(404,"Customer not found.");
    await conn.query(`INSERT INTO UserActivity(UserActivityID,UserID,ActivityType,Module,RecordID,Description) VALUES (:id,:user,'Delete','Customers',:record,'Deleted customer; historical orders retained')`,{id:id('UA'),user:req.user.userId,record:req.params.id});
    await conn.commit();res.json({message:'Customer deleted.'});
  } catch(err){await conn.rollback();throw err;}finally{conn.release();}
}));
module.exports=router;
