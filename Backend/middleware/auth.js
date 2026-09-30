const jwt = require("jsonwebtoken");
const ApiError = require("../utils/apiError");

function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next(new ApiError(401, "Missing or invalid authorization token"));

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { userId, companyId, roleId, roleName, email }
    next();
  } catch (err) {
    next(new ApiError(401, "Invalid or expired token"));
  }
}

function canonicalRole(role) {
  const raw = String(role || "").trim().toLowerCase();
  if (!raw) return "";

  if (raw === "admin" || raw === "administrator") return "administrator";
  if (raw === "manager" || raw === "operations supervisor") return "operations supervisor";

  return raw;
}

function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return next(new ApiError(401, "Not authenticated"));

    const userRole = canonicalRole(req.user.roleName);
    const allowed = new Set(allowedRoles.map(canonicalRole));

    if (allowedRoles.length && !allowed.has(userRole)) {
      return next(new ApiError(403, "You do not have permission to perform this action"));
    }
    next();
  };
}

module.exports = { authenticate, authorize };