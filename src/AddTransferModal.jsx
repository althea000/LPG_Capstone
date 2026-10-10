import React, { useEffect, useMemo, useState } from "react";
import { apiRequest } from "./api";
import { filterVisibleWarehouses } from "./utils/warehouseFilters";
import "./AddStockOutModal.css";

const TRANSFER_STATUS = ["Completed", "In Transit", "Pending"];

export default function AddTransferModal({ isOpen, onClose, onSuccess }) {
  const [warehouses, setWarehouses] = useState([]);
  const [inventory, setInventory] = useState([]);

  const [fromWarehouseId, setFromWarehouseId] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [stockType,setStockType]=useState("filled");
  const [status, setStatus] = useState("Completed");
  const [remarks, setRemarks] = useState("");
  const [items, setItems] = useState([{ productId: "", quantity: "" }]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const loadModalData = async () => {
    const [warehouseRows, inventoryRows] = await Promise.all([
      apiRequest("/warehouses"),
      apiRequest("/inventory"),
    ]);

    const activeWarehouses = filterVisibleWarehouses(
      Array.isArray(warehouseRows)
        ? warehouseRows.filter((w) => String(w.status || "Active") === "Active")
        : []
    );

    setWarehouses(activeWarehouses);
    setInventory(Array.isArray(inventoryRows) ? inventoryRows : []);

    const firstWarehouseId = activeWarehouses[0]?.id || "";
    const secondWarehouseId = activeWarehouses[1]?.id || activeWarehouses[0]?.id || "";
    setFromWarehouseId((prev) => prev || firstWarehouseId);
    setToWarehouseId((prev) => prev || secondWarehouseId);
  };

  useEffect(() => {
    if (!isOpen) return;
    setError("");
    loadModalData().catch((err) => setError(err.message || "Failed to load transfer data."));
  }, [isOpen]);

  const sourceInventory = useMemo(
    () =>
      inventory.filter(
        (row) => row.warehouseId === fromWarehouseId && (stockType!=="empty" || Number(row.isTank)) && Number(stockType==="empty"?row.emptyStock:row.currentStock) > 0
      ),
    [inventory, fromWarehouseId, stockType]
  );

  const sourceProductMap = useMemo(() => {
    const map = new Map();
    for (const row of sourceInventory) {
      map.set(row.productId, {
        productId: row.productId,
        productName: row.productName,
        currentStock: Number(stockType==="empty"?row.emptyStock:row.currentStock),
      });
    }
    return map;
  }, [sourceInventory, stockType]);

  const updateItem = (index, field, value) => {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  };

  const addItemRow = () => setItems((prev) => [...prev, { productId: "", quantity: "" }]);
  const removeItemRow = (index) => setItems((prev) => prev.filter((_, i) => i !== index));

  const validItems = items
    .filter((item) => item.productId && Number(item.quantity) > 0)
    .map((item) => ({
      productId: String(item.productId).trim(),
      quantity: Number(item.quantity),
    }));

  const resetAndClose = () => {
    setItems([{ productId: "", quantity: "" }]);
    setRemarks("");
    setStatus("Completed");
    setStockType("filled");
    setError("");
    onClose();
  };

  const handleSubmit = async () => {
    if (!fromWarehouseId || !toWarehouseId) {
      return setError("Please select source and destination warehouse.");
    }
    if (fromWarehouseId === toWarehouseId) {
      return setError("Source and destination warehouses must be different.");
    }
    if (!validItems.length) {
      return setError("Add at least one product with quantity.");
    }

    for (const item of validItems) {
      const source = sourceProductMap.get(item.productId);
      if (!source) {
        return setError(`Product ${item.productId} is not available in selected source warehouse.`);
      }
      if (item.quantity > source.currentStock) {
        return setError(
          `Cannot transfer ${item.quantity} of ${source.productName}. Available stock: ${source.currentStock}.`
        );
      }
    }

    setIsSubmitting(true);
    setError("");

    try {
      await apiRequest("/inventory/transfer", {
        method: "POST",
        body: JSON.stringify({
          fromWarehouseId,
          stockType,
          toWarehouseId,
          status,
          remarks: remarks || null,
          items: validItems,
        }),
      });

      await loadModalData();
      onSuccess?.();
      setItems([{ productId: "", quantity: "" }]);
      setRemarks("");
      setStatus("Completed");
    } catch (err) {
      setError(err.message || "Failed to create transfer.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={resetAndClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Warehouse Transfer</h2>

        {error && <p style={{ color: "#dc2626", fontWeight: 600, marginTop: -8 }}>{error}</p>}

        <div className="form-grid">
          <div className="form-row">
            <label className="form-label" htmlFor="transfer-stock-type">Stock Type</label>
            <span className="form-colon">:</span>
            <select id="transfer-stock-type" className="form-select" value={stockType} onChange={e=>{setStockType(e.target.value);setItems([{productId:'',quantity:''}]);}}>
              <option value="filled">Filled / Sellable Stock</option>
              <option value="empty">Empty Tanks</option>
            </select>
          </div>
          <div className="form-row">
            <span className="form-label">From Warehouse</span>
            <span className="form-colon">:</span>
            <select
              className="form-select"
              value={fromWarehouseId}
              onChange={(e) => setFromWarehouseId(e.target.value)}
            >
              <option value="" disabled>Select warehouse</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <span className="form-label">To Warehouse</span>
            <span className="form-colon">:</span>
            <select className="form-select" value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
              <option value="" disabled>Select warehouse</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <span className="form-label">Status</span>
            <span className="form-colon">:</span>
            <select className="form-select" value={status} onChange={(e) => setStatus(e.target.value)}>
              {TRANSFER_STATUS.map((itemStatus) => (
                <option key={itemStatus} value={itemStatus}>{itemStatus}</option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <span className="form-label">Remarks</span>
            <span className="form-colon">:</span>
            <input
              type="text"
              className="form-input"
              placeholder="Optional notes"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>
        </div>

        <div className="items-section-header">
          <h3 className="items-title">Transfer Items</h3>
          <button type="button" className="btn-add-item" onClick={addItemRow}>Add Item</button>
        </div>

        <div className="modal-table-wrap">
          <table className="modal-table">
            <thead>
              <tr>
                <th className="text-center">#</th>
                <th>Product</th>
                <th className="text-center">Qty</th>
                <th className="text-center">Available</th>
                <th className="text-center"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const sourceProduct = sourceProductMap.get(item.productId);
                return (
                  <tr key={index}>
                    <td className="text-center">{index + 1}</td>
                    <td>
                      <select
                        value={item.productId}
                        onChange={(e) => updateItem(index, "productId", e.target.value)}
                        style={{ width: "100%", padding: "6px 8px" }}
                      >
                        <option value="">Select product</option>
                        {Array.from(sourceProductMap.values()).map((product) => (
                          <option key={product.productId} value={product.productId}>
                            {product.productName}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="text-center">
                      <input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={(e) => updateItem(index, "quantity", e.target.value)}
                        style={{ width: 70, padding: "6px 8px", textAlign: "center" }}
                      />
                    </td>
                    <td className="text-center">{sourceProduct ? sourceProduct.currentStock : "—"}</td>
                    <td className="text-center">
                      <button
                        type="button"
                        onClick={() => removeItemRow(index)}
                        style={{ background: "none", border: "none", color: "#d90429", cursor: "pointer", fontWeight: 700 }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-cancel" onClick={resetAndClose}>Close</button>
          <button type="button" className="btn-approved" onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Create Transfer"}
          </button>
        </div>
      </div>
    </div>
  );
}




