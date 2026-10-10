import React, { useEffect, useState } from "react";
import "./AddProductModal.css";
import { apiRequest } from "./api";

const emptyForm = {
  productName: "",
  categoryId: "",
  brandId: "",
  supplierId: "",
  unit: "piece",
  unitValue: "1.0",
  customBrand: "",
  customCategory: "",
  unitPrice: "",
  costPrice: "",
  reorderLevel: "",
  imageUrl: "",
  arModelUrl: "",
  status: "Active",
  warehouseId: "",
  stock: "",
  stockDirty:false, expectedStock:0,
};

export default function AddProductModal({ isOpen, onClose, onSaved, selectedProduct }) {
  const [categories, setCategories] = useState([]);
  const [brands, setBrands] = useState([]);
  const [warehouses,setWarehouses] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const isEditing = Boolean(selectedProduct);

  useEffect(() => {
    if (!isOpen) return;
    setError("");
    Promise.all([
      apiRequest("/categories"),
      apiRequest("/brands"),
      apiRequest("/suppliers"),
      selectedProduct ? apiRequest(`/products/${selectedProduct.productId}/inventory`) : apiRequest("/warehouses"),
    ])
      .then(([categoryData, brandData, supplierData, warehouseData]) => {
        setWarehouses(warehouseData);
        setCategories(categoryData);
        setBrands(brandData);
        setSuppliers(supplierData);
        if (selectedProduct) setForm(prev => {
          const match = (options, name, id) => options.find(o => o.name.trim().toLowerCase() === String(name || '').trim().toLowerCase()) || options.find(o => o.id === id);
          return { ...prev, categoryId: match(categoryData, selectedProduct.category, selectedProduct.categoryId)?.id || 'Other', brandId: match(brandData, selectedProduct.brand, selectedProduct.brandId)?.id || 'Other' };
        });
      })
      .catch((err) => setError(err.message || "Failed to load categories/brands/suppliers."));
  }, [isOpen, selectedProduct]);

  useEffect(() => {
    if (selectedProduct) {
      setForm({
        productName: selectedProduct.name || "",
        categoryId: selectedProduct.categoryId || "",
        brandId: selectedProduct.brandId || "",
        supplierId: selectedProduct.supplierId || "",
        unit: selectedProduct.unit || "piece",
        unitValue: selectedProduct.unitValue ?? (selectedProduct.unit === "piece" ? "1.0" : ""),
        customBrand: selectedProduct.brand || "",
        customCategory: selectedProduct.category || "",
        unitPrice: selectedProduct.unitPrice ?? "",
        costPrice: selectedProduct.costPrice ?? "",
        reorderLevel: selectedProduct.reorderLevel ?? "",
        imageUrl: selectedProduct.imageUrl || "",
        arModelUrl: selectedProduct.arModelUrl || "",
        status: selectedProduct.status || "Active",
        warehouseId:"", stock:"", stockDirty:false, expectedStock:0,
      });
    } else {
      setForm(emptyForm);
    }
  }, [selectedProduct, isOpen]);

  if (!isOpen) return null;

  const updateField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const resetAndClose = () => {
    setForm(emptyForm);
    setError("");
    onClose();
  };

  const normalize = value => value.trim().replace(/\s+/g, " ").toLowerCase().replace(/\b\p{L}+/gu, word => ['lpg', 'pvc', 'pol', 'tpa'].includes(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1));
  const snapOption = (kind, options) => {
    const value = normalize(form[`custom${kind}`]);
    const match = options.find(o => normalize(o.name).toLowerCase() === value.toLowerCase());
    setForm(prev => ({ ...prev, [`custom${kind}`]: value, ...(match ? { [`${kind.toLowerCase()}Id`]: match.id } : {}) }));
  };
  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!form.productName || !form.categoryId || !form.brandId || !form.supplierId || !form.unit) {
      setError("Product name, category, brand, supplier and unit are all required.");
      return;
    }

    const custom = {};
    for (const kind of ['Brand', 'Category']) {
      if (form[`${kind.toLowerCase()}Id`] !== 'Other') continue;
      const value = normalize(form[`custom${kind}`]);
      if (!/[\p{L}\p{N}]/u.test(value) || /^other$/i.test(value) || value.length > 100) {
        setError(`Specify a valid new ${kind.toLowerCase()} (up to 100 characters). Other is reserved.`); return;
      }
      custom[kind.toLowerCase()] = value;
    }
    const payload = {
      ...custom,
      productName: form.productName,
      categoryId: form.categoryId === "Other" ? undefined : String(form.categoryId),
      brandId: form.brandId === "Other" ? undefined : String(form.brandId),
      supplierId: String(form.supplierId),
      unit: form.unit,
      unitValue: form.unit === "piece" ? 1 : Number(form.unitValue),
      unitPrice: Number(form.unitPrice) || 0,
      costPrice: Number(form.costPrice) || 0,
      reorderLevel: Number(form.reorderLevel) || 0,
      imageUrl: form.imageUrl || null,
      arModelUrl: form.arModelUrl || null,
      status: form.status,
      ...(form.warehouseId && (!isEditing || form.stockDirty) ? {warehouseId:form.warehouseId,stock:Number(form.stock),expectedStock:form.expectedStock} : {}),
    };

    setIsSubmitting(true);
    setError("");
    try {
      if (isEditing) {
        await apiRequest(`/products/${selectedProduct.productId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      } else {
        await apiRequest("/products", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      window.dispatchEvent(new Event("product-options-changed"));
      onSaved?.();
      resetAndClose();
    } catch (err) {
      setError(err.message || "Failed to save product.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="add-product-modal-overlay">
      <div className="add-product-modal-card">
        <h2 className="add-product-title">{isEditing ? "Edit Product" : "Product Information"}</h2>

        {error && (
          <p style={{ color: "#dc2626", fontWeight: 600, margin: "-8px 0 0 0" }}>{error}</p>
        )}

        <form className="add-product-form" onSubmit={handleSubmit}>
          {/* Row 1 */}
          <div className="form-row-2">
            <div className="form-field">
              <label>Product ID</label>
              <input
                type="text"
                value={isEditing ? selectedProduct.productId : "(auto-generated)"}
                disabled
              />
            </div>
            <div className="form-field">
              <label>Product Name</label>
              <input
                type="text"
                placeholder="Name"
                value={form.productName}
                onChange={(e) => updateField("productName", e.target.value)}
              />
            </div>
          </div>

          {/* Row 2 */}
          <div className="form-row-2">
            <div className="form-field">
              <label>Category</label>
              <select
                value={form.categoryId}
                onChange={(e) => updateField("categoryId", e.target.value)}
              >
                <option value="" disabled hidden>Category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
                <option value="Other">Other</option>
              </select>
              {form.categoryId === 'Other' && <><label htmlFor="custom-category">Specify New Category</label><input id="custom-category" required maxLength={100} value={form.customCategory} onChange={e => updateField('customCategory', e.target.value)} onBlur={() => snapOption('Category', categories)} /></>}
            </div>
            <div className="form-field">
              <label>Supplier</label>
              <select
                value={form.supplierId}
                onChange={(e) => updateField("supplierId", e.target.value)}
              >
                <option value="" disabled hidden>Supplier</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Row 2b: Brand */}
          <div className="form-row-2">
            <div className="form-field">
              <label>Brand</label>
              <select
                value={form.brandId}
                onChange={(e) => updateField("brandId", e.target.value)}
              >
                <option value="" disabled hidden>Brand</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
                <option value="Other">Other</option>
              </select>
              {form.brandId === 'Other' && <><label htmlFor="custom-brand">Specify New Brand</label><input id="custom-brand" required maxLength={100} value={form.customBrand} onChange={e => updateField('customBrand', e.target.value)} onBlur={() => snapOption('Brand', brands)} /></>}
            </div>
            <div className="form-field">
              <label>Unit</label>
              <select value={form.unit} onChange={(e) => setForm(prev => ({ ...prev, unit: e.target.value, unitValue: e.target.value === "piece" ? "1.0" : "" }))}>
                <option value="" disabled hidden>Unit</option>
                <option value="kg">Kilogram (kg)</option>
                <option value="meter">Meter (m)</option>
                <option value="piece">Piece (pc)</option>
              </select>
            </div>
          </div>

          {form.unit !== 'piece' && <div className="form-field"><label htmlFor="unit-value">{form.unit === 'kg' ? 'Capacity (kg)' : 'Length (meters)'}</label><input id="unit-value" type="number" required min="0.1" max="999999999.9" step="0.1" value={form.unitValue} onChange={e => updateField('unitValue', e.target.value)} /></div>}
          <div className="form-row-2"><div className="form-field"><label>Stock Warehouse</label><select value={form.warehouseId} onChange={e=>setForm(prev=>({...prev,warehouseId:e.target.value,stock:warehouses.find(w=>w.id===e.target.value)?.stock ?? 0,expectedStock:warehouses.find(w=>w.id===e.target.value)?.stock ?? 0,stockDirty:false}))}><option value="">Select warehouse to adjust stock</option>{warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></div><div className="form-field"><label>Stock On Hand{!form.warehouseId && isEditing ? ' (all warehouses)' : ''}</label><input type="number" min="0" step="1" required={Boolean(form.warehouseId)} disabled={!form.warehouseId} value={form.warehouseId?form.stock:selectedProduct?.stock ?? 0} onChange={e=>setForm(prev=>({...prev,stock:e.target.value,stockDirty:true}))}/></div></div>
          {/* Row 3 */}
          <div className="form-row-3">
            <div className="form-field">
              <label>Unit Price</label>
              <input
                type="number"
                step="0.01"
                placeholder="₱ 0.00"
                value={form.unitPrice}
                onChange={(e) => updateField("unitPrice", e.target.value)}
              />
            </div>
            <div className="form-field">
              <label>Cost Price</label>
              <input
                type="number"
                step="0.01"
                placeholder="₱ 0.00"
                value={form.costPrice}
                onChange={(e) => updateField("costPrice", e.target.value)}
              />
            </div>
            <div className="form-field">
              <label>Reorder Level</label>
              <input
                type="number"
                placeholder="Enter Number"
                value={form.reorderLevel}
                onChange={(e) => updateField("reorderLevel", e.target.value)}
              />
            </div>
          </div>

          {/* Row 4 */}
          <div className="form-row-2">
            <div className="form-field">
              <label>Status</label>
              <select value={form.status} onChange={(e) => updateField("status", e.target.value)}>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </div>
            <div className="form-field">
              <label>Image URL</label>
              <input
                type="text"
                placeholder="gasul-50kg.png or https://example.com/image.png"
                value={form.imageUrl}
                onChange={(e) => updateField("imageUrl", e.target.value)}
              />
              <small className="form-field-hint">Use filename (e.g., gasul-50kg.png) or full https URL.</small>
            </div>
          </div>

          {/* Row 5 */}
          <div className="form-field">
            <label>AR Model URL</label>
            <input
              type="text"
              placeholder="URL link"
              value={form.arModelUrl}
              onChange={(e) => updateField("arModelUrl", e.target.value)}
            />
          </div>

          {/* Actions */}
          <div className="add-product-modal-actions">
            <button type="button" className="btn-modal-cancel" onClick={resetAndClose}>
              Cancel
            </button>
            <button type="submit" className="btn-modal-add" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : isEditing ? "Save" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

