export const MODULE_KEYS = {
  dashboard: "dashboard",
  pos: "pos",
  inventory: "inventory",
  products: "products",
  sales: "sales",
  restocking: "restocking",
  orders: "orders",
  suppliers: "suppliers",
  report: "report",
  data: "data",
  users: "users",
  settings: "settings",
};

export function canonicalRole(roleName) {
  const role = String(roleName || "").trim().toLowerCase();
  if (!role) return "";
  if (role === "admin") return "administrator";
  return role;
}

const ROLE_ACCESS = {
  administrator: [
    MODULE_KEYS.dashboard,
    MODULE_KEYS.pos,
    MODULE_KEYS.inventory,
    MODULE_KEYS.products,
    MODULE_KEYS.sales,
    MODULE_KEYS.restocking,
    MODULE_KEYS.orders,
    MODULE_KEYS.suppliers,
    MODULE_KEYS.report,
    MODULE_KEYS.data,
    MODULE_KEYS.users,
    MODULE_KEYS.settings,
  ],
  "operations supervisor": [
    MODULE_KEYS.orders,
    MODULE_KEYS.dashboard,
    MODULE_KEYS.inventory,
    MODULE_KEYS.products,
    MODULE_KEYS.sales,
    MODULE_KEYS.restocking,
    MODULE_KEYS.suppliers,
    MODULE_KEYS.report,
    MODULE_KEYS.data,
    MODULE_KEYS.users,
    MODULE_KEYS.settings,
  ],
  "assistant operations supervisor": [
    MODULE_KEYS.dashboard,
    MODULE_KEYS.inventory,
    MODULE_KEYS.products,
    MODULE_KEYS.sales,
    MODULE_KEYS.restocking,
    MODULE_KEYS.suppliers,
    MODULE_KEYS.report,
    MODULE_KEYS.data,
  ],
  "store supervisor": [
    MODULE_KEYS.dashboard,
    MODULE_KEYS.pos,
    MODULE_KEYS.inventory,
    MODULE_KEYS.products,
    MODULE_KEYS.sales,
    MODULE_KEYS.orders,
    MODULE_KEYS.report,
    MODULE_KEYS.data,
  ],
  "assistant store supervisor": [
    MODULE_KEYS.dashboard,
    MODULE_KEYS.pos,
    MODULE_KEYS.inventory,
    MODULE_KEYS.products,
    MODULE_KEYS.sales,
    MODULE_KEYS.orders,
  ],
  stockman: [MODULE_KEYS.inventory],
  "head maintenance": [MODULE_KEYS.inventory],
  rider: [MODULE_KEYS.orders],
  driver: [MODULE_KEYS.orders],
  drivers: [MODULE_KEYS.orders],
  helpers: [MODULE_KEYS.orders],
};

export function isRiderRole(role) { return ['rider','driver','drivers'].includes(canonicalRole(role)); }

export function getAllowedNavIdsByRole(roleName) {
  return ROLE_ACCESS[canonicalRole(roleName)] || [];
}

export function buildModulesByRole(roleName) {
  const allowed = new Set(getAllowedNavIdsByRole(roleName));
  return {
    dashboard: allowed.has(MODULE_KEYS.dashboard),
    pos: allowed.has(MODULE_KEYS.pos),
    inventory: allowed.has(MODULE_KEYS.inventory),
    products: allowed.has(MODULE_KEYS.products),
    sales: allowed.has(MODULE_KEYS.sales),
    restocking: allowed.has(MODULE_KEYS.restocking),
    orders: allowed.has(MODULE_KEYS.orders),
    suppliers: allowed.has(MODULE_KEYS.suppliers),
    report: allowed.has(MODULE_KEYS.report),
    data: allowed.has(MODULE_KEYS.data),
    users: allowed.has(MODULE_KEYS.users),
    settings: allowed.has(MODULE_KEYS.settings),
  };
}

