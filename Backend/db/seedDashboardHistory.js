require("dotenv").config();
const pool = require("../config/db");
const { nextSequence } = require("../utils/generateNumbers");

const START_DATE = "2026-09-23";
const TARGET_EMAILS = [
  "jose.villanueva.admin@gmail.com",
  "jose.villanueva@gloriouscommercial.ph",
];

async function nextId(conn, table, column, prefix, pad = 3) {
  const [rows] = await conn.query(
    `SELECT ${column} AS id FROM ${table} WHERE ${column} LIKE :pattern ORDER BY ${column} DESC LIMIT 500`,
    { pattern: `${prefix}-%` }
  );

  let max = 0;
  for (const row of rows) {
    const match = String(row.id || "").match(new RegExp(`^${prefix}-(\\d+)$`));
    if (!match) continue;
    const numeric = Number(match[1]);
    if (Number.isInteger(numeric) && numeric > max) max = numeric;
  }
  return `${prefix}-${String(max + 1).padStart(pad, "0")}`;
}

function formatDateYmd(date) {
  return date.toISOString().slice(0, 10);
}

function parseLocalDate(ymd) {
  return new Date(`${ymd}T00:00:00`);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFrom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function buildSaleDateTime(dateYmd, index, isToday) {
  const base = parseLocalDate(dateYmd);
  const now = new Date();

  const minHour = 8;
  const maxHour = isToday ? Math.max(8, now.getHours()) : 20;
  const hour = Math.min(maxHour, minHour + (index % Math.max(1, maxHour - minHour + 1)));
  const minute = randomInt(0, 59);

  base.setHours(hour, minute, 0, 0);

  if (isToday && base > now) {
    const safeNow = new Date(now.getTime() - 2 * 60 * 1000);
    if (safeNow > parseLocalDate(dateYmd)) {
      return safeNow;
    }
  }

  return base;
}

function transactionsTargetForDate(dateYmd, todayYmd) {
  if (dateYmd === todayYmd) {
    return 18;
  }

  const d = parseLocalDate(dateYmd);
  const day = d.getDay();
  const isWeekend = day === 0 || day === 6;
  return isWeekend ? 8 : 12;
}

async function findTargetUser(conn) {
  const [rows] = await conn.query(
    `SELECT u.UserID, u.Email
     FROM User u
     WHERE u.Email IN (:emails)
     ORDER BY FIELD(u.Email, :preferred1, :preferred2)
     LIMIT 1`,
    {
      emails: TARGET_EMAILS,
      preferred1: TARGET_EMAILS[0],
      preferred2: TARGET_EMAILS[1],
    }
  );

  if (rows[0]) return rows[0];

  const [fallbackRows] = await conn.query(
    `SELECT UserID, Email
     FROM User
     WHERE Status = 'Active'
     ORDER BY CreatedAt ASC
     LIMIT 1`
  );

  if (!fallbackRows[0]) {
    throw new Error("No active user found to assign seeded sales.");
  }

  return fallbackRows[0];
}

async function ensureCustomer(conn, { customerType, customerName, contactNo, address }) {
  const [existing] = await conn.query(
    `SELECT CustomerID FROM Customer WHERE ContactNo = :contactNo LIMIT 1`,
    { contactNo }
  );

  if (existing[0]) return existing[0].CustomerID;

  const customerId = await nextId(conn, "Customer", "CustomerID", "CUST");
  await conn.query(
    `INSERT INTO Customer (CustomerID, CustomerType, CustomerName, ContactNo, Address, Status)
     VALUES (:customerId, :customerType, :customerName, :contactNo, :address, 'Active')`,
    { customerId, customerType, customerName, contactNo, address }
  );

  return customerId;
}

async function main() {
  const conn = await pool.getConnection();

  try {
    const user = await findTargetUser(conn);

    const [products] = await conn.query(
      `SELECT ProductID, ProductName, UnitPrice
       FROM Product
       WHERE Status = 'Active'
       ORDER BY ProductName ASC`
    );

    if (products.length < 2) {
      throw new Error("At least 2 active products are required to seed dashboard history.");
    }

    const usableProducts = products
      .map((p) => ({ ...p, UnitPrice: Number(p.UnitPrice) || 0 }))
      .filter((p) => p.UnitPrice > 0);

    if (usableProducts.length < 2) {
      throw new Error("At least 2 active products with UnitPrice > 0 are required.");
    }

    const customerA = await ensureCustomer(conn, {
      customerType: "Residential",
      customerName: "Dashboard Demo Customer A",
      contactNo: "09181239991",
      address: "San Juan City",
    });

    const customerB = await ensureCustomer(conn, {
      customerType: "Commercial",
      customerName: "Dashboard Demo Customer B",
      contactNo: "09181239992",
      address: "Pasig City",
    });

    const today = new Date();
    const todayYmd = formatDateYmd(today);
    const start = parseLocalDate(START_DATE);
    const end = parseLocalDate(todayYmd);

    if (start > end) {
      throw new Error(`START_DATE ${START_DATE} is after today ${todayYmd}.`);
    }

    let current = new Date(start);
    let insertedSales = 0;

    await conn.beginTransaction();

    while (current <= end) {
      const dateYmd = formatDateYmd(current);
      const target = transactionsTargetForDate(dateYmd, todayYmd);

      const [[existing]] = await conn.query(
        `SELECT COUNT(*) AS count
         FROM Sales
         WHERE UserID = :userId AND DATE(SaleDate) = :saleDate`,
        { userId: user.UserID, saleDate: dateYmd }
      );

      const missing = Math.max(0, target - Number(existing.count || 0));

      for (let i = 0; i < missing; i++) {
        const isToday = dateYmd === todayYmd;
        const saleDate = buildSaleDateTime(dateYmd, i, isToday);

        const orderId = await nextId(conn, "`Order`", "OrderID", "ORD");
        const saleId = await nextId(conn, "Sales", "SaleID", "S");
        const paymentId = await nextId(conn, "Payment", "PaymentID", "PAY");

        const orderNo = await nextSequence(conn, "`Order`", "OrderNo", "ORD");
        const saleNo = await nextSequence(conn, "Sales", "SaleNo", "SALE");

        const customerId = i % 2 === 0 ? customerA : customerB;
        const orderType = randomFrom(["Walk-in", "Delivery", "Pickup"]);
        const paymentMethod = randomFrom(["Cash", "Gcash", "Card"]);
        const discount = i % 7 === 0 ? 50 : 0;

        const lineCount = randomInt(1, 3);
        const picked = [];
        while (picked.length < lineCount) {
          const candidate = randomFrom(usableProducts);
          if (!picked.find((p) => p.ProductID === candidate.ProductID)) {
            picked.push(candidate);
          }
        }

        const lineItems = picked.map((product) => {
          const qty = randomInt(1, 3);
          const unitPrice = Number(product.UnitPrice);
          return {
            productId: product.ProductID,
            qty,
            unitPrice,
            subtotal: qty * unitPrice,
          };
        });

        const subtotal = lineItems.reduce((sum, item) => sum + item.subtotal, 0);
        const totalAmount = Math.max(0, subtotal - discount);

        await conn.query(
          `INSERT INTO \`Order\` (OrderID, CustomerID, OrderNo, OrderDate, OrderType, OrderStatus, TotalAmount, Remarks)
           VALUES (:orderId, :customerId, :orderNo, :orderDate, :orderType, 'Completed', :totalAmount, :remarks)`,
          {
            orderId,
            customerId,
            orderNo,
            orderDate: saleDate,
            orderType,
            totalAmount,
            remarks: `Dashboard history seed ${dateYmd}`,
          }
        );

        for (const line of lineItems) {
          const orderDetailId = await nextId(conn, "OrderDetails", "OrderDetailID", "OD");
          await conn.query(
            `INSERT INTO OrderDetails (OrderDetailID, OrderID, ProductID, Quantity, UnitPrice, Subtotal)
             VALUES (:orderDetailId, :orderId, :productId, :qty, :unitPrice, :subtotal)`,
            {
              orderDetailId,
              orderId,
              productId: line.productId,
              qty: line.qty,
              unitPrice: line.unitPrice,
              subtotal: line.subtotal,
            }
          );
        }

        await conn.query(
          `INSERT INTO Sales (SaleID, OrderID, CustomerID, UserID, SaleNo, SaleDate, SalesDiscount, TotalAmount, Remarks)
           VALUES (:saleId, :orderId, :customerId, :userId, :saleNo, :saleDate, :discount, :totalAmount, :remarks)`,
          {
            saleId,
            orderId,
            customerId,
            userId: user.UserID,
            saleNo,
            saleDate,
            discount,
            totalAmount,
            remarks: `Dashboard history seed ${dateYmd}`,
          }
        );

        await conn.query(
          `INSERT INTO Payment (PaymentID, PaymentType, SaleID, PaymentMethod, AmountPaid, PaymentDate, Remarks)
           VALUES (:paymentId, 'Sale', :saleId, :paymentMethod, :amountPaid, :paymentDate, :remarks)`,
          {
            paymentId,
            saleId,
            paymentMethod,
            amountPaid: totalAmount,
            paymentDate: saleDate,
            remarks: "Dashboard history seed payment",
          }
        );

        insertedSales += 1;
      }

      current = addDays(current, 1);
    }

    await conn.commit();

    console.log(`Seed complete. Inserted ${insertedSales} sale(s) from ${START_DATE} to ${todayYmd} for ${user.Email}.`);
    console.log("Dashboard remains real-time: new future transactions will appear automatically.");
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
