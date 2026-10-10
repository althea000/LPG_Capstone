import { useEffect, useState } from 'react';
import './PaymentModal.css';
import EmptyCylinderReturns from './EmptyCylinderReturns';
export default function PaymentModal({isOpen,totalAmount,paymentMethod,onCancel,onConfirm,busy=false,items=[],orderType}) {
  const [emptyReturns,setEmptyReturns]=useState([]);
  const [cash,setCash]=useState(''),[reference,setReference]=useState(''),[print,setPrint]=useState(false);
  useEffect(()=>{if(isOpen){setCash('');setReference('');setPrint(false);setEmptyReturns([]);}},[isOpen]);
  if(!isOpen)return null;
  const cod=paymentMethod==='Cash on Delivery (COD)',digital=['GCash','Card','Bank Transfer'].includes(paymentMethod);
  const amount=digital?totalAmount:Number(cash),change=Math.max(0,amount-totalAmount);
  const valid=totalAmount>=0 && (cod || (digital?reference.trim().length>0:Number.isFinite(amount)&&cash!==''&&amount>=totalAmount));
  return <div className="payment-modal-overlay"><form className="payment-modal" onSubmit={e=>{e.preventDefault();if(valid&&!busy)onConfirm({amountCollected:cod?undefined:amount,changeDue:cod?0:change,referenceNo:reference.trim(),printReceipt:print,emptyReturns:orderType==='Walk-in'?emptyReturns:[]});}} role="dialog" aria-modal="true" aria-label="Payment">
    <h2 className="payment-modal-title">{cod?'Confirm COD Delivery':'Payment'}</h2>
    <div className="payment-modal-row"><span>Total Amount:</span><strong>₱{totalAmount.toFixed(2)}</strong></div>
    <p>{paymentMethod}</p>
    {digital?<label className="payment-modal-row">Reference No.:<input className="payment-modal-input" required maxLength={50} value={reference} onChange={e=>setReference(e.target.value)} autoFocus/></label>:cod?<p>Amount to collect on delivery: ₱{totalAmount.toFixed(2)}</p>:<><label className="payment-modal-row">Amount Collected:<input className="payment-modal-input" type="number" min={totalAmount} step="0.01" required value={cash} onChange={e=>setCash(e.target.value)} autoFocus/></label><div className="payment-modal-row"><span>Change:</span><strong>₱{change.toFixed(2)}</strong></div></>}
    {orderType==='Walk-in' && <EmptyCylinderReturns items={items} value={emptyReturns} onChange={setEmptyReturns} disabled={busy}/>}
    <label className="payment-modal-checkbox"><input type="checkbox" checked={print} onChange={e=>setPrint(e.target.checked)}/>Print Receipt / Slip</label>
    <div className="payment-modal-actions"><button type="button" className="payment-modal-btn cancel" disabled={busy} onClick={onCancel}>Cancel</button><button className="payment-modal-btn confirm" disabled={!valid||busy}>{busy?'Saving...':'Confirm'}</button></div>
  </form></div>;
}
