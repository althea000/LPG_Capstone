const crypto = require('crypto');
const ApiError = require('./apiError');
function normalizeOption(value) {
  const clean = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!/[\p{L}\p{N}]/u.test(clean) || /^other$/i.test(clean) || clean.length > 100) throw new ApiError(400, 'Enter a valid brand/category (up to 100 characters); Other is reserved.');
  return clean.toLowerCase().replace(/\b\p{L}+/gu, word => ['lpg', 'pvc', 'pol', 'tpa'].includes(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1));
}
async function resolveOption(conn, table, value) {
  const name = normalizeOption(value);
  const column = table === 'Brand' ? 'Brand' : 'Category';
  const idColumn = `${table}ID`;
  const [rows] = await conn.query(`SELECT ${idColumn} AS id, ${column} AS name FROM ${table}`);
  const match = rows.find(row => String(row.name).trim().replace(/\s+/g, ' ').toLowerCase() === name.toLowerCase());
  if (match) return { id: match.id, name: match.name };
  const id = `${table === 'Brand' ? 'BD' : 'CTGRY'}-${crypto.randomBytes(6).toString('hex')}`;
  await conn.query(`INSERT INTO ${table} (${idColumn}, ${column}) VALUES (:id,:name) ON DUPLICATE KEY UPDATE ${idColumn} = ${idColumn}`, { id, name });
  const [saved] = await conn.query(`SELECT ${idColumn} AS id, ${column} AS name FROM ${table} WHERE ${column} = :name`, { name });
  return saved[0];
}
function validateUnit(body) {
  if (body.unit === undefined && body.unitValue === undefined) return;
  if (!['kg', 'meter', 'piece'].includes(body.unit)) throw new ApiError(400, 'Unit must be kg, meter or piece.');
  const value = body.unit === 'piece' ? 1 : Number(body.unitValue);
  if (!Number.isFinite(value) || value <= 0 || value > 999999999.9 || Math.abs(value * 10 - Math.round(value * 10)) > 1e-6) throw new ApiError(400, 'Capacity/length must be positive with at most one decimal place.');
  body.unitValue = value;
}
module.exports = { normalizeOption, resolveOption, validateUnit };
