import { apiRequest } from "../api";

let cachedSettings = null;
let cacheTime = 0;

// Settings rarely change mid-session, so cache for a minute to avoid refetching on every print.
export function clearReceiptSettingsCache() {
  cachedSettings = null;
  cacheTime = 0;
}

async function getSettings({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedSettings && now - cacheTime < 60000) return cachedSettings;
  try {
    cachedSettings = await apiRequest("/settings");
    cacheTime = now;
  } catch {
    cachedSettings = null;
  }
  return cachedSettings;
}

function esc(val) {
  return String(val ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function money(n){return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
export function receiptFromOrder(order,documentType='invoice'){
  return {...order,documentType,orderNo:order.id,saleNo:order.saleNo,datetime:order.date,orderType:order.type,deliveryNo:order.drNo,totalAmount:Number(order.totalAmount),customerName:order.customerName,customerPhone:order.customerPhone,customerAddress:order.customerAddress,pickupDetails:{pickupDate:order.scheduledPickupTime,address:order.customerAddress,contactNumber:order.customerPhone},deliveryDetails:{address:order.deliveryAddress,instructions:order.deliveryInstructions,riderName:order.deliveryRiderName}};
}
export function buildReceiptHtml(sale,settings={}) {
  const type=sale.orderType || sale.type || 'Walk-in';
  const pickup=type==='Pickup' || type==='Pick-up',delivery=type==='Delivery',walkin=type==='Walk-in';
  const method=sale.paymentMethod || "\u2014",cod=method==='Cash on Delivery (COD)' || method==='COD';
  const documentType=sale.documentType || (pickup?'pickup':delivery&&cod?'delivery':'invoice');
  const slip=documentType!=='invoice',title=documentType==='pickup'?'PICKUP SLIP':documentType==='delivery'?'DELIVERY SLIP':'SALES INVOICE';
  const details=delivery?sale.deliveryDetails || sale.fulfillment || {}:sale.pickupDetails || sale.fulfillment || {};
  const items=sale.items || [];
  const subtotal=Number(sale.subtotal ?? items.reduce((sum,i)=>sum+Number(i.subtotal ?? i.qty*(i.unitPrice ?? i.costPrice)),0));
  const discount=Number(sale.discount||0),inclusive=subtotal-discount,rate=Number(sale.taxRate ?? (settings.taxEnabled===false?0:Number(settings.taxRate ?? 12)/100));
  const vat=Number(sale.vat ?? (rate?inclusive*rate/(1+rate):0)),fee=Number(sale.deliveryFee||0),total=Number(sale.totalAmount ?? sale.amount ?? inclusive+fee);
  const row=(label,value)=>`<div class="row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  const amount=(label,value)=>row(label,'PHP '+money(value));
  const date=sale.datetime?new Date(sale.datetime):new Date();
  const dateText=date.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})+' | '+date.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true});
  const start=details.pickupDate || details.pickupTime,deadline=sale.pickupDeadline || details.deadline;
  const windowText=start?new Date(start).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+' to '+new Date(deadline || new Date(start).getTime()+2*86400000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+' (3 Days)':'\u2014';
  const digital=['GCash','Card','Bank Transfer'].includes(method);
  const tendered=Number(sale.amountCollected ?? sale.amountPaid ?? total);
  const change=Number(sale.changeDue ?? Math.max(0,tendered-total));
  const width=settings.printSize==='58mm'?58:80;
  const businessAddress=esc(settings.address || '#266 F. Blumentritt St., Batis 1500 City of San Juan')
    .replace(/,\s*/, ',<br>')
    .replace(/City of San Juan/g, '<span class="address-city">City of San Juan</span>');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(title)} ${esc(sale.saleNo || sale.orderNo)}</title><style>
  @page{size:${width}mm auto;margin:0}*{box-sizing:border-box}body{width:${width}mm;padding:8px;margin:auto;font:10px 'Courier New',monospace;color:#111}h1,h2{text-align:center;font-size:12px;margin:8px 0}.center{text-align:center}.business-address{line-height:1.4;text-wrap:balance;overflow-wrap:break-word}.address-city{white-space:nowrap}p{margin:3px 0}.rule{border-top:2px double #111;margin:10px 0}.row{display:flex;justify-content:space-between;gap:8px;margin:4px 0}.row span:last-child{text-align:right;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{padding:4px 2px;text-align:right}th:first-child,td:first-child{text-align:left;width:45%}thead{border-bottom:1px dashed #111}.total{font-weight:bold;font-size:11px}.footer{margin:16px 0;text-align:center}
  </style></head><body><div class="rule"></div><h1>${esc(settings.fullName || 'GLORIOUS COMMERCIAL EXPORTS, INCORPORATED')}</h1><div class="center"><p class="business-address">${businessAddress}</p><p>NCR, Second District, Philippines</p><p>VAT Reg. TIN: 000-315-874-00002</p></div><h2>${title}</h2><div class="rule"></div>
  ${documentType==='delivery'?row('Delivery No.',sale.deliveryNo || details.deliveryNo || "\u2014"):''}
  ${row(slip?'Order Ref No.':'Sales No.',slip?sale.orderNo || sale.orderId:sale.saleNo)}
  ${row('Date & Time',dateText)}${row('Transaction',pickup?'Pickup':type)}${row('Cashier',sale.cashierName || "\u2014")}
  ${delivery?row('Rider',details.riderName || details.rider || 'Unassigned')+(documentType==='invoice'?row('Delivery No.',sale.deliveryNo || details.deliveryNo || "\u2014"):''):''}
  <div class="rule"></div>${row('Customer Name',walkin?'________________________________':sale.customerName || details.customerName || "\u2014")}
  ${!walkin?row('Contact No.',sale.customerPhone || details.contactNumber || "\u2014"):''}
  ${row(delivery?'Delivery Address':'Address',walkin?'________________________________':details.address || sale.customerAddress || "\u2014")}
  ${delivery?row('Delivery Notes',details.instructions || sale.deliveryInstructions || "\u2014"):''}
  ${documentType==='pickup'?row('Pick-up Window',windowText):''}
  <div class="rule"></div><table><thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead><tbody>${items.map(i=>`<tr><td>${esc(i.name)}</td><td>${esc(i.qty)}</td><td>${money(i.unitPrice ?? i.costPrice)}</td><td>${money(i.subtotal ?? i.qty*(i.unitPrice ?? i.costPrice))}</td></tr>`).join('')}</tbody></table>
  <p>Items Purchased: ${items.reduce((sum,i)=>sum+Number(i.qty),0)}</p><div class="rule"></div>
  ${amount('Subtotal (VAT Inclusive)',subtotal)}${amount('Less: Discount',discount)}${amount('Total Sales (VAT Inclusive)',inclusive)}${amount('Less: VAT ('+(rate*100).toFixed(0)+'%)',vat)}${amount('Amount Net of VAT',inclusive-vat)}${delivery?amount('Delivery Fee',fee):''}
  <div class="rule"></div><div class="total">${amount('TOTAL AMOUNT DUE',total)}</div><div class="rule"></div>
  ${row('Payment Method',method)}${digital?row('Reference No.',sale.referenceNo || "\u2014"):''}
  ${cod && slip?amount('Amount to Collect',total):amount(documentType==='pickup'?'Amount Received':'Amount Paid',tendered)+amount('Change',change)}
  <div class="rule"></div><div class="footer">${slip?'THIS IS NOT AN OFFICIAL SALES INVOICE.'+(documentType==='pickup'?'<p>Official invoice to be generated upon pickup.</p>':''):'<p>Thank you for your purchase!</p><p>Please come again and visit us.</p>'}</div>${documentType==='delivery'?'<p>Receiver signature: __________________</p><p>Empty cylinder collected: [ ]</p>':''}<div class="rule"></div></body></html>`;
}

// Prints via a hidden same-page iframe instead of window.open(). This is the
// key fix for printing not working on other devices/browsers: window.open()
// called after an `await` loses the "triggered by a real user click" status
// in most browsers (especially mobile Safari/Chrome), so it gets silently
// blocked as a popup. An iframe never opens a new window/tab at all, so
// there's nothing for a popup blocker to block — it works the same whether
// print() runs synchronously or after an async fetch.
function printViaIframe(html) {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.setAttribute("aria-hidden", "true");
    document.body.appendChild(iframe);

    const cleanup = () => {
      // Give the print dialog time to actually open before we rip the iframe out —
      // removing it too early can silently cancel printing on some mobile browsers.
      setTimeout(() => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        resolve();
      }, 1000);
    };

    iframe.onload = () => {
      try {
        const win = iframe.contentWindow;
        const doc = win.document;
        const images = Array.from(doc.images || []);

        const waitForImages = Promise.all(
          images.map(
            (img) =>
              new Promise((resolve) => {
                if (img.complete) return resolve();
                img.onload = () => resolve();
                img.onerror = () => resolve();
              })
          )
        );

        waitForImages.finally(() => {
          win.focus();
          // Some mobile browsers need a tick after focus before print() reliably opens the dialog.
          setTimeout(() => {
            try {
              win.print();
            } catch (err) {
              console.error("Print failed:", err);
            }
            cleanup();
          }, 150);
        });
      } catch (err) {
        console.error("Print failed:", err);
        cleanup();
      }
    };

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
  });
}

/**
 * Prints a branded receipt using the company's saved logo, header, footer and
 * print-size settings. Falls back gracefully (opens a new tab with the receipt
 * so the user can still print/share manually) if in-page printing isn't
 * supported at all in the current browser.
 *
 * @param {object} sale - { saleNo, datetime, cashierName, customerName, orderType,
 *                          items: [{ name, qty, unitPrice, subtotal }],
 *                          subtotal, discount, vat, taxRate, deliveryFee, totalAmount }
 */
export async function printReceipt(sale) {
  const settings = await getSettings({ forceRefresh: true });
  const html = buildReceiptHtml(sale, settings);

  try {
    await printViaIframe(html);
  } catch (err) {
    console.error("In-page print failed, falling back to a new tab:", err);
    // Last-resort fallback: open a real tab with the receipt so the person can
    // still use their browser/OS's own print or share/PDF option manually.
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

