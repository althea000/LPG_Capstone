const router = require("express").Router();
const pool = require("../config/db");
const { transaction, id } = require("../services/orderLifecycle");
const updateProductStock = require("../services/productStock");
const asyncHandler = require("../utils/asyncHandler");
const { resolveOption, validateUnit } = require("../utils/productOptions");
const ApiError = require("../utils/apiError");
const { authenticate } = require("../middleware/auth");

function randomProductCode(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function nextProductId(conn, maxAttempts = 20) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = `P-${randomProductCode(8)}`;
    const [rows] = await conn.query(
      `SELECT ProductID FROM Product WHERE ProductID = :id LIMIT 1`,
      { id: candidate }
    );
    if (!rows[0]) return candidate;
  }
  throw new ApiError(500, "Could not generate a unique Product ID. Please try again.");
}

const CORE_WAREHOUSE_NAMES = ["Pasig Warehouse", "San Juan Warehouse"];

async function seedCoreWarehouseInventoryForProduct(conn, productId, companyId) {
  if (!companyId) return;

  const [warehouses] = await conn.query(
    `SELECT WarehouseID AS warehouseId
     FROM Warehouse
     WHERE CompanyID = :companyId AND WarehouseName IN (:nameA, :nameB)`,
    { companyId, nameA: CORE_WAREHOUSE_NAMES[0], nameB: CORE_WAREHOUSE_NAMES[1] }
  );

  for (const warehouse of warehouses) {
    const [existingRows] = await conn.query(
      `SELECT InventoryID FROM Inventory WHERE WarehouseID = :warehouseId AND ProductID = :productId LIMIT 1`,
      { warehouseId: warehouse.warehouseId, productId }
    );
    if (existingRows[0]) continue;

    const inventoryId = id("INT");
    try {
      await conn.query(
        `INSERT INTO Inventory (InventoryID, WarehouseID, ProductID, StockOnHand)
         VALUES (:inventoryId, :warehouseId, :productId, 0)`,
        { inventoryId, warehouseId: warehouse.warehouseId, productId }
      );
    } catch (err) {
      if (!err || err.code !== "ER_DUP_ENTRY") throw err;
    }
  }
}

router.use(authenticate);

// GET /products?search=&category=&status=&supplierId=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { search, category, status, warehouseId, supplierId } = req.query;
    const params = {};

    let inventoryJoin = `LEFT JOIN Inventory i ON i.ProductID = p.ProductID`;
    if (warehouseId) {
      inventoryJoin += ` AND i.WarehouseID = :warehouseId`;
      params.warehouseId = warehouseId;
    }

    let sql = `
      SELECT p.ProductID AS productId, p.ProductName AS name, c.Category AS category,
             s.SupplierName AS supplier, p.UnitValue AS unitValue, p.Unit AS unit, p.UnitPrice AS unitPrice,
             p.CostPrice AS costPrice, p.ReorderLevel AS reorderLevel,
             p.ImageURL AS imageUrl, p.ARModelURL AS arModelUrl, p.Status AS status,
             COALESCE(SUM(i.StockOnHand), 0) AS stock,
             COALESCE(SUM(i.EmptyStock), 0) AS emptyStock,
             (LOWER(p.Unit)='kg' OR LOWER(c.Category) IN ('cylinder','gasul lpg','lpg')) AS isTank
      FROM Product p
      JOIN Category c ON c.CategoryID = p.CategoryID
      JOIN Supplier s ON s.SupplierID = p.SupplierID
      ${inventoryJoin}
      WHERE 1=1`;

    if (search) {
      sql += ` AND (p.ProductName LIKE :search OR p.ProductID = :searchId)`;
      params.search = `%${search}%`;
      params.searchId = String(search);
    }
    if (category) {
      sql += ` AND c.Category = :category`;
      params.category = category;
    }
    if (status) {
      sql += ` AND p.Status = :status`;
      params.status = status;
    }
    if (supplierId) {
      sql += ` AND p.SupplierID = :supplierId`;
      params.supplierId = supplierId;
    }
    sql += ` GROUP BY p.ProductID ORDER BY p.CreatedAt DESC, p.ProductID DESC`;
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  })
);

router.get('/:id/inventory',asyncHandler(async(req,res)=>{
  const [rows]=await pool.query(`SELECT w.WarehouseID AS id,w.WarehouseName AS name,COALESCE(i.StockOnHand,0) AS stock FROM Warehouse w LEFT JOIN Inventory i ON i.WarehouseID=w.WarehouseID AND i.ProductID=:product WHERE w.CompanyID=:company ORDER BY w.WarehouseName`,{product:req.params.id,company:req.user.companyId});res.json(rows);
}));
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT p.*, (SELECT COALESCE(SUM(i.StockOnHand),0) FROM Inventory i JOIN Warehouse w ON w.WarehouseID=i.WarehouseID WHERE i.ProductID=p.ProductID AND w.CompanyID=:company) AS Stock, c.Category, b.Brand, s.SupplierName
       FROM Product p
       JOIN Category c ON c.CategoryID = p.CategoryID
       JOIN Brand b ON b.BrandID = p.BrandID
       JOIN Supplier s ON s.SupplierID = p.SupplierID
       WHERE p.ProductID = :id`,
      { id: req.params.id, company:req.user.companyId }
    );
    if (!rows[0]) throw new ApiError(404, "Product not found.");
    res.json(rows[0]);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const saved = await transaction(async conn => {
      validateUnit(req.body);
      if (req.body.category !== undefined) req.body.categoryId = (await resolveOption(conn, 'Category', req.body.category)).id;
      if (req.body.brand !== undefined) req.body.brandId = (await resolveOption(conn, 'Brand', req.body.brand)).id;
      const {
        productName, categoryId, brandId, supplierId, unit, unitValue,
        unitPrice, costPrice, reorderLevel, imageUrl, arModelUrl, status,
      } = req.body;

      if (!productName || !categoryId || !brandId || !supplierId || !unit) {
        throw new ApiError(400, "productName, categoryId, brandId, supplierId and unit are required.");
      }

      const productId = await nextProductId(conn);

      await conn.query(
        `INSERT INTO Product
          (ProductID, ProductName, CategoryID, BrandID, SupplierID, Unit, UnitValue, UnitPrice, CostPrice, ReorderLevel, ImageURL, ARModelURL, Status)
         VALUES
          (:productId, :productName, :categoryId, :brandId, :supplierId, :unit, :unitValue, :unitPrice, :costPrice, :reorderLevel, :imageUrl, :arModelUrl, :status)`,
        {
          productId,
          productName, categoryId, brandId, supplierId, unit, unitValue,
          unitPrice: unitPrice || 0,
          costPrice: costPrice || 0,
          reorderLevel: reorderLevel || 0,
          imageUrl: imageUrl || null,
          arModelUrl: arModelUrl || null,
          status: status || "Active",
        }
      );

      await seedCoreWarehouseInventoryForProduct(conn, productId, req.user.companyId);

      const userActivityId = id("UA");
      await conn.query(
        `INSERT INTO UserActivity (UserActivityID, UserID, ActivityType, Module, RecordID, Description)
         VALUES (:userActivityId, :userId, 'Create', 'Products — Product Management', :recordId, 'Created a new product')`,
        { userActivityId, userId: req.user.userId, recordId: productId }
      );

      await updateProductStock(conn,productId,req.user,req.body);
      return {productId};
    });
    res.status(201).json(saved);
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const saved = await transaction(async conn => {
      validateUnit(req.body);
      if (req.body.category !== undefined) req.body.categoryId = (await resolveOption(conn, 'Category', req.body.category)).id;
      if (req.body.brand !== undefined) req.body.brandId = (await resolveOption(conn, 'Brand', req.body.brand)).id;
      const fields = [
        "ProductName", "CategoryID", "BrandID", "SupplierID", "Unit", "UnitValue",
        "UnitPrice", "CostPrice", "ReorderLevel", "ImageURL", "ARModelURL", "Status",
      ];
      const body = req.body;
      const map = {
        ProductName: body.productName, CategoryID: body.categoryId, BrandID: body.brandId,
        SupplierID: body.supplierId, Unit: body.unit, UnitValue: body.unitValue, UnitPrice: body.unitPrice,
        CostPrice: body.costPrice, ReorderLevel: body.reorderLevel, ImageURL: body.imageUrl,
        ARModelURL: body.arModelUrl, Status: body.status,
      };
      const setClauses = [];
      const params = { id: req.params.id };
      fields.forEach((f) => {
        if (map[f] !== undefined) {
          setClauses.push(`${f} = :${f}`);
          params[f] = map[f];
        }
    });
    if (!setClauses.length) throw new ApiError(400, "No fields provided to update.");

    const [result] = await conn.query(
      `UPDATE Product SET ${setClauses.join(", ")} WHERE ProductID = :id`,
      params
    );
    if (!result.affectedRows) throw new ApiError(404, "Product not found.");

    const userActivityId = id("UA");
    await conn.query(
      `INSERT INTO UserActivity (UserActivityID, UserID, ActivityType, Module, RecordID, Description)
       VALUES (:userActivityId, :userId, 'Update', 'Products — Product Management', :recordId, 'Updated a product')`,
      { userActivityId, userId: req.user.userId, recordId: req.params.id }
    );

    await updateProductStock(conn,req.params.id,req.user,req.body);
    return {message: "Product updated."};
    });
    res.json(saved);
  })
);

// Hard deletion is safe only after the history migration has completed.
router.delete("/:id", asyncHandler(async (req, res) => {
  const [[snapshotTrigger]] = await pool.query(`SELECT COUNT(*) AS count FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = 'snapshot_inventorytransaction'`);
  if (!Number(snapshotTrigger.count)) throw new ApiError(503, "Run the product history migration before deleting products.");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(`DELETE FROM Product WHERE ProductID = :id`, { id: req.params.id });
    if (!result.affectedRows) throw new ApiError(404, "Product not found.");
    const userActivityId = id("UA");
    await conn.query(`INSERT INTO UserActivity (UserActivityID, UserID, ActivityType, Module, RecordID, Description)
      VALUES (:userActivityId, :userId, 'Delete', 'Products — Product Management', :recordId, 'Deleted a product; historical records preserved')`,
      { userActivityId, userId: req.user.userId, recordId: req.params.id });
    await conn.commit();
    res.json({ message: "Product deleted." });
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
}));
module.exports = router;
