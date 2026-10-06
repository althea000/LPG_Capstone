const HIDDEN_WAREHOUSE_NAMES = new Set(["san juan branch"]);

export function isVisibleWarehouseName(name) {
  return !HIDDEN_WAREHOUSE_NAMES.has(String(name || "").trim().toLowerCase());
}

export function filterVisibleWarehouses(warehouses) {
  if (!Array.isArray(warehouses)) return [];
  return warehouses.filter((warehouse) => isVisibleWarehouseName(warehouse?.name));
}

