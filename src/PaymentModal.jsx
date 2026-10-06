import React, { useEffect, useState } from "react";
import "./PaymentModal.css";

function formatPeso(amount) {
  return `₱${amount.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// PaymentModal
//
// Props:
// - isOpen: boolean, whether to render the modal
// - totalAmount: number, the amount due
// - onCancel: () => void
// - onConfirm: ({ amountCollected, changeDue, printReceipt }) => void
// ---------------------------------------------------------------------------

export default function PaymentModal({ isOpen, totalAmount, onCancel, onConfirm }) {
  const [amountCollected, setAmountCollected] = useState("");
  const [printReceipt, setPrintReceipt] = useState(false);

  // Reset fields each time the modal is opened for a new transaction
  useEffect(() => {
    if (isOpen) {
      setAmountCollected("");
      setPrintReceipt(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const collected = parseFloat(amountCollected) || 0;
  const changeDue = collected - totalAmount;

  const handleOkay = () => {
    onConfirm({
      amountCollected: collected,
      changeDue,
      printReceipt,
    });
  };

  const canConfirm = collected >= totalAmount && totalAmount > 0;

  return (
    <div className="payment-modal-overlay" onClick={onCancel}>
      <div className="payment-modal" onClick={(e) => e.stopPropagation()}>
        <div className="payment-modal-accent" />
        <h2 className="payment-modal-title">Payment</h2>

        <div className="payment-modal-row">
          <span className="payment-modal-label">Total Amount:</span>
          <span className="payment-modal-value">{formatPeso(totalAmount)}</span>
        </div>

        <div className="payment-modal-row">
          <span className="payment-modal-label">Amount Collected:</span>
          <input
            type="number"
            inputMode="decimal"
            placeholder="Enter amount"
            className="payment-modal-input"
            value={amountCollected}
            onChange={(e) => setAmountCollected(e.target.value)}
            autoFocus
          />
        </div>

        <div className="payment-modal-row">
          <span className="payment-modal-label payment-modal-label-danger">Change Due:</span>
          <span className="payment-modal-value payment-modal-value-danger">
            {formatPeso(Math.max(changeDue, 0))}
          </span>
        </div>

        <label className="payment-modal-checkbox">
          <input
            type="checkbox"
            checked={printReceipt}
            onChange={(e) => setPrintReceipt(e.target.checked)}
          />
          <span>Print Receipt</span>
        </label>

        <div className="payment-modal-actions">
          <button type="button" className="payment-modal-btn cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="payment-modal-btn confirm"
            onClick={handleOkay}
            disabled={!canConfirm}
          >
            Okay
          </button>
        </div>
      </div>
    </div>
  );
}
