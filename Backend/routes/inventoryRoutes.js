const router = require("express").Router();
const crypto = require("crypto");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const { authenticate } = require("../middleware/auth");
const { parseCsv } = require("../utils/csv");
const {tankSql}=require('../services/cylinderStock');
const {transaction,id,isManager}=require('../services/orderLifecycle');

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

function normalizeReferenceNo(referenceNo) {
  const normalized = String(referenceNo || "").trim();
  if (!normalized) {
    throw new ApiError(400, "referenceNo is required.");
  }
  if (normalized.length > 50) {
    throw new ApiError(400, "referenceNo must not exceed 50 characters.");
  }
  return normalized;
}

function normalizeRemarks(remarks) {
  const normalized = String(remarks || "").trim();
  return normalized || null;
}

function normalizeReason(reason, fallbackReason) {
  const normalized = String(reason || fallbackReason || "").trim();
  if (!normalized) {
    throw new ApiError(400, "reason is required.");
  }
  if (normalized.length > 30) {
    throw new ApiError(400, "reason must not exceed 30 characters.");
  }
  return normalized;
}

function normalizeMovementItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "At least one item is required.");
  }

  const quantityByProduct = new Map();
  for (const rawItem of items) {
    const productId = String(rawItem?.productId || "").trim();
    const quantity = Number(rawItem?.quantity);

    if (!productId || !Number.isInteger(quantity) || quantity <= 0) {
      throw new ApiError(400, "Each item requires a valid productId and a positive whole-number quantity.");
    }

    quantityByProduct.set(productId, (quantityByProduct.get(productId) || 0) + quantity);
  }

  return Array.from(quantityByProduct.entries()).map(([productId, quantity]) => ({
    productId,
    quantity,
  }));
}

async function validateWarehouseAccess(conn, warehouseId, companyId) {
  const [rows] = await conn.query(
    `SELECT WarehouseID AS warehouseId
     FROM Warehouse
     WHERE WarehouseID = :warehouseId AND CompanyID = :companyId
     LIMIT 1`,
    { warehouseId, companyId }
  );
  if (!rows[0]) {
    throw new ApiError(400, "Invalid warehouse selection.");
  }
}

async function validateProductsExist(conn, productIds) {
  for (const productId of productIds) {
    const [rows] = await conn.query(
      `SELECT ProductID AS productId FROM Product WHERE ProductID = :productId LIMIT 1`,
      { productId }
    );
    if (!rows[0]) {
      throw new ApiError(400, `Invalid productId: ${productId}.`);
    }
  }
}

async function acquireReferenceLock(conn, lockKey) {
  const [[row]] = await conn.query(`SELECT GET_LOCK(:lockKey, 5) AS acquired`, { lockKey });
  if (Number(row?.acquired) !== 1) {
    throw new ApiError(409, "Another request with the same reference is already being processed. Please retry.");
  }
}

async function releaseReferenceLock(conn, lockKey) {
  try {
    await conn.query(`SELECT RELEASE_LOCK(:lockKey)`, { lockKey });
  } catch {
    // no-op
  }
}

function buildReferenceLockKey(transactionType, warehouseId, referenceNo) {
  const digest = crypto
    .createHash("sha1")
    .update(`${transactionType}|${warehouseId}|${referenceNo}`)
    .digest("hex");
  return `inventory:${digest}`;
}

async function ensureReferenceNotAlreadyUsed(conn, { warehouseId, referenceNo, transactionType }) {
  const [rows] = await conn.query(
    `SELECT t.TransactionID AS transactionId
     FROM InventoryTransaction t
     JOIN Inventory i ON i.InventoryID = t.InventoryID
     WHERE i.WarehouseID = :warehouseId
       AND t.TransactionType = :transactionType
       AND t.ReferenceNo = :referenceNo
       AND t.Reason <> 'Transfer'
     LIMIT 1`,
    { warehouseId, referenceNo, transactionType }
  );

  if (rows[0]) {
    throw new ApiError(
      409,
      `${transactionType} with referenceNo "${referenceNo}" already exists for this warehouse.`
    );
  }
}

router.post('/:id/cylinders',asyncHandler(async(req,res)=>{
  if(!isManager(req.user)) throw new ApiError(403,'A manager or supervisor must record cylinder stock changes.');
  const {action,quantity,remarks}=req.body;
  const qty=Number(quantity);
  if(!['refill','set-empty'].includes(action) || !Number.isSafeInteger(qty) || qty<0 || (action==='refill' && qty===0)) throw new ApiError(400,'Enter a valid whole-number cylinder quantity.');
  const notes=String(remarks || '').trim();
  if(notes.length>255) throw new ApiError(400,'Remarks must be at most 255 characters.');
  if(action==='set-empty' && !notes) throw new ApiError(400,'Enter remarks for the empty stock adjustment.');
  await transaction(async conn=>{
    const [[stock]]=await conn.query(`SELECT i.*,${tankSql} AS isTank FROM Inventory i JOIN Warehouse w ON w.WarehouseID=i.WarehouseID JOIN Product p ON p.ProductID=i.ProductID JOIN Category c ON c.CategoryID=p.CategoryID WHERE i.InventoryID=:id AND w.CompanyID=:company FOR UPDATE`,{id:req.params.id,company:req.user.companyId});
    if(!stock) throw new ApiError(404,'Inventory record not found.');
    if(!stock.isTank) throw new ApiError(400,'This product does not track cylinders.');
    if(req.body.expectedEmptyStock===undefined || Number(req.body.expectedEmptyStock)!==Number(stock.EmptyStock)) throw new ApiError(409,'Empty stock has changed. Reload inventory and try again.');
    if(action==='refill' && qty>Number(stock.EmptyStock)) throw new ApiError(409,'There are not enough empty tanks to refill.');
    const difference=action==='refill' ? -qty : qty-Number(stock.EmptyStock);
    if(!difference)return;
    await conn.query(`UPDATE Inventory SET EmptyStock=EmptyStock+:difference,StockOnHand=StockOnHand+:filled WHERE InventoryID=:id`,{difference,filled:action==='refill'?qty:0,id:stock.InventoryID});
    await conn.query(`INSERT INTO InventoryTransaction(TransactionID,InventoryID,UserID,TransactionType,Quantity,Reason,Remarks) VALUES (:id,:inventory,:user,:type,:qty,:reason,:notes)`,{id:id('T'),inventory:stock.InventoryID,user:req.user.userId,type:action==='refill'?'Refill':difference>0?'Empty Stock In':'Empty Stock Out',qty:Math.abs(difference),reason:action==='refill'?'Refill':'Adjustment',notes});
  });
  res.json({message:action==='refill'?'Empty tanks refilled and added to filled stock.':'Empty stock updated.'});
}));

function statusFor(stockOnHand, reorderLevel) {
  const currentStock = Number(stockOnHand || 0);
  const threshold = Number(reorderLevel || 0);

  if (currentStock === 0) return "Out of Stock";
  if (currentStock <= threshold) return "Critical";
  if (currentStock <= threshold * 1.5) return "Low Stock";
  return "Normal";
}

const CORE_WAREHOUSE_NAMES = ["Pasig Warehouse", "San Juan Warehouse"];

async function ensureCoreWarehousesContainAllProducts(conn, companyId) {
  if (!companyId) return;

  const [warehouses] = await conn.query(
    `SELECT WarehouseID AS warehouseId, WarehouseName AS warehouseName
     FROM Warehouse
     WHERE CompanyID = :companyId AND WarehouseName IN (:nameA, :nameB)`,
    { companyId, nameA: CORE_WAREHOUSE_NAMES[0], nameB: CORE_WAREHOUSE_NAMES[1] }
  );
  if (warehouses.length === 0) return;

  const [products] = await conn.query(
    `SELECT ProductID AS productId
     FROM Product
     WHERE Status = 'Active'`
  );
  if (products.length === 0) return;

  const [existingRows] = await conn.query(
    `SELECT WarehouseID AS warehouseId, ProductID AS productId
     FROM Inventory
     WHERE WarehouseID IN (:wid1, :wid2)`,
    {
      wid1: warehouses[0]?.warehouseId || "",
      wid2: warehouses[1]?.warehouseId || warehouses[0]?.warehouseId || "",
    }
  );
  const existingKeys = new Set(existingRows.map((row) => `${row.warehouseId}|${row.productId}`));

  for (const warehouse of warehouses) {
    for (const product of products) {
      const key = `${warehouse.warehouseId}|${product.productId}`;
      if (existingKeys.has(key)) continue;

      const inventoryId = await nextId(conn, "Inventory", "InventoryID", "INT");
      try {
        await conn.query(
          `INSERT INTO Inventory (InventoryID, WarehouseID, ProductID, StockOnHand)
           VALUES (:inventoryId, :warehouseId, :productId, 0)`,
          { inventoryId, warehouseId: warehouse.warehouseId, productId: product.productId }
        );
        existingKeys.add(key);
      } catch (err) {
        if (err && err.code !== "ER_DUP_ENTRY") throw err;
      }
    }
  }
}

// GET /inventory  -> powers Inventory.jsx "Inventory" tab
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { warehouseId, status, search } = req.query;

    const conn = await pool.getConnection();
    try {
      await ensureCoreWarehousesContainAllProducts(conn, req.user.companyId);
    } finally {
      conn.release();
    }
    let sql = `
      SELECT i.InventoryID AS inventoryId, i.ProductID AS productId, p.ProductName AS productName,
             i.WarehouseID AS warehouseId, w.WarehouseName AS warehouse,
             i.StockOnHand AS currentStock, i.EmptyStock AS emptyStock, ${tankSql} AS isTank, p.ReorderLevel AS reorderLimit, i.LastUpdated AS lastUpdated
      FROM Inventory i
      JOIN Product p ON p.ProductID = i.ProductID
      JOIN Category c ON c.CategoryID = p.CategoryID
      JOIN Warehouse w ON w.WarehouseID = i.WarehouseID
      WHERE w.CompanyID=:company`;
    const params = {company:req.user.companyId};
    if (warehouseId) {
      sql += ` AND i.WarehouseID = :warehouseId`;
      params.warehouseId = warehouseId;
    }
    if (search) {
      sql += ` AND (p.ProductName LIKE :search OR p.ProductID = :searchId)`;
      params.search = `%${search}%`;
      params.searchId = String(search).trim();
    }
    const [rows] = await pool.query(sql, params);
    let mapped = rows.map((r) => ({ ...r, status: statusFor(r.currentStock, r.reorderLimit) }));
    if (status) mapped = mapped.filter((r) => r.status === status);
    res.json(mapped);
  })
);

// GET /inventory/transactions -> powers Inventory.jsx "Inventory Transactions" tab
router.get(
  "/transactions",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(`
      SELECT t.TransactionID AS transactionId, p.ProductID AS productId, COALESCE(p.ProductName, t.ProductNameSnapshot, 'Deleted Product') AS productName,
             w.WarehouseName AS warehouse, t.TransactionType AS type, t.Quantity AS quantity,
             t.Reason AS reason, t.ReferenceNo AS reference, t.TransactionDate AS date,
             CONCAT(u.FirstName, ' ', u.LastName) AS user
      FROM InventoryTransaction t
      JOIN Inventory i ON i.InventoryID = t.InventoryID
      LEFT JOIN Product p ON p.ProductID = i.ProductID
      JOIN Warehouse w ON w.WarehouseID = i.WarehouseID
      JOIN User u ON u.UserID = t.UserID
      WHERE w.CompanyID=:company
      ORDER BY t.TransactionDate DESC
      LIMIT 200
    `,{company:req.user.companyId});
    res.json(rows);
  })
);

async function getOrCreateInventory(conn, warehouseId, productId) {
  const [rows] = await conn.query(
    `SELECT InventoryID, StockOnHand, EmptyStock FROM Inventory WHERE WarehouseID = :warehouseId AND ProductID = :productId FOR UPDATE`,
    { warehouseId, productId }
  );
  if (rows[0]) return rows[0];
  const inventoryId = await nextId(conn, "Inventory", "InventoryID", "INT");
  await conn.query(
    `INSERT INTO Inventory (InventoryID, WarehouseID, ProductID, StockOnHand)
     VALUES (:inventoryId, :warehouseId, :productId, 0)`,
    { inventoryId, warehouseId, productId }
  );
  return { InventoryID: inventoryId, StockOnHand: 0, EmptyStock: 0 };
}

function stockColumn(stockType='filled') {
  if(!['filled','empty'].includes(stockType)) throw new ApiError(400,'Select filled or empty stock.');
  return stockType==='empty'?'EmptyStock':'StockOnHand';
}
async function validateStockItem(conn,user,warehouseId,item,column){
  if(!item.productId || !Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity)<=0) throw new ApiError(400,'Stock quantities must be positive whole numbers.');
  const [[valid]]=await conn.query(`SELECT ${tankSql} AS isTank FROM Warehouse w JOIN Product p ON p.ProductID=:product JOIN Category c ON c.CategoryID=p.CategoryID WHERE w.WarehouseID=:warehouse AND w.CompanyID=:company`,{product:item.productId,warehouse:warehouseId,company:user.companyId});
  if(!valid) throw new ApiError(400,'Select a valid product and a warehouse from your company.');
  if(column==='EmptyStock' && !valid.isTank) throw new ApiError(400,'Empty stock is only available for cylinder products.');
}

// POST /inventory/stock-in  { warehouseId, referenceNo, items:[{productId, quantity}] }
router.post(
  "/stock-in",
  asyncHandler(async (req, res) => {
    const column=stockColumn(req.body.stockType);
    const { warehouseId, referenceNo, reason, remarks, items } = req.body;
    if (!warehouseId || !Array.isArray(items) || !items.length) {
      throw new ApiError(400, "warehouseId and at least one item are required.");
    }

    const normalizedReferenceNo = normalizeReferenceNo(referenceNo);
    const normalizedReason = normalizeReason(reason, "Purchase");
    const normalizedRemarks = normalizeRemarks(remarks);
    const normalizedItems = normalizeMovementItems(items);

    const conn = await pool.getConnection();
    const lockKey = buildReferenceLockKey("stock-in", warehouseId, normalizedReferenceNo.toUpperCase());
    let txStarted = false;
    try {
      await acquireReferenceLock(conn, lockKey);
      await conn.beginTransaction();
      txStarted = true;

      await validateWarehouseAccess(conn, warehouseId, req.user.companyId);
      await validateProductsExist(
        conn,
        normalizedItems.map((item) => item.productId)
      );
      await ensureReferenceNotAlreadyUsed(conn, {
        warehouseId,
        referenceNo: normalizedReferenceNo,
        transactionType: column === 'EmptyStock' ? 'Empty Stock In' : 'Stock In',
      });

      for (const item of normalizedItems) {
        await validateStockItem(conn,req.user,warehouseId,item,column);
        const transactionId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
        const inv = await getOrCreateInventory(conn, warehouseId, item.productId);
        await conn.query(`UPDATE Inventory SET ${column} = ${column} + :qty WHERE InventoryID = :id`, {
          qty: item.quantity,
          id: inv.InventoryID,
        });
        await conn.query(
          `INSERT INTO InventoryTransaction (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, ReferenceNo, Remarks)
           VALUES (:transactionId, :invId, :userId, :type, :qty, :reason, :ref, :remarks)`,
          {
            transactionId,
            type:column==='EmptyStock'?'Empty Stock In':'Stock In',
            invId: inv.InventoryID,
            userId: req.user.userId,
            qty: item.quantity,
            reason: normalizedReason,
            ref: normalizedReferenceNo,
            remarks: normalizedRemarks,
          }
        );
      }
      await conn.commit();
      res.status(201).json({ message: "Stock in recorded." });
    } catch (err) {
      if (txStarted) {
        await conn.rollback();
      }
      throw err;
    } finally {
      await releaseReferenceLock(conn, lockKey);
      conn.release();
    }
  })
);

// POST /inventory/stock-out { warehouseId, referenceNo, reason, items:[{productId, quantity}] }
router.post(
  "/stock-out",
  asyncHandler(async (req, res) => {
    const column=stockColumn(req.body.stockType);
    const { warehouseId, referenceNo, reason, remarks, items } = req.body;
    if (!warehouseId || !Array.isArray(items) || !items.length) {
      throw new ApiError(400, "warehouseId and at least one item are required.");
    }

    const normalizedReferenceNo = normalizeReferenceNo(referenceNo);
    const normalizedReason = normalizeReason(reason, "Damaged");
    const normalizedRemarks = normalizeRemarks(remarks);
    const normalizedItems = normalizeMovementItems(items);

    const conn = await pool.getConnection();
    const lockKey = buildReferenceLockKey("stock-out", warehouseId, normalizedReferenceNo.toUpperCase());
    let txStarted = false;
    try {
      await acquireReferenceLock(conn, lockKey);
      await conn.beginTransaction();
      txStarted = true;

      await validateWarehouseAccess(conn, warehouseId, req.user.companyId);
      await validateProductsExist(
        conn,
        normalizedItems.map((item) => item.productId)
      );
      await ensureReferenceNotAlreadyUsed(conn, {
        warehouseId,
        referenceNo: normalizedReferenceNo,
        transactionType: column === 'EmptyStock' ? 'Empty Stock Out' : 'Stock Out',
      });

      for (const item of normalizedItems) {
        await validateStockItem(conn,req.user,warehouseId,item,column);
        const transactionId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
        const inv = await getOrCreateInventory(conn, warehouseId, item.productId);
        if (Number(inv[column]) < Number(item.quantity)) {
          throw new ApiError(400, `Insufficient stock for product ${item.productId}.`);
        }
        await conn.query(`UPDATE Inventory SET ${column} = ${column} - :qty WHERE InventoryID = :id`, {
          qty: item.quantity,
          id: inv.InventoryID,
        });
        await conn.query(
          `INSERT INTO InventoryTransaction (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, ReferenceNo, Remarks)
           VALUES (:transactionId, :invId, :userId, :type, :qty, :reason, :ref, :remarks)`,
          {
            transactionId,
            type:column==='EmptyStock'?'Empty Stock Out':'Stock Out',
            invId: inv.InventoryID,
            userId: req.user.userId,
            qty: item.quantity,
            reason: normalizedReason,
            ref: normalizedReferenceNo,
            remarks: normalizedRemarks,
          }
        );
      }
      await conn.commit();
      res.status(201).json({ message: "Stock out recorded." });
    } catch (err) {
      if (txStarted) {
        await conn.rollback();
      }
      throw err;
    } finally {
      await releaseReferenceLock(conn, lockKey);
      conn.release();
    }
  })
);

// POST /inventory/transfer
router.post(
  "/transfer",
  asyncHandler(async (req, res) => {
    const { fromWarehouseId, toWarehouseId, status, remarks, items } = req.body;
    const stockType=req.body.stockType || "filled";
    const column=stockColumn(stockType);

    if (!fromWarehouseId || !toWarehouseId) {
      throw new ApiError(400, "fromWarehouseId and toWarehouseId are required.");
    }
    if (fromWarehouseId === toWarehouseId) {
      throw new ApiError(400, "Source and destination warehouses must be different.");
    }
    if (!Array.isArray(items) || !items.length) {
      throw new ApiError(400, "At least one transfer item is required.");
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [warehouseRows] = await conn.query(
        `SELECT WarehouseID AS warehouseId, WarehouseName AS warehouseName
         FROM Warehouse
         WHERE CompanyID = :companyId AND WarehouseID IN (:fromWarehouseId, :toWarehouseId)`,
        { companyId: req.user.companyId, fromWarehouseId, toWarehouseId }
      );
      if (warehouseRows.length !== 2) {
        throw new ApiError(400, "Invalid warehouse selection.");
      }

      const fromWarehouse = warehouseRows.find((w) => w.warehouseId === fromWarehouseId);
      const toWarehouse = warehouseRows.find((w) => w.warehouseId === toWarehouseId);

      const transferId = await nextId(conn, "Transfer", "TransferID", "TF");
      await conn.query(
        `INSERT INTO Transfer (TransferID, FromWarehouseID, ToWarehouseID, UserID, Status, Remarks, StockType)
         VALUES (:transferId, :fromWarehouseId, :toWarehouseId, :userId, :status, :remarks, :stockType)`,
        {
          transferId,
          stockType,
          fromWarehouseId,
          toWarehouseId,
          userId: req.user.userId,
          status: status || "Completed",
          remarks: remarks || null,
        }
      );

      for (const rawItem of items) {
        const productId = String(rawItem.productId || "").trim();
        const quantity = Number(rawItem.quantity);

        if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
          throw new ApiError(400, "Each transfer item requires a valid productId and quantity.");
        }

        await validateStockItem(conn,req.user,fromWarehouseId,{productId,quantity},column);
        const fromInv = await getOrCreateInventory(conn, fromWarehouseId, productId);
        if (Number(fromInv[column]) < quantity) {
          throw new ApiError(400, `Insufficient stock for product ${productId} in source warehouse.`);
        }

        const toInv = await getOrCreateInventory(conn, toWarehouseId, productId);

        await conn.query(
          `UPDATE Inventory SET ${column} = ${column} - :qty WHERE InventoryID = :inventoryId`,
          { qty: quantity, inventoryId: fromInv.InventoryID }
        );
        await conn.query(
          `UPDATE Inventory SET ${column} = ${column} + :qty WHERE InventoryID = :inventoryId`,
          { qty: quantity, inventoryId: toInv.InventoryID }
        );

        const transferDetailId = await nextId(conn, "TransferDetail", "TransferDetailID", "TD");
        await conn.query(
          `INSERT INTO TransferDetail (TransferDetailID, TransferID, ProductID, Quantity)
           VALUES (:transferDetailId, :transferId, :productId, :quantity)`,
          { transferDetailId, transferId, productId, quantity }
        );

        const outTxId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
        await conn.query(
          `INSERT INTO InventoryTransaction (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, ReferenceNo, Remarks)
           VALUES (:transactionId, :inventoryId, :userId, :type, :quantity, 'Transfer', :referenceNo, :remarks)`,
          {
            transactionId: outTxId,
            type:stockType==="empty"?"Empty Stock Out":"Stock Out",
            inventoryId: fromInv.InventoryID,
            userId: req.user.userId,
            quantity,
            referenceNo: transferId,
            remarks: `Transfer to ${toWarehouse?.warehouseName || toWarehouseId}`,
          }
        );

        const inTxId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
        await conn.query(
          `INSERT INTO InventoryTransaction (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, ReferenceNo, Remarks)
           VALUES (:transactionId, :inventoryId, :userId, :type, :quantity, 'Transfer', :referenceNo, :remarks)`,
          {
            transactionId: inTxId,
            type:stockType==="empty"?"Empty Stock In":"Stock In",
            inventoryId: toInv.InventoryID,
            userId: req.user.userId,
            quantity,
            referenceNo: transferId,
            remarks: `Transfer from ${fromWarehouse?.warehouseName || fromWarehouseId}`,
          }
        );
      }

      await conn.commit();
      res.status(201).json({ message: "Stock transfer recorded.", transferId });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  })
);

// GET /inventory/transfers
router.get(
  "/transfers",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT t.TransferID AS transferId,t.StockType AS stockType,
              t.FromWarehouseID AS fromWarehouseId,
              fw.WarehouseName AS fromWarehouse,
              t.ToWarehouseID AS toWarehouseId,
              tw.WarehouseName AS toWarehouse,
              t.UserID AS userId,
              CONCAT(u.FirstName, ' ', u.LastName) AS user,
              t.TransferDate AS transferDate,
              t.Status AS status,
              t.Remarks AS remarks,
              td.TransferDetailID AS transferDetailId,
              td.ProductID AS productId,
              COALESCE(p.ProductName, td.ProductNameSnapshot, 'Deleted Product') AS productName,
              td.Quantity AS quantity
       FROM Transfer t
       JOIN Warehouse fw ON fw.WarehouseID = t.FromWarehouseID
       JOIN Warehouse tw ON tw.WarehouseID = t.ToWarehouseID
       JOIN User u ON u.UserID = t.UserID
       JOIN TransferDetail td ON td.TransferID = t.TransferID
       LEFT JOIN Product p ON p.ProductID = td.ProductID
       WHERE fw.CompanyID = :companyId OR tw.CompanyID = :companyId
       ORDER BY t.TransferDate DESC, td.TransferDetailID ASC`,
      { companyId: req.user.companyId }
    );

    const grouped = [];
    const map = new Map();

    for (const row of rows) {
      if (!map.has(row.transferId)) {
        const transfer = {
          transferId: row.transferId,
          fromWarehouseId: row.fromWarehouseId,
          fromWarehouse: row.fromWarehouse,
          toWarehouseId: row.toWarehouseId,
          toWarehouse: row.toWarehouse,
          userId: row.userId,
          user: row.user,
          transferDate: row.transferDate,
          status: row.status,
          stockType: row.stockType,
          remarks: row.remarks,
          items: [],
        };
        map.set(row.transferId, transfer);
        grouped.push(transfer);
      }

      map.get(row.transferId).items.push({
        transferDetailId: row.transferDetailId,
        productId: row.productId,
        productName: row.productName,
        quantity: Number(row.quantity),
      });
    }

    res.json(grouped);
  })
);
// POST /inventory/adjust { warehouseId, items:[{productId, newQuantity}] }
router.post(
  "/adjust",
  asyncHandler(async (req, res) => {
    const { warehouseId, remarks, items } = req.body;
    if (!warehouseId || !Array.isArray(items) || !items.length) {
      throw new ApiError(400, "warehouseId and at least one item are required.");
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const item of items) {
        const transactionId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
        const inv = await getOrCreateInventory(conn, warehouseId, item.productId);
        const diff = item.newQuantity - inv.StockOnHand;
        if (diff === 0) continue;
        await conn.query(`UPDATE Inventory SET StockOnHand = :qty WHERE InventoryID = :id`, {
          qty: item.newQuantity,
          id: inv.InventoryID,
        });
        await conn.query(
          `INSERT INTO InventoryTransaction (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, Remarks)
           VALUES (:transactionId, :invId, :userId, :type, :qty, 'Adjustment', :remarks)`,
          {
            transactionId,
            invId: inv.InventoryID,
            userId: req.user.userId,
            type: diff > 0 ? "Stock In" : "Stock Out",
            qty: Math.abs(diff),
            remarks: remarks || null,
          }
        );
      }
      await conn.commit();
      res.json({ message: "Stock adjustment recorded." });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  })
);

// POST /inventory/import — bulk import inventory levels from a CSV.
// Expected columns: ProductID,WarehouseID,Quantity,Mode ("Set" or "Add")
router.post(
  "/import",
  asyncHandler(async (req, res) => {
    const { csvText, fileName } = req.body;
    if (!csvText || typeof csvText !== "string") {
      throw new ApiError(400, "csvText is required.");
    }

    const rows = parseCsv(csvText);
    if (!rows.length) throw new ApiError(400, "The CSV file has no data rows.");

    const required = ["ProductID", "WarehouseID", "Quantity"];
    const missingCols = required.filter((col) => !(col in rows[0]));
    if (missingCols.length) {
      throw new ApiError(400, `CSV is missing required column(s): ${missingCols.join(", ")}`);
    }

    const conn = await pool.getConnection();
    let importedCount = 0;
    const errors = [];

    try {
      await conn.beginTransaction();

      for (const [index, row] of rows.entries()) {
        const rowNum = index + 2;
        try {
          const productId = String(row.ProductID || "").trim();
          const warehouseId = String(row.WarehouseID || "").trim();
          const quantity = Number(row.Quantity);
          const mode = (row.Mode || "Set").trim().toLowerCase();

          if (!productId) {
            throw new Error(`Row ${rowNum}: invalid ProductID "${row.ProductID}"`);
          }
          if (!warehouseId) {
            throw new Error(`Row ${rowNum}: invalid WarehouseID "${row.WarehouseID}"`);
          }
          if (isNaN(quantity) || quantity < 0) {
            throw new Error(`Row ${rowNum}: invalid Quantity "${row.Quantity}"`);
          }
          if (mode !== "set" && mode !== "add") {
            throw new Error(`Row ${rowNum}: Mode must be "Set" or "Add", got "${row.Mode}"`);
          }

          const [productRows] = await conn.query(`SELECT ProductID FROM Product WHERE ProductID = :pid`, {
            pid: productId,
          });
          if (!productRows[0]) throw new Error(`Row ${rowNum}: Product ID ${productId} does not exist`);

          const [warehouseRows] = await conn.query(`SELECT WarehouseID FROM Warehouse WHERE WarehouseID = :wid`, {
            wid: warehouseId,
          });
          if (!warehouseRows[0]) throw new Error(`Row ${rowNum}: Warehouse ID ${warehouseId} does not exist`);

          const inv = await getOrCreateInventory(conn, warehouseId, productId);
          const newQuantity = mode === "add" ? inv.StockOnHand + quantity : quantity;
          const diff = newQuantity - inv.StockOnHand;

          if (diff !== 0) {
            const transactionId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
            await conn.query(`UPDATE Inventory SET StockOnHand = :qty WHERE InventoryID = :id`, {
              qty: newQuantity,
              id: inv.InventoryID,
            });
            await conn.query(
              `INSERT INTO InventoryTransaction (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, ReferenceNo, Remarks)
               VALUES (:transactionId, :invId, :userId, :type, :qty, 'Adjustment', :ref, 'Imported from CSV')`,
              {
                transactionId,
                invId: inv.InventoryID,
                userId: req.user.userId,
                type: diff > 0 ? "Stock In" : "Stock Out",
                qty: Math.abs(diff),
                ref: fileName || "inventory_import.csv",
              }
            );
          }

          importedCount++;
        } catch (rowErr) {
          errors.push(rowErr.message);
        }
      }

      if (importedCount === 0) {
        throw new ApiError(400, `No rows could be imported. Errors: ${errors.join("; ")}`);
      }

      const dataActivityId = await nextId(conn, "DataActivityLog", "DataActivityID", "DA");
      await conn.query(
        `INSERT INTO DataActivityLog (DataActivityID, UserID, ActivityType, DataType, FileName, FileFormat, Status)
         VALUES (:dataActivityId, :userId, 'Import', 'Inventory Data', :fileName, 'CSV', 'Successful')`,
        { dataActivityId, userId: req.user.userId, fileName: fileName || "inventory_import.csv" }
      );

      await conn.commit();
      res.status(201).json({
        message: `Imported ${importedCount} row(s).`,
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

// -------------------------------------------------------------------------
// Single-record endpoints — power the View / Edit / Delete row icons
// -------------------------------------------------------------------------

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT i.InventoryID AS inventoryId, i.ProductID AS productId, p.ProductName AS productName,
              i.WarehouseID AS warehouseId, w.WarehouseName AS warehouse,
              i.StockOnHand AS currentStock, i.EmptyStock AS emptyStock, ${tankSql} AS isTank, p.ReorderLevel AS reorderLimit,
              p.UnitPrice AS unitPrice, p.CostPrice AS costPrice, i.LastUpdated AS lastUpdated
       FROM Inventory i
       JOIN Product p ON p.ProductID = i.ProductID
       JOIN Category c ON c.CategoryID = p.CategoryID
       JOIN Warehouse w ON w.WarehouseID = i.WarehouseID
       WHERE i.InventoryID = :id AND w.CompanyID=:company`,
      { id: req.params.id,company:req.user.companyId }
    );
    if (!rows[0]) throw new ApiError(404, "Inventory record not found.");
    res.json({ ...rows[0], status: statusFor(rows[0].currentStock, rows[0].reorderLimit) });
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const { newQuantity, remarks } = req.body;
    if (newQuantity == null || newQuantity < 0) {
      throw new ApiError(400, "newQuantity must be a non-negative number.");
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        `SELECT StockOnHand FROM Inventory WHERE InventoryID = :id FOR UPDATE`,
        { id: req.params.id }
      );
      if (!rows[0]) throw new ApiError(404, "Inventory record not found.");

      const diff = Number(newQuantity) - rows[0].StockOnHand;
      if (diff !== 0) {
        const transactionId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
        await conn.query(`UPDATE Inventory SET StockOnHand = :qty WHERE InventoryID = :id`, {
          qty: newQuantity,
          id: req.params.id,
        });
        await conn.query(
          `INSERT INTO InventoryTransaction (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, Remarks)
           VALUES (:transactionId, :invId, :userId, :type, :qty, 'Adjustment', :remarks)`,
          {
            transactionId,
            invId: req.params.id,
            userId: req.user.userId,
            type: diff > 0 ? "Stock In" : "Stock Out",
            qty: Math.abs(diff),
            remarks: remarks || null,
          }
        );
      }
      await conn.commit();
      res.json({ message: "Inventory record updated." });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  })
);

// DELETE /inventory/:id?force=true
//
// By default, refuses to delete an Inventory row that has any
// InventoryTransaction history — that history is an audit trail (who moved
// how much stock, when, and why), and MySQL's own foreign key would reject
// the delete anyway once any transaction references this row. Rather than
// letting that raw FK error reach the user, we check for it first and
// explain clearly, offering an explicit "force" delete that also wipes the
// transaction history for this record (used only when the user has
// confirmed they understand that trade-off).
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const force = req.query.force === "true";

    const [rows] = await pool.query(`SELECT StockOnHand,EmptyStock FROM Inventory WHERE InventoryID = :id`, {
      id: req.params.id,
    });
    if (!rows[0]) throw new ApiError(404, "Inventory record not found.");
    if (rows[0].StockOnHand > 0 || rows[0].EmptyStock > 0) {
      throw new ApiError(
        400,
        "This product still has stock on hand. Adjust the quantity to 0 before deleting the record."
      );
    }

    const [[{ count }]] = await pool.query(
      `SELECT COUNT(*) AS count FROM InventoryTransaction WHERE InventoryID = :id`,
      { id: req.params.id }
    );

    if (count > 0 && !force) {
      throw new ApiError(
        409,
        `This inventory record has ${count} transaction(s) in its history (Stock In/Out/Adjustment). ` +
          `Deleting it also permanently deletes that history and cannot be undone. ` +
          `If you're sure, confirm again to force-delete it along with its history.`
      );
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (count > 0) {
        await conn.query(`DELETE FROM InventoryTransaction WHERE InventoryID = :id`, { id: req.params.id });
      }
      await conn.query(`DELETE FROM Inventory WHERE InventoryID = :id`, { id: req.params.id });

      if (force && count > 0) {
        const userActivityId = await nextId(conn, "UserActivity", "UserActivityID", "UA");
        await conn.query(
          `INSERT INTO UserActivity (UserActivityID, UserID, ActivityType, Module, RecordID, Description)
           VALUES (:userActivityId, :userId, 'Delete', 'Inventory — Inventory Transactions', :recordId, :description)`,
          {
            userActivityId,
            userId: req.user.userId,
            recordId: req.params.id,
            description: `Force-deleted inventory record and its ${count} transaction record(s)`,
          }
        );
      }

      await conn.commit();
      res.json({ message: "Inventory record deleted." });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  })
);

module.exports = router;







