import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../src/utils/receipt.js',import.meta.url),'utf8')).replace('import { apiRequest } from "../api";','const apiRequest=async()=>({});');
const {buildReceiptHtml,receiptFromOrder}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const base={saleNo:'SALE-2026-001',orderNo:'ORD-2026-001',datetime:'2026-10-09T14:30:00',cashierName:'Jose Villanueva',customerName:'Mina Mendoza',items:[{name:'Item <01>',qty:1,unitPrice:560,subtotal:560},{name:'Item 02',qty:2,unitPrice:280,subtotal:560}],subtotal:1120,discount:0,vat:120,taxRate:0.12,totalAmount:1120,amountCollected:1500,changeDue:380};
const cash=buildReceiptHtml({...base,orderType:'Walk-in',paymentMethod:'Cash',documentType:'invoice'});
assert.match(cash,/SALES INVOICE/);assert.doesNotMatch(cash,/Reference No\./);assert.doesNotMatch(cash,/Mina Mendoza/);assert.match(cash,/Items Purchased: 3/);assert.match(cash,/PHP 1,000\.00/);assert.match(cash,/PHP 380\.00/);assert.match(cash,/Item &lt;01&gt;/);
for(const paymentMethod of ['GCash','Card','Bank Transfer']){
  const html=buildReceiptHtml({...base,orderType:'Delivery',paymentMethod,referenceNo:'TXN-123',documentType:'invoice',deliveryNo:'DEL-2026-001',deliveryDetails:{address:'154 Street',instructions:'Call upon arrival',riderName:'Juan Santos'}});
  assert.match(html,/Reference No\./);assert.match(html,/TXN-123/);assert.match(html,/DEL-2026-001/);assert.match(html,/Juan Santos/);assert.match(html,/Call upon arrival/);
}
const pickup=buildReceiptHtml({...base,orderType:'Pickup',paymentMethod:'Bank Transfer',referenceNo:'TXN-123',pickupDetails:{pickupDate:'2026-10-09T09:00:00',contactNumber:'09123456789',address:'154 Street'},documentType:'pickup'});
assert.match(pickup,/PICKUP SLIP/);assert.match(pickup,/Oct 9, 2026 to Oct 11, 2026 \(3 Days\)/);assert.match(pickup,/Official invoice to be generated upon pickup/);assert.match(pickup,/ORD-2026-001/);
const cod=buildReceiptHtml({...base,orderType:'Delivery',paymentMethod:'Cash on Delivery (COD)',deliveryNo:'DEL-2026-001',documentType:'delivery'});
assert.match(cod,/DELIVERY SLIP/);assert.match(cod,/Amount to Collect/);assert.doesNotMatch(cod,/Amount Paid|Reference No\.|<span>Change<\/span>/);assert.match(cod,/THIS IS NOT AN OFFICIAL SALES INVOICE/);
const mapped=receiptFromOrder({id:'ORD-2026-001',type:'Pick-up',totalAmount:'1120',scheduledPickupTime:'2026-10-09 09:00:00',pickupDeadline:'2026-10-11 18:00:00',items:base.items},'pickup');
assert.equal(mapped.orderNo,'ORD-2026-001');assert.equal(mapped.pickupDeadline,'2026-10-11 18:00:00');
console.log('PASS: cash/digital invoices, pickup window/slip, COD delivery slip, VAT-inclusive totals, preserved references and escaped receipt output.');
