require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("../config/db");

const emails = [
  "maria.santos@gloriouscommercial.ph",
  "antonio.bautista@gloriouscommercial.ph",
  "carlo.mendoza@gloriouscommercial.ph",
  "liza.fernandez@gloriouscommercial.ph",
  "rico.villamor@gloriouscommercial.ph",
  "mina.reyes@gloriouscommercial.ph",
  "jose.villanueva.admin@gmail.com",
];

async function main() {
  const [rows] = await pool.query(
    `SELECT UserID, Email, PasswordHash, Status
     FROM User
     WHERE Email IN (:emails)
     ORDER BY Email`,
    { emails }
  );

  for (const row of rows) {
    const matchesWelcome = await bcrypt.compare("Welcome@123", row.PasswordHash);
    const matchesAdmin = await bcrypt.compare("Admin@123", row.PasswordHash);
    console.log(
      `${row.Email} | ${row.UserID} | status=${row.Status} | Welcome@123=${matchesWelcome} | Admin@123=${matchesAdmin}`
    );
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err.message || err);
  await pool.end();
  process.exit(1);
});

