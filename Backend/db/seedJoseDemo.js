require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const { nextSequence } = require("../utils/generateNumbers");

const TARGET_EMAIL = "jose.villanueva@gloriouscommercial.ph";
const DEMO_TAG = "DEMO-JOSE-2026";

async function nextId(conn, table, column, prefix, pad = 3) {
  const [rows] = await conn.query(
    `SELECT ${column} AS id FROM ${table} WHERE ${column} LIKE :pattern ORDER BY ${column} DESC LIMIT 500`,
    { pattern: `${prefix}-%` }
  );
  let max = 0;
  for (const row of rows) {
    const match = String(row.id || "").match(new RegExp(`^${prefix}-(\\d+)$`));
    if (!match) continue;
    const num = Number(match[1]);
    if (Number.isInteger(num) && num > max) max = num;
  }
  return `${prefix}-${String(max + 1).padStart(pad, "0")}`;
}

function daysAgo(n, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 15, 0, 0);
  return d;
}

async function ensureSupplier(conn, data) {
  const [existing] = await conn.query(`SELECT SupplierID FROM Supplier WHERE SupplierName = :name LIMIT 1`, {
    name: data.supplierName,
  });
  if (existing[0]) return existing[0].SupplierID;

  const supplierId = await nextId(conn, "Supplier", "SupplierID", "SP");
  await conn.query(
    `INSERT INTO Supplier (SupplierID, SupplierName, ContactPerson, Email, Address, Contact, LeadTimeDays, Status)
     VALUES (:supplierId, :supplierName, :contactPerson, :email, :address, :contact, :leadTimeDays, 'Active')`,
    { supplierId, ...data }
  );
  return supplierId;
}

async function ensureCustomer(conn, data) {
  const [existing] = await conn.query(`SELECT CustomerID FROM Customer WHERE ContactNo = :contactNo LIMIT 1`, {
    contactNo: data.contactNo,
  });
  if (existing[0]) return existing[0].CustomerID;

  const customerId = await nextId(conn, "Customer", "CustomerID", "CUST");
  await conn.query(
    `INSERT INTO Customer (CustomerID, CustomerType, CustomerName, ContactNo, Address, Status)
     VALUES (:customerId, :customerType, :customerName, :contactNo, :address, 'Active')`,
    { customerId, ...data }
  );
  return customerId;
}

async function main() {
  console.log("Seeding realistic demo data for Jose's company...");
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [userRows] = await conn.query(
      `SELECT u.UserID, u.CompanyID, u.RoleID, r.RoleName
       FROM User u JOIN Role r ON r.RoleID = u.RoleID
       WHERE u.Email = :email LIMIT 1`,
      { email: TARGET_EMAIL }
    );
    const jose = userRows[0];
    if (!jose) {
      throw new Error(`Target account not found: ${TARGET_EMAIL}`);
    }

    const [roleRows] = await conn.query(`SELECT RoleID, RoleName FROM Role`);
    const roleMap = new Map(roleRows.map((r) => [r.RoleName, r.RoleID]));

    const [warehouseRows] = await conn.query(
      `SELECT WarehouseID, WarehouseName FROM Warehouse WHERE CompanyID = :companyId ORDER BY WarehouseID`,
      { companyId: jose.CompanyID }
    );
    if (!warehouseRows.length) {
      throw new Error("No warehouses found for Jose's company.");
    }
    const primaryWarehouseId = warehouseRows[0].WarehouseID;

    const [categoryRows] = await conn.query(`SELECT CategoryID, Category FROM Category ORDER BY CategoryID`);
    const [brandRows] = await conn.query(`SELECT BrandID, Brand FROM Brand ORDER BY BrandID`);
    if (!categoryRows.length || !brandRows.length) {
      throw new Error("Category/Brand master data is missing.");
    }
    const lpgCategoryId = categoryRows.find((c) => c.Category === "Gasul LPG")?.CategoryID || categoryRows[0].CategoryID;
    const defaultBrandId = brandRows.find((b) => b.Brand === "Petron")?.BrandID || brandRows[0].BrandID;

    const supplierA = await ensureSupplier(conn, {
      supplierName: "South Metro LPG Trading",
      contactPerson: "Ramon Dela Cruz",
      email: "procurement@southmetrolpg.ph",
      address: "42 M. Almeda St., Pateros, Metro Manila",
      contact: "09178901234",
      leadTimeDays: 2,
    });
    const supplierB = await ensureSupplier(conn, {
      supplierName: "Luzon Cylinder & Accessories Inc.",
      contactPerson: "Elaine Santos",
      email: "sales@luzoncylinder.ph",
      address: "15 JP Rizal Ave., Marikina City",
      contact: "09261234567",
      leadTimeDays: 4,
    });

    const [existingProducts] = await conn.query(
      `SELECT ProductID, ProductName, UnitPrice, CostPrice, ReorderLevel FROM Product ORDER BY ProductID`
    );

    const demoProductsToCreate = [
      { name: "Gasul LPG 3.5 kg", supplierId: supplierA, unit: "kg", unitPrice: 320, costPrice: 280, reorderLevel: 25 },
      { name: "Gasul LPG 14 kg Household", supplierId: supplierA, unit: "kg", unitPrice: 1150, costPrice: 1060, reorderLevel: 30 },
      { name: "LPG Regulator Set", supplierId: supplierB, unit: "pcs", unitPrice: 850, costPrice: 720, reorderLevel: 20 },
    ];

    const productMap = new Map(existingProducts.map((p) => [p.ProductName, p]));

    for (const p of demoProductsToCreate) {
      if (productMap.has(p.name)) continue;
      const productId = await nextId(conn, "Product", "ProductID", "P");
      await conn.query(
        `INSERT INTO Product (ProductID, ProductName, CategoryID, BrandID, SupplierID, Unit, UnitPrice, CostPrice, ReorderLevel, Status)
         VALUES (:productId, :name, :categoryId, :brandId, :supplierId, :unit, :unitPrice, :costPrice, :reorderLevel, 'Active')`,
        {
          productId,
          name: p.name,
          categoryId: lpgCategoryId,
          brandId: defaultBrandId,
          supplierId: p.supplierId,
          unit: p.unit,
          unitPrice: p.unitPrice,
          costPrice: p.costPrice,
          reorderLevel: p.reorderLevel,
        }
      );
      productMap.set(p.name, {
        ProductID: productId,
        ProductName: p.name,
        UnitPrice: p.unitPrice,
        CostPrice: p.costPrice,
        ReorderLevel: p.reorderLevel,
      });
    }

    const selectedProducts = [...productMap.values()].slice(0, 6);

    for (const p of selectedProducts) {
      for (const wh of warehouseRows) {
        const [invRows] = await conn.query(
          `SELECT InventoryID FROM Inventory WHERE WarehouseID = :wid AND ProductID = :pid LIMIT 1`,
          { wid: wh.WarehouseID, pid: p.ProductID }
        );
        if (invRows[0]) continue;

        const inventoryId = await nextId(conn, "Inventory", "InventoryID", "INT");
        const startingStock = wh.WarehouseID === primaryWarehouseId ? 60 : 30;
        await conn.query(
          `INSERT INTO Inventory (InventoryID, WarehouseID, ProductID, StockOnHand)
           VALUES (:inventoryId, :warehouseId, :productId, :stock)`,
          {
            inventoryId,
            warehouseId: wh.WarehouseID,
            productId: p.ProductID,
            stock: startingStock,
          }
        );

        const txId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
        await conn.query(
          `INSERT INTO InventoryTransaction (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, ReferenceNo, Remarks)
           VALUES (:txId, :inventoryId, :userId, 'Stock In', :qty, 'Purchase', :ref, :remarks)`,
          {
            txId,
            inventoryId,
            userId: jose.UserID,
            qty: startingStock,
            ref: `${DEMO_TAG}-OPENING`,
            remarks: "Opening demo stock balance",
          }
        );
      }
    }

    const defaultPasswordHash = await bcrypt.hash("Welcome@123", 10);
    const demoUsers = [
      { firstName: "Carlo", lastName: "Mendoza", email: "carlo.mendoza@gloriouscommercial.ph", role: "Operations Supervisor", warehouseId: primaryWarehouseId },
      { firstName: "Liza", lastName: "Fernandez", email: "liza.fernandez@gloriouscommercial.ph", role: "Store Supervisor", warehouseId: primaryWarehouseId },
      { firstName: "Rico", lastName: "Villamor", email: "rico.villamor@gloriouscommercial.ph", role: "Drivers", warehouseId: primaryWarehouseId },
      { firstName: "Mina", lastName: "Reyes", email: "mina.reyes@gloriouscommercial.ph", role: "Stockman", warehouseId: primaryWarehouseId },
    ];

    const demoUserIds = {};
    for (const u of demoUsers) {
      const [existing] = await conn.query(`SELECT UserID FROM User WHERE Email = :email LIMIT 1`, { email: u.email });
      if (existing[0]) {
        demoUserIds[u.role] = existing[0].UserID;
        continue;
      }
      const roleId = roleMap.get(u.role);
      if (!roleId) continue;
      const userId = await nextId(conn, "User", "UserID", "U");
      await conn.query(
        `INSERT INTO User (UserID, CompanyID, RoleID, WarehouseID, FirstName, LastName, Email, PasswordHash, Status, ModuleAccess)
         VALUES (:userId, :companyId, :roleId, :warehouseId, :firstName, :lastName, :email, :passwordHash, 'Active', :modules)`,
        {
          userId,
          companyId: jose.CompanyID,
          roleId,
          warehouseId: u.warehouseId,
          firstName: u.firstName,
          lastName: u.lastName,
          email: u.email,
          passwordHash: defaultPasswordHash,
          modules: JSON.stringify({ dashboard: true, inventory: true, sales: true, suppliers: true }),
        }
      );
      demoUserIds[u.role] = userId;
    }

    const customerA = await ensureCustomer(conn, {
      customerType: "Residential",
      customerName: "Ana Marie Bautista",
      contactNo: "09181230001",
      address: "24 Luna St., San Juan City",
    });
    const customerB = await ensureCustomer(conn, {
      customerType: "Commercial",
      customerName: "Tomas Hardware Center",
      contactNo: "09181230002",
      address: "89 Shaw Blvd., Mandaluyong City",
    });

    const [existingDemoOrders] = await conn.query(
      `SELECT COUNT(*) AS count FROM \`Order\` WHERE Remarks LIKE :tag`,
      { tag: `%${DEMO_TAG}%` }
    );

    if (!existingDemoOrders[0].count) {
      const salesPlan = [
        { days: 0, customerId: customerA, orderType: "Walk-in", discount: 0, paymentMethod: "Cash", withDelivery: false, qtyA: 2, qtyB: 1 },
        { days: 1, customerId: customerB, orderType: "Delivery", discount: 50, paymentMethod: "Gcash", withDelivery: true, qtyA: 3, qtyB: 2 },
        { days: 2, customerId: customerA, orderType: "Pickup", discount: 0, paymentMethod: "Cash", withDelivery: false, qtyA: 1, qtyB: 1 },
        { days: 4, customerId: customerB, orderType: "Delivery", discount: 80, paymentMethod: "Card", withDelivery: true, qtyA: 4, qtyB: 1 },
        { days: 6, customerId: customerA, orderType: "Walk-in", discount: 0, paymentMethod: "Cash", withDelivery: false, qtyA: 2, qtyB: 2 },
      ];

      const p1 = selectedProducts[0];
      const p2 = selectedProducts[1] || selectedProducts[0];
      const riderId = demoUserIds["Drivers"] || null;

      for (const plan of salesPlan) {
        const saleDate = daysAgo(plan.days, 11);

        const orderId = await nextId(conn, "`Order`", "OrderID", "ORD");
        const saleId = await nextId(conn, "Sales", "SaleID", "S");
        const orderNo = await nextSequence(conn, "`Order`", "OrderNo", "ORD");
        const saleNo = await nextSequence(conn, "Sales", "SaleNo", "SALE");

        const itemLines = [
          { product: p1, qty: plan.qtyA, unitPrice: Number(p1.UnitPrice) },
          { product: p2, qty: plan.qtyB, unitPrice: Number(p2.UnitPrice) },
        ];
        const subtotal = itemLines.reduce((s, it) => s + it.qty * it.unitPrice, 0);
        const totalAmount = subtotal - plan.discount;

        await conn.query(
          `INSERT INTO \`Order\` (OrderID, CustomerID, OrderNo, OrderDate, OrderType, OrderStatus, TotalAmount, Remarks)
           VALUES (:orderId, :customerId, :orderNo, :orderDate, :orderType, :status, :totalAmount, :remarks)`,
          {
            orderId,
            customerId: plan.customerId,
            orderNo,
            orderDate: saleDate,
            orderType: plan.orderType,
            status: "Completed",
            totalAmount,
            remarks: `${DEMO_TAG} sample order`,
          }
        );

        for (const it of itemLines) {
          const orderDetailId = await nextId(conn, "OrderDetails", "OrderDetailID", "OD");
          await conn.query(
            `INSERT INTO OrderDetails (OrderDetailID, OrderID, ProductID, Quantity, UnitPrice, Subtotal)
             VALUES (:orderDetailId, :orderId, :productId, :qty, :unitPrice, :subtotal)`,
            {
              orderDetailId,
              orderId,
              productId: it.product.ProductID,
              qty: it.qty,
              unitPrice: it.unitPrice,
              subtotal: it.qty * it.unitPrice,
            }
          );

          const [invRows] = await conn.query(
            `SELECT InventoryID, StockOnHand FROM Inventory WHERE WarehouseID = :wid AND ProductID = :pid FOR UPDATE`,
            { wid: primaryWarehouseId, pid: it.product.ProductID }
          );
          if (invRows[0]) {
            const newStock = Math.max(0, Number(invRows[0].StockOnHand) - it.qty);
            await conn.query(`UPDATE Inventory SET StockOnHand = :stock WHERE InventoryID = :id`, {
              stock: newStock,
              id: invRows[0].InventoryID,
            });

            const txId = await nextId(conn, "InventoryTransaction", "TransactionID", "T");
            await conn.query(
              `INSERT INTO InventoryTransaction (TransactionID, InventoryID, UserID, TransactionType, Quantity, Reason, ReferenceNo, TransactionDate, Remarks)
               VALUES (:txId, :inventoryId, :userId, 'Stock Out', :qty, 'Sale', :ref, :txDate, :remarks)`,
              {
                txId,
                inventoryId: invRows[0].InventoryID,
                userId: jose.UserID,
                qty: it.qty,
                ref: orderNo,
                txDate: saleDate,
                remarks: `${DEMO_TAG} stock deduction`,
              }
            );
          }
        }

        await conn.query(
          `INSERT INTO Sales (SaleID, OrderID, CustomerID, UserID, SaleNo, SaleDate, SalesDiscount, TotalAmount, Remarks)
           VALUES (:saleId, :orderId, :customerId, :userId, :saleNo, :saleDate, :discount, :totalAmount, :remarks)`,
          {
            saleId,
            orderId,
            customerId: plan.customerId,
            userId: jose.UserID,
            saleNo,
            saleDate,
            discount: plan.discount,
            totalAmount,
            remarks: `${DEMO_TAG} sample sale`,
          }
        );

        const paymentId = await nextId(conn, "Payment", "PaymentID", "PAY");
        await conn.query(
          `INSERT INTO Payment (PaymentID, PaymentType, SaleID, PaymentMethod, AmountPaid, PaymentDate, Remarks)
           VALUES (:paymentId, 'Sale', :saleId, :method, :amountPaid, :paymentDate, :remarks)`,
          {
            paymentId,
            saleId,
            method: plan.paymentMethod,
            amountPaid: totalAmount,
            paymentDate: saleDate,
            remarks: `${DEMO_TAG} payment`,
          }
        );

        if (plan.withDelivery) {
          const deliveryId = await nextId(conn, "Delivery", "DeliveryID", "D");
          const drNo = await nextSequence(conn, "Delivery", "DRNo", "DR");
          await conn.query(
            `INSERT INTO Delivery (DeliveryID, SaleID, DRNo, DeliveryDate, DeliveredByUserID, DeliveryCharge, DeliveryAddress, DeliveryStatus, Remarks)
             VALUES (:deliveryId, :saleId, :drNo, :deliveryDate, :riderId, :charge, :address, :status, :remarks)`,
            {
              deliveryId,
              saleId,
              drNo,
              deliveryDate: saleDate,
              riderId,
              charge: 60,
              address: "89 Shaw Blvd., Mandaluyong City",
              status: "Delivered",
              remarks: `${DEMO_TAG} delivered order`,
            }
          );
        }
      }
    }

    const [complianceTable] = await conn.query(
      `SELECT COUNT(*) AS count
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'ComplianceReport'`
    );

    if (complianceTable[0].count > 0) {
      const [existingReports] = await conn.query(
        `SELECT COUNT(*) AS count FROM ComplianceReport WHERE ReportName LIKE :tag`,
        { tag: `${DEMO_TAG}%` }
      );

      if (!existingReports[0].count) {
        const reports = [
          {
            name: `${DEMO_TAG} LPG Sales Summary`,
            type: "Sales Summary",
            period: "September 2026",
            start: "2026-09-01",
            end: "2026-09-30",
            due: "2026-10-10",
            status: "Due Soon",
            submittedAt: null,
          },
          {
            name: `${DEMO_TAG} Warehouse Inventory Audit`,
            type: "Inventory Audit",
            period: "Q3 2026",
            start: "2026-07-01",
            end: "2026-09-30",
            due: "2026-09-20",
            status: "Overdue",
            submittedAt: null,
          },
          {
            name: `${DEMO_TAG} Restocking Logs`,
            type: "Restocking Logs",
            period: "September 2026",
            start: "2026-09-01",
            end: "2026-09-30",
            due: "2026-11-05",
            status: "Upcoming",
            submittedAt: null,
          },
          {
            name: `${DEMO_TAG} Monthly Operations Report`,
            type: "Sales Summary",
            period: "August 2026",
            start: "2026-08-01",
            end: "2026-08-31",
            due: "2026-09-05",
            status: "Submitted",
            submittedAt: "2026-09-03 14:20:00",
          },
        ];

        for (const r of reports) {
          const reportId = await nextId(conn, "ComplianceReport", "ReportID", "REP");
          await conn.query(
            `INSERT INTO ComplianceReport
             (ReportID, ReportName, ReportType, PeriodLabel, PeriodStart, PeriodEnd, DueDate, Status, SubmittedAt, SubmittedByUserID, FileName)
             VALUES
             (:reportId, :name, :type, :period, :start, :end, :due, :status, :submittedAt, :submittedByUserID, :fileName)`,
            {
              reportId,
              name: r.name,
              type: r.type,
              period: r.period,
              start: r.start,
              end: r.end,
              due: r.due,
              status: r.status,
              submittedAt: r.submittedAt,
              submittedByUserID: r.status === "Submitted" ? jose.UserID : null,
              fileName: r.status === "Submitted" ? `${r.name.replace(/\s+/g, "_")}.csv` : null,
            }
          );
        }
      }
    }

    const [existingDataLog] = await conn.query(
      `SELECT COUNT(*) AS count FROM DataActivityLog WHERE FileName LIKE :tag`,
      { tag: `%${DEMO_TAG}%` }
    );
    if (!existingDataLog[0].count) {
      const dataLogs = [
        { activityType: "Import", dataType: "Inventory Data", fileName: `${DEMO_TAG}_inventory_adjustments.csv`, fileFormat: "CSV", dateFrom: "2026-09-01", dateTo: "2026-09-30", status: "Successful", activityDate: "2026-09-28 09:10:00" },
        { activityType: "Generate Report", dataType: "Sales Summary", fileName: `${DEMO_TAG}_sales_summary_sep2026.csv`, fileFormat: "CSV", dateFrom: "2026-09-01", dateTo: "2026-09-30", status: "Successful", activityDate: "2026-09-29 16:35:00" },
      ];

      for (const d of dataLogs) {
        const dataActivityId = await nextId(conn, "DataActivityLog", "DataActivityID", "DA");
        await conn.query(
          `INSERT INTO DataActivityLog (DataActivityID, UserID, ActivityType, DataType, FileName, FileFormat, DateFrom, DateTo, Status, ActivityDate)
           VALUES (:dataActivityId, :userId, :activityType, :dataType, :fileName, :fileFormat, :dateFrom, :dateTo, :status, :activityDate)`,
          {
            dataActivityId,
            userId: jose.UserID,
            ...d,
          }
        );
      }
    }

    const [existingUserLog] = await conn.query(
      `SELECT COUNT(*) AS count FROM UserActivity WHERE Description LIKE :tag`,
      { tag: `%${DEMO_TAG}%` }
    );
    if (!existingUserLog[0].count) {
      const activities = [
        { module: "Users", action: "Create", description: `${DEMO_TAG}: Added team accounts for operations and delivery`, date: "2026-09-26 10:20:00" },
        { module: "Suppliers", action: "Create", description: `${DEMO_TAG}: Added two accredited suppliers`, date: "2026-09-26 11:05:00" },
        { module: "Inventory", action: "Update", description: `${DEMO_TAG}: Uploaded opening stock balances`, date: "2026-09-27 08:40:00" },
        { module: "Sales", action: "Create", description: `${DEMO_TAG}: Recorded sample retail and delivery sales`, date: "2026-09-29 14:15:00" },
      ];

      for (const a of activities) {
        const userActivityId = await nextId(conn, "UserActivity", "UserActivityID", "UA");
        await conn.query(
          `INSERT INTO UserActivity (UserActivityID, UserID, ActivityType, Module, RecordID, Description, ActivityDate)
           VALUES (:userActivityId, :userId, :activityType, :module, :recordId, :description, :activityDate)`,
          {
            userActivityId,
            userId: jose.UserID,
            activityType: a.action,
            module: a.module,
            recordId: null,
            description: a.description,
            activityDate: a.date,
          }
        );
      }
    }

    await conn.commit();
    console.log("Demo data seeded successfully for:", TARGET_EMAIL);
  } catch (err) {
    await conn.rollback();
    console.error("Demo seed failed:", err.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main();
