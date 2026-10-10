import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  ChevronDown,
  Plus,
  FileText,
  Pencil,
  Trash2,
  Upload,
  X,
  Download,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import AddStockInModal from "./AddStockInModal";
import AddStockOutModal from "./AddStockOutModal";
import AddTransferModal from "./AddTransferModal";
import { apiRequest } from "./api";
import { isVisibleWarehouseName } from "./utils/warehouseFilters";
import "./Inventory.css";

const PAGE_SIZE = 7;

function getStatusClass(status) {
  switch (status) {
    case "Normal":
      return "normal";
    case "Critical":
      return "critical";
    case "Low Stock":
      return "low-stock";
    case "Out of Stock":
      return "out-of-stock";
    default:
      return "";
  }
}

function downloadInventoryCsvTemplate() {
  const template =
    "ProductID,WarehouseID,Quantity,Mode\n" +
    "P-7KF29M3Q,WH-001,50,Set\n" +
    "P-BX6T9R4N,WH-001,10,Add\n";
  const blob = new Blob([template], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "inventory_import_template.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Helper to compute a sliding window of up to 6 page numbers
function getPaginationGroup(currentPage, totalPages, maxVisible = 6) {
  let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let end = start + maxVisible - 1;

  if (end > totalPages) {
    end = totalPages;
    start = Math.max(1, end - maxVisible + 1);
  }

  const pages = [];
  for (let i = start; i <= end; i++) {
    pages.push(i);
  }
  return pages;
}

const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(17, 24, 39, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};

const cardStyle = {
  background: "#ffffff",
  borderRadius: 12,
  padding: "24px 28px",
  width: "100%",
  maxWidth: 420,
  boxShadow: "0 20px 50px rgba(0,0,0,0.2)",
};

function ViewInventoryModal({ item, onClose }) {
  if (!item) return null;
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 800, margin: 0 }}>Inventory Details</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}>
            <X size={20} />
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16, fontSize: "0.9rem" }}>
          <div><strong>Product ID:</strong> {item.productId}</div>
          <div><strong>Product Name:</strong> {item.productName}</div>
          <div><strong>Warehouse:</strong> {item.warehouse}</div>
          <div><strong>Filled / Sellable Stock:</strong> {item.currentStock}</div>
          {!!Number(item.isTank) && <div><strong>Empty Tanks:</strong> {item.emptyStock}</div>}
          <div><strong>Reorder Limit:</strong> {item.reorderLimit}</div>
          <div><strong>Status:</strong> {item.status}</div>
          {item.lastUpdated && <div><strong>Last Updated:</strong> {new Date(item.lastUpdated).toLocaleString()}</div>}
        </div>
        <button
          onClick={onClose}
          style={{
            marginTop: 20, width: "100%", padding: "10px 0", borderRadius: 8, border: "none",
            background: "#e5e7eb", color: "#111827", fontWeight: 700, cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}

function EditInventoryModal({ item, onClose, onSave, isSaving, error }) {
  const [action,setAction]=useState('filled');
  const [quantity,setQuantity]=useState('');
  const [remarks,setRemarks]=useState('');
  useEffect(()=>{
    if(item){setAction('filled');setQuantity(String(item.currentStock));setRemarks('');}
  },[item]);
  if(!item)return null;
  const chooseAction=value=>{
    setAction(value);
    setQuantity(value==='refill'?'':String(value==='set-empty'?item.emptyStock:item.currentStock));
    setRemarks('');
  };
  return <div className="inventory-cylinder-overlay" onClick={()=>{if(!isSaving)onClose();}}>
    <form className="inventory-cylinder-modal" role="dialog" aria-modal="true" aria-labelledby="edit-stock-title" onClick={e=>e.stopPropagation()} onSubmit={e=>{e.preventDefault();if(!isSaving)onSave(item,action,Number(quantity),remarks);}}>
      <h2 id="edit-stock-title">Edit Stock</h2>
      <p>{item.productName} ? {item.warehouse}</p>
      {!!Number(item.isTank) && <>
        <p>Filled: {item.currentStock} ? Empty: {item.emptyStock}</p>
        <label>Stock Action<select autoFocus value={action} onChange={e=>chooseAction(e.target.value)} disabled={isSaving}>
          <option value="filled">Edit Filled Stock</option>
          <option value="set-empty">Edit Empty Stock</option>
          <option value="refill" disabled={!Number(item.emptyStock)}>Refill Empty Tanks</option>
        </select></label>
      </>}
      <label>{action==='refill'?'Tanks to refill':action==='set-empty'?'Counted empty tanks':'New filled / sellable stock quantity'}
        <input autoFocus={!Number(item.isTank)} required type="number" min={action==='refill'?1:0} max={action==='refill'?item.emptyStock:undefined} step="1" value={quantity} disabled={isSaving} onChange={e=>setQuantity(e.target.value)}/>
      </label>
      <label>Remarks{action!=='set-empty'?' (Optional)':''}
        <input required={action==='set-empty'} maxLength={255} value={remarks} disabled={isSaving} onChange={e=>setRemarks(e.target.value)}/>
      </label>
      {error && <p role="alert" style={{color:'#dc2626'}}>{error}</p>}
      <div className="inventory-cylinder-buttons">
        <button type="button" disabled={isSaving} onClick={onClose}>Cancel</button>
        <button type="submit" disabled={isSaving}>{isSaving?'Saving...':action==='refill'?'Refill Tanks':'Save'}</button>
      </div>
    </form>
  </div>;
}

export default function Inventory() {
  const [activeTab, setActiveTab] = useState("inventory");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedWarehouse, setSelectedWarehouse] = useState("All Warehouse");
  const [selectedStatus, setSelectedStatus] = useState("Inventory Status");
  const [selectedTransactionType, setSelectedTransactionType] = useState("All Types");

  const [inventory, setInventory] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [viewItem, setViewItem] = useState(null);
  const [editItem, setEditItem] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [isStockInOpen, setIsStockInOpen] = useState(false);
  const [isStockOutOpen, setIsStockOutOpen] = useState(false);
  const [isTransferOpen, setIsTransferOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef(null);

  // Pagination states initialized to 1
  const [inventoryPage, setInventoryPage] = useState(1);
  const [transactionsPage, setTransactionsPage] = useState(1);

  const loadInventory = () => {
    setIsLoading(true);
    apiRequest("/inventory")
      .then((data) => {
        setInventory(data);
        setLoadError("");
      })
      .catch((err) => setLoadError(err.message || "Failed to load inventory."))
      .finally(() => setIsLoading(false));
  };

  const loadTransactions = () => {
    apiRequest("/inventory/transactions")
      .then((data) => {
        setTransactions(data);
        setTransactionsPage(1);
      })
      .catch((err) => setLoadError(err.message || "Failed to load transactions."));
  };

  useEffect(() => {
    loadInventory();
    loadTransactions();
  }, []);

  const warehouseOptions = useMemo(
    () => [
      "All Warehouse",
      ...new Set(inventory.map((i) => i.warehouse).filter((warehouse) => warehouse && isVisibleWarehouseName(warehouse))),
    ],
    [inventory]
  );

  const filteredInventory = useMemo(() => {
    return inventory.filter((item) => {
      const matchesSearch =
        !searchQuery ||
        item.productName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(item.productId).toLowerCase().includes(searchQuery.toLowerCase());
      const matchesWarehouse = selectedWarehouse === "All Warehouse" || item.warehouse === selectedWarehouse;
      const matchesStatus = selectedStatus === "Inventory Status" || item.status === selectedStatus;
      return matchesSearch && matchesWarehouse && matchesStatus;
    });
  }, [inventory, searchQuery, selectedWarehouse, selectedStatus]);

  // Inventory Pagination Calculations
  const inventoryTotalPages = Math.max(1, Math.ceil(filteredInventory.length / PAGE_SIZE));
  const inventoryCurrentPage = Math.min(inventoryPage, inventoryTotalPages);
  const paginatedInventory = useMemo(() => {
    return filteredInventory.slice(
      (inventoryCurrentPage - 1) * PAGE_SIZE,
      inventoryCurrentPage * PAGE_SIZE
    );
  }, [filteredInventory, inventoryCurrentPage]);

  const goToInventoryPage = (p) => {
    if (p < 1 || p > inventoryTotalPages) return;
    setInventoryPage(p);
  };

  // Transactions Pagination Calculations
  const transactionTypeOptions = useMemo(() => {
    const options = ["All Types"];
    const dbTypes = Array.from(new Set(transactions.map((tx) => tx.type).filter(Boolean)));
    const hasTransfer = transactions.some(
      (tx) => String(tx.reason || "").toLowerCase() === "transfer"
    );

    if (dbTypes.includes("Stock In")) options.push("Stock In");
    if (dbTypes.includes("Stock Out")) options.push("Stock Out");

    for (const type of dbTypes) {
      if (type !== "Stock In" && type !== "Stock Out") {
        options.push(type);
      }
    }

    if (hasTransfer) options.push("Transfer");
    return options;
  }, [transactions]);

  const filteredTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      if (selectedTransactionType === "All Types") return true;

      const isTransfer = String(tx.reason || "").toLowerCase() === "transfer";
      if (selectedTransactionType === "Transfer") return isTransfer;

      return tx.type === selectedTransactionType && !isTransfer;
    });
  }, [transactions, selectedTransactionType]);

  const transactionsTotalPages = Math.max(1, Math.ceil(filteredTransactions.length / PAGE_SIZE));
  const transactionsCurrentPage = Math.min(transactionsPage, transactionsTotalPages);
  const paginatedTransactions = useMemo(() => {
    return filteredTransactions.slice(
      (transactionsCurrentPage - 1) * PAGE_SIZE,
      transactionsCurrentPage * PAGE_SIZE
    );
  }, [filteredTransactions, transactionsCurrentPage]);

  const goToTransactionsPage = (p) => {
    if (p < 1 || p > transactionsTotalPages) return;
    setTransactionsPage(p);
  };

  const counts = useMemo(() => {
    return inventory.reduce(
      (acc, item) => {
        if (item.status === "Out of Stock") acc.outOfStock += 1;
        else if (item.status === "Critical") acc.critical += 1;
        else if (item.status === "Low Stock") acc.low += 1;
        else acc.normal += 1;
        return acc;
      },
      { outOfStock: 0, critical: 0, low: 0, normal: 0 }
    );
  }, [inventory]);

  const handleSaveEdit = async (item, action, newQuantity, remarks) => {
    setIsSaving(true);
    setActionError("");
    try {
      const result=await apiRequest(`/inventory/${item.inventoryId}${action==='filled'?'':'/cylinders'}`, {
        method: action==='filled'?'PUT':'POST',
        body: JSON.stringify(action==='filled'?{newQuantity,remarks}:{action,quantity:newQuantity,remarks,expectedEmptyStock:item.emptyStock}),
      });
      setActionMessage(result.message || 'Stock updated.');
      setEditItem(null);
      loadInventory();
      loadTransactions();
    } catch (err) {
      setActionError(err.message || "Failed to update inventory.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (item) => {
    const confirmed = window.confirm(
      `Delete the inventory record for "${item.productName}" at ${item.warehouse}? This can't be undone.`
    );
    if (!confirmed) return;

    setActionError("");
    try {
      await apiRequest(`/inventory/${item.inventoryId}`, { method: "DELETE" });
      loadInventory();
      loadTransactions();
    } catch (err) {
      if (err.status === 409 || /transaction\(s\) in its history/.test(err.message || "")) {
        const forceConfirmed = window.confirm(
          `${err.message}\n\nForce-delete this record AND its transaction history now?`
        );
        if (!forceConfirmed) return;

        try {
          await apiRequest(`/inventory/${item.inventoryId}?force=true`, { method: "DELETE" });
          loadInventory();
          loadTransactions();
        } catch (forceErr) {
          setActionError(forceErr.message || "Failed to force-delete inventory record.");
        }
        return;
      }

      setActionError(err.message || "Failed to delete inventory record.");
    }
  };

  const handleImportClick = () => {
    setActionError("");
    setActionMessage("");
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setIsImporting(true);
    setActionError("");
    setActionMessage("");
    try {
      const csvText = await file.text();
      const result = await apiRequest("/inventory/import", {
        method: "POST",
        body: JSON.stringify({ csvText, fileName: file.name }),
      });
      setActionMessage(
        `Imported ${result.imported} row(s).${result.skipped ? ` ${result.skipped} row(s) skipped — check console for details.` : ""}`
      );
      if (result.errors?.length) console.warn("Import errors:", result.errors);
      loadInventory();
      loadTransactions();
    } catch (err) {
      setActionError(err.message || "Failed to import inventory CSV.");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="inventory-page">
      <div className="inventory-inner">
        <h1 className="inventory-title">Inventory</h1>

        {actionError && (
          <p style={{ color: "#dc2626", fontWeight: 600, margin: 0 }}>{actionError}</p>
        )}
        {actionMessage && (
          <p style={{ color: "#16a34a", fontWeight: 600, margin: 0 }}>{actionMessage}</p>
        )}
        {loadError && (
          <p style={{ color: "#dc2626", fontWeight: 600, margin: 0 }}>{loadError}</p>
        )}

        {/* Metric Cards */}
        <div className="inventory-cards-grid">
          <div className="inventory-card">
            <div className="inventory-card-label">Out of Stock Items</div>
            <div className="inventory-card-value">{counts.outOfStock}</div>
          </div>
          <div className="inventory-card">
            <div className="inventory-card-label">Critical Items</div>
            <div className="inventory-card-value">{counts.critical}</div>
          </div>
          <div className="inventory-card">
            <div className="inventory-card-label">Low Stock Items</div>
            <div className="inventory-card-value">{counts.low}</div>
          </div>
          <div className="inventory-card">
            <div className="inventory-card-label">Normal Items</div>
            <div className="inventory-card-value">{counts.normal}</div>
          </div>
        </div>

        {/* Tabs & Action Buttons */}
        <div className="inventory-tabs-action-bar">
          <div className="inventory-tabs">
            <button
              className={`inventory-tab ${activeTab === "inventory" ? "active" : ""}`}
              onClick={() => {
                setActiveTab("inventory");
                setInventoryPage(1);
              }}
            >
              Inventory
            </button>
            <button
              className={`inventory-tab ${activeTab === "transactions" ? "active" : ""}`}
              onClick={() => {
                setActiveTab("transactions");
                setTransactionsPage(1);
              }}
            >
              Inventory Transactions
            </button>
          </div>

          <div className="inventory-actions">
            <button className="action-btn" onClick={downloadInventoryCsvTemplate} style={{ background: "#6b7280" }}>
              <Download size={16} /> CSV Template
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              style={{ display: "none" }}
              onChange={handleFileSelected}
            />
            <button className="action-btn" onClick={handleImportClick} disabled={isImporting}>
              <Upload size={16} /> {isImporting ? "Importing…" : "Import Inventory Data"}
            </button>
            <button className="action-btn" onClick={() => setIsStockInOpen(true)}>
              <Plus size={16} /> Add Stock In
            </button>
            <button className="action-btn" onClick={() => setIsStockOutOpen(true)}>
              <Plus size={16} /> Add Stock Out
            </button>
            <button className="action-btn" onClick={() => setIsTransferOpen(true)}>
              <Plus size={16} /> Transfer
            </button>
          </div>
        </div>

        {/* Search & Filters Toolbar */}
        {activeTab === "inventory" && (
          <div className="inventory-toolbar">
            <div className="inventory-search">
              <input
                type="text"
                placeholder="Search Inventory by Product"
                className="inventory-search-input"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setInventoryPage(1);
                }}
              />
              <Search size={16} className="inventory-search-icon" />
            </div>

            <div className="inventory-select-wrap">
              <select
                className="inventory-select"
                value={selectedWarehouse}
                onChange={(e) => {
                  setSelectedWarehouse(e.target.value);
                  setInventoryPage(1);
                }}
              >
                {warehouseOptions.map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
              <ChevronDown size={16} className="inventory-select-icon" />
            </div>

            <div className="inventory-select-wrap">
              <select
                className="inventory-select"
                value={selectedStatus}
                onChange={(e) => {
                  setSelectedStatus(e.target.value);
                  setInventoryPage(1);
                }}
              >
                <option value="Inventory Status">Inventory Status</option>
                <option value="Normal">Normal</option>
                <option value="Critical">Critical</option>
                <option value="Low Stock">Low Stock</option>
                <option value="Out of Stock">Out of Stock</option>
              </select>
              <ChevronDown size={16} className="inventory-select-icon" />
            </div>
          </div>
        )}

        {activeTab === "transactions" && (
          <div className="inventory-toolbar">
            <div className="inventory-select-wrap">
              <select
                className="inventory-select"
                value={selectedTransactionType}
                onChange={(e) => {
                  setSelectedTransactionType(e.target.value);
                  setTransactionsPage(1);
                }}
              >
                {transactionTypeOptions.map((typeOption) => (
                  <option key={typeOption} value={typeOption}>{typeOption}</option>
                ))}
              </select>
              <ChevronDown size={16} className="inventory-select-icon" />
            </div>
          </div>
        )}

        {/* Table View Conditional Rendering */}
        <div className="inventory-table-wrap">
          {activeTab === "inventory" ? (
            <>
              <table className="inventory-table">
                <thead>
                  <tr>
                    <th>Product ID</th>
                    <th>Product Name</th>
                    <th>Warehouse</th>
                    <th>Filled / Sellable Stock</th>
                    <th>Empty Tanks</th>
                    <th>Reorder Limit</th>
                    <th>Status</th>
                    <th>Stock Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && (
                    <tr><td colSpan={8} style={{ textAlign: "center", padding: 24 }}>Loading…</td></tr>
                  )}
                  {!isLoading && filteredInventory.length === 0 && (
                    <tr><td colSpan={8} style={{ textAlign: "center", padding: 24 }}>No inventory records found.</td></tr>
                  )}
                  {!isLoading &&
                    paginatedInventory.map((item) => (
                      <tr key={item.inventoryId}>
                        <td>{item.productId}</td>
                        <td>{item.productName}</td>
                        <td>{item.warehouse}</td>
                        <td>{item.currentStock}</td>
                        <td>{Number(item.isTank)?item.emptyStock:'—'}</td>
                        <td>{item.reorderLimit}</td>
                        <td>
                          <span className={`inventory-status-pill ${getStatusClass(item.status)}`}>
                            {item.status}
                          </span>
                        </td>
                        <td>
                          <div className="inventory-action-icons">
                            <button
                              className="inventory-action-icon view"
                              title="View"
                              onClick={() => setViewItem(item)}
                            >
                              <FileText size={16} />
                            </button>
                            <button
                              className="inventory-action-icon edit"
                              title="Edit"
                              onClick={() => {setActionError('');setEditItem(item);}}
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              className="inventory-action-icon delete"
                              title="Delete"
                              onClick={() => handleDelete(item)}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>

              {/* Inventory Pagination (Sliding up to 6 pages) */}
              <div className="users-pagination" style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <button
                  type="button"
                  className="page-btn"
                  onClick={() => goToInventoryPage(inventoryCurrentPage - 1)}
                  disabled={inventoryCurrentPage === 1}
                  aria-label="Previous page"
                  style={{ borderRadius: "8px", padding: "8px 12px", border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}
                >
                  <ChevronLeft size={16} />
                </button>

                {getPaginationGroup(inventoryCurrentPage, inventoryTotalPages, 6).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`page-btn ${p === inventoryCurrentPage ? "active" : ""}`}
                    onClick={() => goToInventoryPage(p)}
                    style={{
                      borderRadius: "8px",
                      padding: "8px 14px",
                      border: "1px solid #d1d5db",
                      background: p === inventoryCurrentPage ? "#1e3a8a" : "#fff",
                      color: p === inventoryCurrentPage ? "#fff" : "#1f2937",
                      fontWeight: "600",
                      cursor: "pointer",
                    }}
                  >
                    {p}
                  </button>
                ))}

                <button
                  type="button"
                  className="page-btn"
                  onClick={() => goToInventoryPage(inventoryCurrentPage + 1)}
                  disabled={inventoryCurrentPage === inventoryTotalPages}
                  aria-label="Next page"
                  style={{ borderRadius: "8px", padding: "8px 12px", border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </>
          ) : (
            <>
              <table className="inventory-table transactions-table">
                <thead>
                  <tr>
                    <th>Transaction ID</th>
                    <th>Product ID</th>
                    <th>Product Name</th>
                    <th>Warehouse</th>
                    <th>Type</th>
                    <th>Quantity</th>
                    <th>Reference</th>
                    <th>Date</th>
                    <th>User</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedTransactions.length === 0 && (
                    <tr><td colSpan={9} style={{ textAlign: "center", padding: 24 }}>No transactions yet.</td></tr>
                  )}
                  {paginatedTransactions.map((tx) => (
                    <tr key={tx.transactionId}>
                      <td>{tx.transactionId}</td>
                      <td>{tx.productId}</td>
                      <td>{tx.productName}</td>
                      <td>{tx.warehouse}</td>
                      <td>{String(tx.reason || "").toLowerCase() === "transfer" ? "Transfer" : tx.type}</td>
                      <td>{tx.quantity}</td>
                      <td>{tx.reference || "—"}</td>
                      <td>{new Date(tx.date).toLocaleString()}</td>
                      <td>{tx.user}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Transactions Pagination (Sliding up to 6 pages) */}
              <div className="users-pagination" style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <button
                  type="button"
                  className="page-btn"
                  onClick={() => goToTransactionsPage(transactionsCurrentPage - 1)}
                  disabled={transactionsCurrentPage === 1}
                  aria-label="Previous page"
                  style={{ borderRadius: "8px", padding: "8px 12px", border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}
                >
                  <ChevronLeft size={16} />
                </button>

                {getPaginationGroup(transactionsCurrentPage, transactionsTotalPages, 6).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`page-btn ${p === transactionsCurrentPage ? "active" : ""}`}
                    onClick={() => goToTransactionsPage(p)}
                    style={{
                      borderRadius: "8px",
                      padding: "8px 14px",
                      border: "1px solid #d1d5db",
                      background: p === transactionsCurrentPage ? "#1e3a8a" : "#fff",
                      color: p === transactionsCurrentPage ? "#fff" : "#1f2937",
                      fontWeight: "600",
                      cursor: "pointer",
                    }}
                  >
                    {p}
                  </button>
                ))}

                <button
                  type="button"
                  className="page-btn"
                  onClick={() => goToTransactionsPage(transactionsCurrentPage + 1)}
                  disabled={transactionsCurrentPage === transactionsTotalPages}
                  aria-label="Next page"
                  style={{ borderRadius: "8px", padding: "8px 12px", border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* View / Edit Modals */}
      <ViewInventoryModal item={viewItem} onClose={() => setViewItem(null)} />
      <EditInventoryModal
        item={editItem}
        onClose={() => {setEditItem(null);setActionError('');}}
        error={actionError}
        onSave={handleSaveEdit}
        isSaving={isSaving}
      />

      {/* Stock In / Out Modals */}
      <AddStockInModal
        isOpen={isStockInOpen}
        onClose={() => setIsStockInOpen(false)}
        onSuccess={() => {
          loadInventory();
          loadTransactions();
        }}
      />
      <AddStockOutModal
        isOpen={isStockOutOpen}
        onClose={() => setIsStockOutOpen(false)}
        onSuccess={() => {
          loadInventory();
          loadTransactions();
        }}
      />
      <AddTransferModal
        isOpen={isTransferOpen}
        onClose={() => setIsTransferOpen(false)}
        onSuccess={() => {
          loadInventory();
          loadTransactions();
        }}
      />
    </div>
  );
}
