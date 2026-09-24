require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("../config/db");

async function seed() {
  try {
    // 1. Insert Company
    const [companyResult] = await pool.query(
      `INSERT INTO Company (CompanyName, DTIRegNo, PrimaryBranch, Address)
       VALUES ('GasTrack Demo Co.', 'DTI-0000001', 'Main Branch', 'Manila, Philippines')`
    );
    const companyId = companyResult.insertId;

    // 2. Insert Warehouse
    await pool.query(
      `INSERT INTO Warehouse (CompanyID, WarehouseName, Location) VALUES (?, 'Pasig Warehouse', 'Pasig City')`,
      [companyId]
    );

    // 3. Get Admin Role ID
    const [[adminRole]] = await pool.query(`SELECT RoleID FROM Role WHERE RoleName = 'Admin'`);

    if (!adminRole) {
      throw new Error("Admin role not found in database. Make sure schema.sql has been imported.");
    }

    // 4. Hash Password
    const passwordHash = await bcrypt.hash("Admin@123", 10);

    // 5. Insert Admin User
    await pool.query(
      `INSERT INTO User (CompanyID, RoleID, FirstName, LastName, Email, PasswordHash)
       VALUES (?, ?, 'Juan', 'Dela Cruz', 'admin@gastrack.com', ?)`,
      [companyId, adminRole.RoleID, passwordHash]
    );

    console.log("Seed complete. Login with admin@gastrack.com / Admin@123");
    process.exit(0);
  } catch (err) {
    console.error("Error during seeding:", err.message);
    process.exit(1);
  }
}

seed();