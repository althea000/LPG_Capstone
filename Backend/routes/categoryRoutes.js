const router = require("express").Router();
const { resolveOption } = require("../utils/productOptions");
const pool = require("../config/db");
const asyncHandler = require("../utils/asyncHandler");
const { authenticate } = require("../middleware/auth");

router.use(authenticate);

router.get("/", asyncHandler(async (req, res) => {
  const [rows] = await pool.query(`SELECT CategoryID AS id, Category AS name FROM Category ORDER BY Category`);
  const seen = new Set();
  res.json(rows.filter(row => {
    const key = String(row.name || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!key || key === 'other' || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(row => ({ ...row, name: row.name.trim().replace(/\s+/g, ' ') })));
}));

router.post("/", asyncHandler(async (req, res) => {
  const saved = await resolveOption(pool, "Category", req.body.name);
  res.status(201).json(saved);
}));

module.exports = router;