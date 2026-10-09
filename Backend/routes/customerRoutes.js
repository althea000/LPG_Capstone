const router = require("express").Router();
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const { authenticate } = require("../middleware/auth");

async function nextId(conn, table, column, prefix, pad = 3) {
  const normalizedPrefix = String(prefix || "").toUpperCase();
  const [rows] = await conn.query(
    `SELECT ${column} AS id FROM ${table} WHERE ${column} LIKE :pattern`,
    { pattern: `${normalizedPrefix}%` }
  );

  let max = 0;
  const matcher = new RegExp(`^${normalizedPrefix}-?([0-9]+)$`);
  for (const row of rows) {
    const candidate = String(row.id || "").toUpperCase();
    const match = candidate.match(matcher);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > max) max = n;
  }

  let next = max + 1;
  while (true) {
    const candidateId = `${normalizedPrefix}-${String(next).padStart(pad, "0")}`;
    const [existsRows] = await conn.query(
      `SELECT ${column} AS id FROM ${table} WHERE ${column} = :id LIMIT 1`,
      { id: candidateId }
    );
    if (!existsRows[0]) return candidateId;
    next += 1;
  }
}

router.use(authenticate);
// GET /customers?search=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { search } = req.query;
    let sql = `
      SELECT CustomerID AS id, CustomerName AS name, CustomerType AS type, ContactNo AS phone,
             Address AS address, Status AS status, CreatedAt AS created, UpdatedAt AS updated
      FROM Customer WHERE ContactNo != 'WALKIN' AND ContactNo != 'IMPORTED'`;
    const params = {};
    if (search) {
      sql += ` AND (CustomerName LIKE :s OR ContactNo LIKE :s OR CustomerID = :sid)`;
      params.s = `%${search}%`;
      params.sid = Number(search) || 0;
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
      `SELECT CustomerID AS id, CustomerName AS name, CustomerType AS type, ContactNo AS phone,
              Address AS address, Status AS status, CreatedAt AS created, UpdatedAt AS updated
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
    const { name, customerType, phone, address, status } = req.body;
    if (!name || !phone) throw new ApiError(400, "name and phone are required.");

    const conn = await pool.getConnection();
    try {
      let createdId = null;

      for (let attempts = 0; attempts < 5; attempts += 1) {
        const customerId = await nextId(conn, "Customer", "CustomerID", "CUST");
        try {
          await conn.query(
            `INSERT INTO Customer (CustomerID, CustomerName, CustomerType, ContactNo, Address, Status)
             VALUES (:customerId, :name, :type, :phone, :address, :status)`,
            {
              customerId,
              name,
              type: customerType || "Residential",
              phone,
              address: address || "N/A",
              status: status || "Active",
            }
          );
          createdId = customerId;
          break;
        } catch (err) {
          if (err?.code !== "ER_DUP_ENTRY") throw err;
        }
      }

      if (!createdId) {
        throw new ApiError(409, "Could not generate a unique CustomerID. Please try again.");
      }

      res.status(201).json({ id: createdId });
    } finally {
      conn.release();
    }
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const { name, phone, address, status, customerType } = req.body;
    const [result] = await pool.query(
      `UPDATE Customer SET
         CustomerName = COALESCE(:name, CustomerName),
         ContactNo = COALESCE(:phone, ContactNo),
         Address = COALESCE(:address, Address),
         CustomerType = COALESCE(:type, CustomerType),
         Status = COALESCE(:status, Status)
       WHERE CustomerID = :id`,
      {
        id: req.params.id,
        name: name || null,
        phone: phone || null,
        address: address || null,
        type: customerType || null,
        status: status || null,
      }
    );
    if (!result.affectedRows) throw new ApiError(404, "Customer not found.");
    res.json({ message: "Customer updated." });
  })
);

// DELETE /customers/:id — soft delete: Customer may be referenced by Order/Sales history.
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const [result] = await pool.query(
      `UPDATE Customer SET Status = 'Inactive' WHERE CustomerID = :id`,
      { id: req.params.id }
    );
    if (!result.affectedRows) throw new ApiError(404, "Customer not found.");
    res.json({ message: "Customer deactivated." });
  })
);

module.exports = router;




