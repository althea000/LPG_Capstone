const router = require("express").Router();
const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/apiError");
const { authenticate, authorize } = require("../middleware/auth");

async function nextId(conn, table, column, prefix, pad = 3) {
  const [rows] = await conn.query(
    `SELECT ${column} AS id FROM ${table} WHERE ${column} LIKE :pattern ORDER BY ${column} DESC LIMIT 500`,
    { pattern: `${prefix}-%` }
  );
  let max = 0;
  for (const row of rows) {
    const match = String(row.id || "").match(new RegExp(`^${prefix}-(\\d+)$`));
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(pad, "0")}`;
}

router.use(authenticate);

const LIST_SELECT = `
  SELECT u.UserID AS id, CONCAT(u.FirstName, ' ', u.LastName) AS name, u.FirstName AS firstName,
         u.LastName AS lastName, u.Email AS email, r.RoleName AS role, r.RoleID AS roleId,
         w.WarehouseName AS branch, u.WarehouseID AS warehouseId,
         u.Status AS status, u.ModuleAccess AS moduleAccess, u.CreatedAt AS createdAt
  FROM User u
  JOIN Role r ON r.RoleID = u.RoleID
  LEFT JOIN Warehouse w ON w.WarehouseID = u.WarehouseID
`;

function parseModules(raw) {
  if (!raw) return { dashboard: true };
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { dashboard: true };
  }
}

function modulesByRole(roleName) {
  const role = String(roleName || "").trim().toLowerCase();

  const allow = (...keys) => {
    const base = {
      dashboard: false,
      pos: false,
      inventory: false,
      products: false,
      sales: false,
      restocking: false,
      orders: false,
      suppliers: false,
      report: false,
      data: false,
      users: false,
      settings: false,
    };
    for (const key of keys) base[key] = true;
    return base;
  };

  if (role === "administrator" || role === "admin") {
    return allow("dashboard", "pos", "inventory", "products", "sales", "restocking", "orders", "suppliers", "report", "data", "users", "settings");
  }
  if (role === "operations supervisor") {
    return allow("dashboard", "inventory", "products", "sales", "restocking", "suppliers", "report", "data", "users", "settings");
  }
  if (role === "assistant operations supervisor") {
    return allow("dashboard", "inventory", "products", "sales", "restocking", "suppliers", "report", "data");
  }
  if (role === "store supervisor") {
    return allow("dashboard", "pos", "inventory", "products", "sales", "orders", "report", "data");
  }
  if (role === "assistant store supervisor") {
    return allow("dashboard", "pos", "inventory", "products", "sales", "orders");
  }
  if (role === "stockman" || role === "head maintenance") {
    return allow("inventory");
  }
  if (role === "drivers" || role === "helpers") {
    return allow("orders");
  }

  return allow();
}

// GET /users?search=&role=&status=&branch=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { search, role, status, branch } = req.query;
    let sql = LIST_SELECT + ` WHERE u.CompanyID = :companyId`;
    const params = { companyId: req.user.companyId };
    if (search) {
      sql += ` AND (u.FirstName LIKE :s OR u.LastName LIKE :s OR u.Email LIKE :s)`;
      params.s = `%${search}%`;
    }
    if (role) {
      sql += ` AND r.RoleName = :role`;
      params.role = role;
    }
    if (status) {
      sql += ` AND u.Status = :status`;
      params.status = status;
    }
    if (branch) {
      sql += ` AND w.WarehouseName = :branch`;
      params.branch = branch;
    }
    sql += ` ORDER BY u.UserID DESC`;
    const [rows] = await pool.query(sql, params);
    res.json(rows.map((r) => ({ ...r, moduleAccess: parseModules(r.moduleAccess) })));
  })
);

// GET /users/activity-log  -- must come before /:id so it isn't swallowed by the param route
router.get(
  "/activity-log",
  asyncHandler(async (req, res) => {
    const { search, role, status } = req.query;
    let sql = `
      SELECT a.UserActivityID AS id, u.UserID AS userId, CONCAT(u.FirstName,' ',u.LastName) AS name,
             r.RoleName AS role, u.Status AS status, a.Module AS module, a.ActivityType AS action,
             a.Description AS description, a.ActivityDate AS datetime
      FROM UserActivity a
      JOIN User u ON u.UserID = a.UserID
      JOIN Role r ON r.RoleID = u.RoleID
      WHERE 1=1`;
    const params = {};
    if (search) {
      sql += ` AND (u.FirstName LIKE :s OR u.LastName LIKE :s OR u.UserID = :sid)`;
      params.s = `%${search}%`;
      params.sid = Number(search) || 0;
    }
    if (role) {
      sql += ` AND r.RoleName = :role`;
      params.role = role;
    }
    if (status) {
      sql += ` AND u.Status = :status`;
      params.status = status;
    }
    sql += ` ORDER BY a.ActivityDate DESC LIMIT 200`;
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  })
);

// GET /users/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(LIST_SELECT + ` WHERE u.UserID = :id`, { id: req.params.id });
    if (!rows[0]) throw new ApiError(404, "User not found.");
    res.json({ ...rows[0], moduleAccess: parseModules(rows[0].moduleAccess) });
  })
);

router.post(
  "/",
  authorize("Admin", "Manager"),
  asyncHandler(async (req, res) => {
    const { fullName, usernameEmail, password, role, branch, status, modules } = req.body;
    if (!fullName || !usernameEmail || !password || !role) {
      throw new ApiError(400, "fullName, usernameEmail, password and role are required.");
    }

    const [roleRows] = await pool.query(`SELECT RoleID FROM Role WHERE RoleName = :role`, { role });
    if (!roleRows[0]) throw new ApiError(400, "Invalid role.");

    let warehouseId = null;
    if (branch) {
      const [whRows] = await pool.query(`SELECT WarehouseID FROM Warehouse WHERE WarehouseName = :branch`, {
        branch,
      });
      if (!whRows[0]) throw new ApiError(400, "Invalid branch/warehouse.");
      warehouseId = whRows[0].WarehouseID;
    }

    const [existing] = await pool.query(`SELECT UserID FROM User WHERE Email = :email`, {
      email: usernameEmail,
    });
    if (existing[0]) throw new ApiError(409, "A user with this email already exists.");

    const [firstName, ...rest] = fullName.trim().split(" ");
    const lastName = rest.join(" ") || firstName;
    const passwordHash = await bcrypt.hash(password, 10);

    const userId = await nextId(pool, "User", "UserID", "U");

    await pool.query(
      `INSERT INTO User (UserID, CompanyID, RoleID, WarehouseID, FirstName, LastName, Email, PasswordHash, Status, ModuleAccess)
       VALUES (:userId, :companyId, :roleId, :warehouseId, :firstName, :lastName, :email, :passwordHash, :status, :modules)`,
      {
        userId,
        companyId: req.user.companyId,
        roleId: roleRows[0].RoleID,
        warehouseId,
        firstName,
        lastName,
        email: usernameEmail,
        passwordHash,
        status: status || "Active",
        modules: JSON.stringify(modulesByRole(role)),
      }
    );

    const userActivityId = await nextId(pool, "UserActivity", "UserActivityID", "UA");
    await pool.query(
      `INSERT INTO UserActivity (UserActivityID, UserID, ActivityType, Module, RecordID, Description)
       VALUES (:userActivityId, :userId, 'Create', 'Users', :recordId, 'Created a new user')`,
      { userActivityId, userId: req.user.userId, recordId: userId }
    );

    res.status(201).json({ id: userId });
  })
);

router.put(
  "/:id",
  authorize("Admin", "Manager"),
  asyncHandler(async (req, res) => {
    const { fullName, status, role, branch, modules, password } = req.body;
    const params = { id: req.params.id };
    const sets = [];

    if (fullName) {
      const [firstName, ...rest] = fullName.trim().split(" ");
      sets.push(`FirstName = :firstName`, `LastName = :lastName`);
      params.firstName = firstName;
      params.lastName = rest.join(" ") || firstName;
    }
    if (status) {
      sets.push(`Status = :status`);
      params.status = status;
    }
    if (role) {
      const [roleRows] = await pool.query(`SELECT RoleID FROM Role WHERE RoleName = :role`, { role });
      if (!roleRows[0]) throw new ApiError(400, "Invalid role.");
      sets.push(`RoleID = :roleId`);
      params.roleId = roleRows[0].RoleID;
    }
    if (branch !== undefined) {
      if (branch) {
        const [whRows] = await pool.query(`SELECT WarehouseID FROM Warehouse WHERE WarehouseName = :branch`, {
          branch,
        });
        if (!whRows[0]) throw new ApiError(400, "Invalid branch/warehouse.");
        sets.push(`WarehouseID = :warehouseId`);
        params.warehouseId = whRows[0].WarehouseID;
      } else {
        sets.push(`WarehouseID = NULL`);
      }
    }
    if (role || modules !== undefined) {
      const effectiveRole = role || (await pool.query(`SELECT RoleName FROM Role WHERE RoleID = (SELECT RoleID FROM User WHERE UserID = :id)`, { id: req.params.id }))[0][0]?.RoleName;
      sets.push(`ModuleAccess = :modules`);
      params.modules = JSON.stringify(modulesByRole(effectiveRole));
    }
    if (password) {
      sets.push(`PasswordHash = :passwordHash`);
      params.passwordHash = await bcrypt.hash(password, 10);
    }
    if (!sets.length) throw new ApiError(400, "No fields provided to update.");

    const [result] = await pool.query(`UPDATE User SET ${sets.join(", ")} WHERE UserID = :id`, params);
    if (!result.affectedRows) throw new ApiError(404, "User not found.");

    const userActivityId = await nextId(pool, "UserActivity", "UserActivityID", "UA");
    await pool.query(
      `INSERT INTO UserActivity (UserActivityID, UserID, ActivityType, Module, RecordID, Description)
       VALUES (:userActivityId, :userId, 'Update', 'Users', :recordId, 'Updated a user')`,
      { userActivityId, userId: req.user.userId, recordId: req.params.id }
    );

    res.json({ message: "User updated." });
  })
);

// DELETE /users/:id — soft delete: users are referenced by Sales, InventoryTransaction, UserActivity, etc.
router.delete(
  "/:id",
  authorize("Admin", "Manager"),
  asyncHandler(async (req, res) => {
    if (String(req.params.id) === String(req.user.userId)) {
      throw new ApiError(400, "You cannot deactivate your own account.");
    }
    const [result] = await pool.query(`UPDATE User SET Status = 'Inactive' WHERE UserID = :id`, {
      id: req.params.id,
    });
    if (!result.affectedRows) throw new ApiError(404, "User not found.");

    const userActivityId = await nextId(pool, "UserActivity", "UserActivityID", "UA");
    await pool.query(
      `INSERT INTO UserActivity (UserActivityID, UserID, ActivityType, Module, RecordID, Description)
       VALUES (:userActivityId, :userId, 'Delete', 'Users', :recordId, 'Deactivated a user')`,
      { userActivityId, userId: req.user.userId, recordId: req.params.id }
    );

    res.json({ message: "User deactivated." });
  })
);

module.exports = router;

