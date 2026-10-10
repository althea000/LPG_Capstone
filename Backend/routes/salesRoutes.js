const router = require("express").Router();
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const { authenticate } = require("../middleware/auth");
const { nextSequence } = require("../utils/generateNumbers");
const { parseCsv } = require("../utils/csv");

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

const DEFAULT_WAREHOUSE_ID = "WH-001"; // fallback when an explicit warehouse is provided by callers

router.use(authenticate);

async function getTaxSettings(companyId) {
  const [rows] = await pool.query(
    `SELECT TaxRate, TaxEnabled FROM CompanySettings WHERE CompanyID = :companyId`,
    { companyId }
  );
  if (!rows[0]) return { rate: 0.12, enabled: true }; // sensible default if Settings was never saved
  return { rate: Number(rows[0].TaxRate) / 100, enabled: !!rows[0].TaxEnabled };
}

// GET /sales?search=&cashier=&status=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { search, cashier, status } = req.query;
    let sql = `
      SELECT s.SaleID AS id, s.SaleNo AS saleNo, s.SaleDate AS datetime, s.UserID AS cashier,
             CONCAT(u.FirstName,' ',u.LastName) AS cashierName, s.OrderID AS orderRecordId, o.OrderNo AS orderId,
             o.OrderType AS type, o.OrderStatus AS status,
             COALESCE(c.CustomerName, ' — ') AS customerName, o.PaymentStatus AS paymentStatus, o.ResolutionAction AS resolutionAction, s.TotalAmount AS amount, s.SalesDiscount AS discount
      FROM Sales s
      JOIN User u ON u.UserID = s.UserID
      LEFT JOIN \`Order\` o ON o.OrderID = s.OrderID
      LEFT JOIN Customer c ON c.CustomerID=s.CustomerID
      WHERE (o.OrderID IS NULL OR o.ArchivedAt IS NOT NULL)`;
    const params = {};
    if (search) {
      sql += ` AND s.SaleNo LIKE :s`;
      params.s = `%${search}%`;
    }
    if (cashier) {
      sql += ` AND s.UserID = :cashier`;
      params.cashier = cashier;
    }
    if (status) {
      sql += ` AND o.OrderStatus = :status`;
      params.status = status;
    }

    // Hide demo/seeded rows from the Sales module listing.
    sql += `
      AND (s.Remarks IS NULL OR s.Remarks NOT LIKE 'Dashboard history seed %')`;

    sql += ` ORDER BY s.SaleDate DESC`;
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const [saleRows] = await pool.query(
      `SELECT s.SaleID AS id, s.SaleNo AS saleNo, s.SaleDate AS datetime, s.UserID AS cashier,
              CONCAT(u.FirstName,' ',u.LastName) AS cashierName, s.OrderID AS orderRecordId, o.OrderNo AS orderId,
              o.OrderType AS type, o.OrderStatus AS status,
              COALESCE(c.CustomerName, ' — ') AS customerName, o.PaymentStatus AS paymentStatus, o.ResolutionAction AS resolutionAction, s.TotalAmount AS amount, s.SalesDiscount AS discount, s.Remarks AS remarks,
              o.SubtotalSnapshot AS subtotal,o.VatSnapshot AS vat,o.TaxRateSnapshot AS taxRate,o.DeliveryNo AS deliveryNo,o.DeliveryInstructions AS deliveryInstructions,
              c.ContactNo AS customerPhone,c.Address AS customerAddress,
              COALESCE(pay.paymentMethod,o.PaymentMethod) AS paymentMethod,pay.referenceNo,pay.amountCollected,pay.changeDue,
              d.DeliveryCharge AS deliveryFee,d.DeliveryAddress AS deliveryAddress,CONCAT(rider.FirstName,' ',rider.LastName) AS deliveryRiderName
       FROM Sales s
       JOIN User u ON u.UserID = s.UserID
       LEFT JOIN \`Order\` o ON o.OrderID = s.OrderID
      LEFT JOIN Customer c ON c.CustomerID=s.CustomerID
      LEFT JOIN (SELECT SaleID,MAX(PaymentMethod) AS paymentMethod,MAX(ReferenceNo) AS referenceNo,SUM(COALESCE(AmountTendered,AmountPaid)) AS amountCollected,SUM(COALESCE(ChangeDue,0)) AS changeDue FROM Payment GROUP BY SaleID) pay ON pay.SaleID=s.SaleID
      LEFT JOIN Delivery d ON d.SaleID=s.SaleID LEFT JOIN User rider ON rider.UserID=o.AssignedRiderID
       WHERE s.SaleID = :id`,
      { id: req.params.id }
    );
    if (!saleRows[0]) throw new ApiError(404, "Sale not found.");
    const [items] = await pool.query(
      `SELECT od.ProductID AS productId, COALESCE(p.ProductName, od.ProductNameSnapshot, 'Deleted Product') AS name, od.Quantity AS qty,
              COALESCE(od.UnitPriceSnapshot,od.UnitPrice) AS unitPrice, COALESCE(od.UnitPriceSnapshot,od.UnitPrice) AS costPrice, od.Subtotal AS subtotal
       FROM Sales s
       JOIN OrderDetails od ON od.OrderID = s.OrderID
       LEFT JOIN Product p ON p.ProductID = od.ProductID
       WHERE s.SaleID = :id`,
      { id: req.params.id }
    );
    res.json({ ...saleRows[0], items,deliveryDetails:{address:saleRows[0].deliveryAddress,instructions:saleRows[0].deliveryInstructions,riderName:saleRows[0].deliveryRiderName} });
  })
);

// POS orders use the same transactional fulfillment writer as Orders & Delivery.
router.post("/", asyncHandler(async (req,res) => {
  res.status(201).json(await require("../services/createOrder")(req.user,req.body));
}));



// POST /sales/import — bulk-import historical sales from a CSV (unchanged from before, still uses the
// company's saved tax rate rather than a hardcoded constant)
router.post(
  "/import",
  asyncHandler(async (req, res) => {
    const { csvText, adjustInventory, fileName } = req.body;
    if (!csvText || typeof csvText !== "string") {
      throw new ApiError(400, "csvText is required.");
    }

    const rows = parseCsv(csvText);
    if (!rows.length) throw new ApiError(400, "The CSV file has no data rows.");

    const required = ["SaleRef", "ProductID", "Quantity", "UnitPrice"];
    const missingCols = required.filter((col) => !(col in rows[0]));
    if (missingCols.length) {
      throw new ApiError(400, `CSV is missing required column(s): ${missingCols.join(", ")}`);
    }

    const { rate: taxRate, enabled: taxEnabled } = await getTaxSettings(req.user.companyId);

    const groups = new Map();
    for (const row of rows) {
      const ref = row.SaleRef || "IMPORTED";
      if (!groups.has(ref)) groups.set(ref, []);
      groups.get(ref).push(row);
    }

    const conn = await pool.getConnection();
    let importedCount = 0;
    const errors = [];

    try {
      await conn.beginTransaction();

      const [existingCustomer] = await conn.query(
        `SELECT CustomerID FROM Customer WHERE ContactNo = 'IMPORTED' LIMIT 1`
      );
      let importCustomerId = existingCustomer[0]?.CustomerID;
      if (!importCustomerId) {
        importCustomerId = await nextId(conn, "Customer", "CustomerID", "CUST");
        await conn.query(
          `INSERT INTO Customer (CustomerID, CustomerType, ContactNo, Address, Status)
           VALUES (:customerId, 'Residential', 'IMPORTED', 'Imported sales', 'Active')`,
          { customerId: importCustomerId }
        );
      }

      for (const [ref, lineItems] of groups.entries()) {
        try {
          const first = lineItems[0];
          const discount = Number(first.Discount) || 0;
          const paymentMethod = first.PaymentMethod || "Cash";
          const saleDate = first.SaleDate ? new Date(first.SaleDate) : new Date();
          if (isNaN(saleDate.getTime())) throw new Error(`Invalid SaleDate for ${ref}`);

          let subtotal = 0;
          const validatedItems = [];
          for (const li of lineItems) {
            const productId = String(li.ProductID || "").trim();
            const qty = Number(li.Quantity);
            const unitPrice = Number(li.UnitPrice);
            if (!productId || !qty || qty <= 0 || isNaN(unitPrice)) {
              throw new Error(`Invalid row in group ${ref}: ${JSON.stringify(li)}`);
            }
            const [productRows] = await conn.query(`SELECT ProductID FROM Product WHERE ProductID = :pid`, {
              pid: productId,
            });
            if (!productRows[0]) throw new Error(`Product ID ${productId} does not exist (group ${ref})`);
            subtotal += qty * unitPrice;
            validatedItems.push({ productId, qty, unitPrice });
          }

          const vat = taxEnabled ? (subtotal - discount) * taxRate : 0;
          const totalAmount = subtotal - discount + vat;

          const orderNo = await nextSequence(conn, "`Order`", "OrderNo", "ORD");
          const orderId = orderNo;
          await conn.query(
            `INSERT INTO \`Order\` (OrderID, CustomerID, OrderNo, OrderDate, OrderType, OrderStatus, TotalAmount, Remarks)
             VALUES (:orderId, :customerId, :orderNo, :saleDate, 'Walk-in', 'Completed', :totalAmount, :remarks)`,
            {
              orderId,
              customerId: importCustomerId,
              orderNo,
              saleDate,
              totalAmount,
              remarks: `Imported from ${fileName || "CSV"} (ref: ${ref})`,
            }
          );

          for (const item of validatedItems) {
            const orderDetailId = await nextId(conn, "OrderDetails", "OrderDetailID", "OD");
            await conn.query(
              `INSERT INTO OrderDetails (OrderDetailID, OrderID, ProductID, Quantity, UnitPrice, Subtotal)
               VALUES (:orderDetailId, :orderId, :productId, :qty, :unitPrice, :subtotal)`,
              {
                orderDetailId,
                orderId,
                productId: item.productId,
                qty: item.qty,
                unitPrice: item.unitPrice,
                subtotal: item.qty * item.unitPrice,
              }
            );

            if (adjustInventory) {
              const [invRows] = await conn.query(
                `SELECT InventoryID, StockOnHand FROM Inventory WHERE WarehouseID = :wid AND ProductID = :pid FOR UPDATE`,
                { wid: DEFAULT_WAREHOUSE_ID, pid: item.productId }
              );
              let inv = invRows[0];
              if (!inv) {
                const inventoryId = await nextId(conn, "Inventory", "InventoryID", "INT");
                await conn.query(
                  `INSERT INTO Inventory (InventoryID, WarehouseID, ProductID, StockOnHand) VALUES (:inventoryId, :wid, :pid, 0)`,
                  { inventoryId, wid: DEFAULT_WAREHOUSE_ID, pid: item.productId }
                );
                inv = { InventoryID: inventoryId, StockOnHand: 0 };
              }
              if (inv.StockOnHand >= item.qty) {
                await conn.query(`UPDATE Inventory SET StockOnHand = StockOnHand - :qty WHERE InventoryID = :id`, {
                  qty: item.qty,
                  id: inv.InventoryID,
                });
                const transactionId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
                await conn.query(
                  `INSERT INTO InventoryTransaction (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, ReferenceNo)
                   VALUES (:transactionId, :invId, :userId, 'Stock Out', :qty, 'Sale', :ref)`,
                  { transactionId, invId: inv.InventoryID, userId: req.user.userId, qty: item.qty, ref: orderNo }
                );
              }
            }
          }

          const saleNo = await nextSequence(conn, "Sales", "SaleNo", "SALE");
          const saleId = await nextId(conn, "Sales", "SaleID", "S");
          await conn.query(
            `INSERT INTO Sales (SaleID, OrderID, CustomerID, UserID, SaleNo, SaleDate, SalesDiscount, TotalAmount, Remarks)
             VALUES (:saleId, :orderId, :customerId, :userId, :saleNo, :saleDate, :discount, :totalAmount, :remarks)`,
            {
              saleId,
              orderId,
              customerId: importCustomerId,
              userId: req.user.userId,
              saleNo,
              saleDate,
              discount,
              totalAmount,
              remarks: `Imported (ref: ${ref})`,
            }
          );

          const paymentId = await nextId(conn, "Payment", "PaymentID", "PAY");
          await conn.query(
            `INSERT INTO Payment (PaymentID, PaymentType, SaleID, PaymentMethod, AmountPaid, PaymentDate)
             VALUES (:paymentId, 'Sale', :saleId, :method, :amount, :saleDate)`,
            { paymentId, saleId, method: paymentMethod, amount: totalAmount, saleDate }
          );

          importedCount++;
        } catch (groupErr) {
          errors.push(groupErr.message);
        }
      }

      if (importedCount === 0) {
        throw new ApiError(400, `No rows could be imported. Errors: ${errors.join("; ")}`);
      }

      const dataActivityId = await nextId(conn, "DataActivityLog", "DataActivityID", "DA");
      await conn.query(
        `INSERT INTO DataActivityLog (DataActivityID, UserID, ActivityType, DataType, FileName, FileFormat, Status)
         VALUES (:dataActivityId, :userId, 'Import', 'Sales Data', :fileName, 'CSV', 'Successful')`,
        { dataActivityId, userId: req.user.userId, fileName: fileName || "sales_import.csv" }
      );

      await conn.commit();
      res.status(201).json({
        message: `Imported ${importedCount} sale(s) from ${groups.size} group(s).`,
        imported: importedCount,
        skipped: errors.length,
        errors,
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  })
);

// DELETE /sales/:id — "voids" the sale rather than hard-deleting it
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [saleRows] = await conn.query(
        `SELECT SaleID, OrderID FROM Sales WHERE SaleID = :id FOR UPDATE`,
        { id: req.params.id }
      );
      if (!saleRows[0]) throw new ApiError(404, "Sale not found.");
      const { OrderID: orderId } = saleRows[0];
      const [[fulfillment]] = await conn.query(`SELECT OrderType,ResolutionAction FROM \`Order\` WHERE OrderID=:id`,{id:orderId});
      if (fulfillment && fulfillment.OrderType !== 'Walk-in') throw new ApiError(409,'Use Orders & Delivery cancellation and settlement; fulfillment history cannot be voided.');

      const [deliveryRows] = await conn.query(
        `SELECT DeliveryID FROM Delivery WHERE SaleID = :id`,
        { id: req.params.id }
      );
      if (deliveryRows[0]) {
        throw new ApiError(
          400,
          "This sale has an active delivery record. Cancel the delivery first before voiding the sale."
        );
      }

      const [items] = await conn.query(
        `SELECT ProductID, Quantity FROM OrderDetails WHERE OrderID = :orderId`,
        { orderId }
      );

      for (const item of items) {
        const [invRows] = await conn.query(
          `SELECT InventoryID FROM Inventory WHERE ProductID = :pid ORDER BY InventoryID LIMIT 1 FOR UPDATE`,
          { pid: item.ProductID }
        );
        if (invRows[0]) {
          await conn.query(
            `UPDATE Inventory SET StockOnHand = StockOnHand + :qty WHERE InventoryID = :id`,
            { qty: item.Quantity, id: invRows[0].InventoryID }
          );
          const transactionId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
          await conn.query(
            `INSERT INTO InventoryTransaction (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, ReferenceNo, Remarks)
             VALUES (:transactionId, :invId, :userId, 'Stock In', :qty, 'Adjustment', :ref, 'Sale voided — stock restored')`,
            { transactionId, invId: invRows[0].InventoryID, userId: req.user.userId, qty: item.Quantity, ref: `VOID-SALE-${req.params.id}` }
          );
        }
      }

      await conn.query(`DELETE FROM Payment WHERE SaleID = :id`, { id: req.params.id });
      await conn.query(`DELETE FROM Sales WHERE SaleID = :id`, { id: req.params.id });
      await conn.query(`DELETE FROM OrderDetails WHERE OrderID = :orderId`, { orderId });
      await conn.query(`UPDATE \`Order\` SET OrderStatus = 'Cancelled' WHERE OrderID = :orderId`, { orderId });

      await conn.commit();
      res.json({ message: "Sale voided and stock restored." });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  })
);

module.exports = router;












