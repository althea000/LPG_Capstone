require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("../config/db");

const STAFF_EMAILS = [
  "maria.santos@gloriouscommercial.ph",
  "antonio.bautista@gloriouscommercial.ph",
  "carlo.mendoza@gloriouscommercial.ph",
  "liza.fernandez@gloriouscommercial.ph",
  "rico.villamor@gloriouscommercial.ph",
  "mina.reyes@gloriouscommercial.ph",
];

async function main() {
  const hash = await bcrypt.hash("Welcome@123", 10);
  const [result] = await pool.query(
    `UPDATE User
     SET PasswordHash = :hash,
         Status = 'Active'
     WHERE Email IN (:emails)`,
    { hash, emails: STAFF_EMAILS }
  );

  console.log(`Updated staff accounts: ${result.affectedRows}`);

  const [rows] = await pool.query(
    `SELECT UserID, Email, Status FROM User WHERE Email IN (:emails) ORDER BY Email`,
    { emails: STAFF_EMAILS }
  );
  for (const row of rows) {
    console.log(`${row.Email} | ${row.UserID} | status=${row.Status}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err.message || err);
  await pool.end();
  process.exit(1);
});

