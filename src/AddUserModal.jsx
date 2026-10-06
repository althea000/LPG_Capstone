import React, { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import "./AddUserModal.css";
import { apiRequest } from "./api";
import { buildModulesByRole } from "./rbac";

const moduleOptions = [
  { key: "dashboard", label: "Dashboard" },
  { key: "pos", label: "POS Terminal" },
  { key: "inventory", label: "Inventory" },
  { key: "products", label: "Products" },
  { key: "sales", label: "Sales" },
  { key: "restocking", label: "Restocking" },
  { key: "orders", label: "Order and Delivery" },
  { key: "suppliers", label: "Suppliers" },
  { key: "report", label: "Report and Compliance" },
  { key: "data", label: "Data" },
  { key: "users", label: "Users" },
  { key: "settings", label: "Settings" },
];

const statusOptions = ["Active", "Inactive"];

const emptyForm = {
  fullName: "",
  usernameEmail: "",
  password: "",
  confirmPassword: "",
  role: "",
  branch: "",
  status: "Active",
  modules: {},
};

export default function AddUserModal({ isOpen, onCancel, onSaved, selectedUser }) {
  const [roles, setRoles] = useState([]);
  const [branches, setBranches] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isEditing = Boolean(selectedUser);

  useEffect(() => {
    if (!isOpen) return;
    setError("");
    Promise.all([apiRequest("/roles"), apiRequest("/warehouses")])
      .then(([roleData, warehouseData]) => {
        setRoles(Array.isArray(roleData) ? roleData : []);
        setBranches(Array.isArray(warehouseData) ? warehouseData : []);
      })
      .catch((err) => setError(err.message || "Failed to load roles/branches."));
  }, [isOpen]);

  useEffect(() => {
    if (selectedUser) {
      setForm({
        fullName: selectedUser.name || "",
        usernameEmail: selectedUser.email || "",
        password: "",
        confirmPassword: "",
        role: selectedUser.role || "",
        branch: selectedUser.branch || "",
        status: selectedUser.status || "Active",
        modules: selectedUser.moduleAccess || { dashboard: true },
      });
    } else {
      setForm(emptyForm);
    }
    setError("");
  }, [selectedUser, isOpen]);

  useEffect(() => {
    if (!form.role) return;
    setForm((prev) => ({ ...prev, modules: buildModulesByRole(form.role) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.role]);

  if (!isOpen) return null;

  const updateField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));
  const resetAndClose = () => {
    setForm(emptyForm);
    setError("");
    onCancel();
  };

  const handleSave = async () => {
    if (!form.fullName || !form.usernameEmail) {
      setError("Full name and username/email are required.");
      return;
    }
    if (!isEditing) {
      if (!form.password || !form.confirmPassword) {
        setError("Password and confirm password are required for a new user.");
        return;
      }
    }
    if (form.password && form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (!form.role || !form.branch) {
      setError("Please select a role and branch/warehouse.");
      return;
    }

    if (!roles.length || !branches.length) {
      setError("Roles/branches are still loading. Please wait and try again.");
      return;
    }

    setError("");
    setIsSubmitting(true);
    try {
      if (isEditing) {
        const payload = {
          fullName: form.fullName,
          role: form.role,
          branch: form.branch,
          status: form.status,
          modules: buildModulesByRole(form.role),
        };
        if (form.password) payload.password = form.password;
        await apiRequest(`/users/${selectedUser.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      } else {
        await apiRequest("/users", {
          method: "POST",
          body: JSON.stringify({
            fullName: form.fullName,
            usernameEmail: form.usernameEmail,
            password: form.password,
            role: form.role,
            branch: form.branch,
            status: form.status,
            modules: buildModulesByRole(form.role),
          }),
        });
      }
      onSaved?.();
      setForm(emptyForm);
      onCancel();
    } catch (err) {
      setError(err.message || "Failed to save user.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="add-user-overlay" onClick={resetAndClose}>
      <div className="add-user-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="add-user-title">{isEditing ? "Edit User" : "New User Information"}</h2>

        {error && <p style={{ color: "#dc2626", fontWeight: 600, marginTop: -8, marginBottom: 12 }}>{error}</p>}

        {/* Basic Information */}
        <h3 className="add-user-section">BASIC INFORMATION</h3>
        <div className="add-user-grid three-col">
          <div className="field">
            <label className="field-label">Full Name</label>
            <input
              type="text"
              placeholder="ABC Company"
              className="field-input"
              value={form.fullName}
              onChange={(e) => updateField("fullName", e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">Username / Email Address</label>
            <input
              type="text"
              placeholder="killianjulian@gmail.com"
              className="field-input"
              value={form.usernameEmail}
              onChange={(e) => updateField("usernameEmail", e.target.value)}
              disabled={isEditing}
            />
          </div>
          <div className="field">
            <label className="field-label">{isEditing ? "New Password (optional)" : "Password"}</label>
            <input
              type="password"
              placeholder="â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢"
              className="field-input"
              value={form.password}
              onChange={(e) => updateField("password", e.target.value)}
            />
          </div>
        </div>

        <div className="add-user-grid three-col">
          <div className="field">
            <label className="field-label">{isEditing ? "Confirm New Password" : "Confirm Password"}</label>
            <input
              type="password"
              placeholder="â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢"
              className="field-input"
              value={form.confirmPassword}
              onChange={(e) => updateField("confirmPassword", e.target.value)}
            />
          </div>
        </div>

        {/* Role & Assignment */}
        <h3 className="add-user-section">Role &amp; Assignment</h3>
        {!roles.length || !branches.length ? (
          <p style={{ color: "#6b7280", marginTop: 0 }}>Loading roles and branchesÃ¢â‚¬Â¦</p>
        ) : null}
        <div className="add-user-grid three-col">
          <div className="field">
            <label className="field-label">Role</label>
            <div className="select-wrap">
              <select
                className="field-select"
                value={form.role}
                onChange={(e) => updateField("role", e.target.value)}
              >
                <option value="">Select role</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.name}>{r.name}</option>
                ))}
              </select>
              <ChevronDown size={16} className="select-icon" />
            </div>
          </div>
          <div className="field">
            <label className="field-label">Branch / Warehouse</label>
            <div className="select-wrap">
              <select
                className="field-select"
                value={form.branch}
                onChange={(e) => updateField("branch", e.target.value)}
              >
                <option value="">Select Branch / Warehouse</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.name}>{b.name}</option>
                ))}
              </select>
              <ChevronDown size={16} className="select-icon" />
            </div>
          </div>
          <div className="field">
            <label className="field-label">Status</label>
            <div className="select-wrap">
              <select
                className="field-select"
                value={form.status}
                onChange={(e) => updateField("status", e.target.value)}
              >
                {statusOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <ChevronDown size={16} className="select-icon" />
            </div>
          </div>
        </div>

        {/* Module Access */}
        <h3 className="add-user-section">Module Access</h3>
        <div className="module-list">
          {moduleOptions.map(({ key, label }) => (
            <label key={key} className="module-checkbox">
              <input
                type="checkbox"
                checked={!!form.modules[key]}
                readOnly
                disabled
              />
              <span className="module-box" />
              <span>{label}</span>
            </label>
          ))}
        </div>

        {/* Actions */}
        <div className="add-user-actions">
          <button type="button" className="add-user-btn cancel" onClick={resetAndClose}>
            Cancel
          </button>
          <button type="button" className="add-user-btn save" onClick={handleSave} disabled={isSubmitting}>
            {isSubmitting ? "Savingâ€¦" : isEditing ? "Save Changes" : "Save User"}
          </button>
        </div>
      </div>
    </div>
  );
}

