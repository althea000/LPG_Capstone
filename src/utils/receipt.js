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

function formatMoney(amount, currency = "PHP") {
  const symbol = currency === "PHP" ? "₱" : currency + " ";
  return `${symbol}${Number(amount || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildReceiptHtml(sale, settings) {
  const businessName = settings?.fullName || "GasTrack";
  const address = settings?.address || "";
  const phone = settings?.phone || "";
  const email = settings?.contactEmail || "";
  const logo = settings?.showLogoOnReceipt !== false ? settings?.logoDataUrl : null;
  const headerText = settings?.receiptHeader || "";
  const footerMessage = settings?.footerMessage || "Thank you for your purchase!";
  const currency = settings?.currency || "PHP";
  const showTaxBreakdown = settings?.showTaxBreakdown !== false;
  const printSize = settings?.printSize === "58mm" ? "58mm" : "80mm";
  const pageWidthMm = printSize === "58mm" ? 58 : 80;

  const items = sale.items || [];
  const subtotal = sale.subtotal ?? items.reduce((s, it) => s + Number(it.subtotal ?? it.qty * it.unitPrice), 0);
  const discount = Number(sale.discount || 0);
  const vat = Number(sale.vat || 0);
  const deliveryFee = Number(sale.deliveryFee || 0);
  const total = sale.totalAmount ?? subtotal - discount + vat + deliveryFee;

  const itemRows = items
    .map(
      (it) => `
      <tr>
        <td class="cell-name">${esc(it.name)}</td>
        <td class="cell-qty">${esc(it.qty)}</td>
        <td class="cell-price">${formatMoney(it.unitPrice ?? it.costPrice, currency)}</td>
        <td class="cell-total">${formatMoney(it.subtotal ?? it.qty * (it.unitPrice ?? it.costPrice), currency)}</td>
      </tr>`
    )
    .join("");

  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Receipt ${esc(sale.saleNo || "")}</title>
        <style>
          @page { size: ${pageWidthMm}mm auto; margin: 0; }
          * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          html, body {
            font-family: 'Courier New', Consolas, monospace;
            width: ${pageWidthMm}mm;
            margin: 0 auto;
            padding: 10px 8px;
            color: #111827;
            font-size: ${pageWidthMm === 58 ? "10px" : "11px"};
          }
          .center { text-align: center; }
          .logo { max-width: 70%; max-height: 64px; object-fit: contain; margin-bottom: 6px; }
          .business-name { font-weight: 700; font-size: 1.15em; margin: 0; letter-spacing: 0.5px; }
          .business-meta { font-size: 0.85em; color: #374151; margin: 2px 0; line-height: 1.4; }
          .header-text { font-size: 0.9em; font-style: italic; margin: 4px 0; }
          hr { border: none; border-top: 1px dashed #9ca3af; margin: 8px 0; }
          .meta-row { display: flex; justify-content: space-between; font-size: 0.9em; margin: 2px 0; }
          table { width: 100%; border-collapse: collapse; margin-top: 6px; }
          th { text-align: left; font-size: 0.85em; border-bottom: 1px solid #111827; padding-bottom: 3px; }
          td { padding: 3px 0; font-size: 0.88em; vertical-align: top; }
          .cell-name { width: 46%; }
          .cell-qty { width: 12%; text-align: center; }
          .cell-price { width: 21%; text-align: right; }
          .cell-total { width: 21%; text-align: right; }
          .totals { margin-top: 8px; }
          .totals-row { display: flex; justify-content: space-between; font-size: 0.9em; padding: 1px 0; }
          .grand-total { font-weight: 700; font-size: 1.05em; border-top: 1px solid #111827; margin-top: 4px; padding-top: 4px; }
          .footer { text-align: center; margin-top: 14px; font-size: 0.85em; color: #374151; }
          .official-tag { text-align: center; font-size: 0.7em; color: #9ca3af; margin-top: 10px; letter-spacing: 0.5px; }
        </style>
      </head>
      <body>
        <div class="center">
          ${logo ? `<img src="${logo}" class="logo" alt="Logo" />` : ""}
          <p class="business-name">${esc(businessName)}</p>
          ${address ? `<p class="business-meta">${esc(address)}</p>` : ""}
          ${phone || email ? `<p class="business-meta">${[phone, email].filter(Boolean).map(esc).join(" · ")}</p>` : ""}
          ${headerText ? `<p class="header-text">${esc(headerText)}</p>` : ""}
        </div>

        <hr />

        <div class="meta-row"><span>Receipt No.</span><span>${esc(sale.saleNo || "—")}</span></div>
        <div class="meta-row"><span>Date</span><span>${esc(sale.datetime ? new Date(sale.datetime).toLocaleString() : new Date().toLocaleString())}</span></div>
        ${sale.cashierName ? `<div class="meta-row"><span>Cashier</span><span>${esc(sale.cashierName)}</span></div>` : ""}
        ${sale.customerName ? `<div class="meta-row"><span>Customer</span><span>${esc(sale.customerName)}</span></div>` : ""}
        ${sale.orderType ? `<div class="meta-row"><span>Type</span><span>${esc(sale.orderType)}</span></div>` : ""}

        <hr />

        <table>
          <thead>
            <tr>
              <th class="cell-name">Item</th>
              <th class="cell-qty">Qty</th>
              <th class="cell-price">Price</th>
              <th class="cell-total">Total</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>

        <hr />

        <div class="totals">
          <div class="totals-row"><span>Subtotal</span><span>${formatMoney(subtotal, currency)}</span></div>
          ${discount > 0 ? `<div class="totals-row"><span>Discount</span><span>-${formatMoney(discount, currency)}</span></div>` : ""}
          ${showTaxBreakdown && vat > 0 ? `<div class="totals-row"><span>Tax${sale.taxRate ? ` (${(sale.taxRate * 100).toFixed(0)}%)` : ""}</span><span>${formatMoney(vat, currency)}</span></div>` : ""}
          ${deliveryFee > 0 ? `<div class="totals-row"><span>Delivery Fee</span><span>${formatMoney(deliveryFee, currency)}</span></div>` : ""}
          <div class="totals-row grand-total"><span>TOTAL</span><span>${formatMoney(total, currency)}</span></div>
          ${sale.amountCollected != null ? `<div class="totals-row"><span>Amount Paid</span><span>${formatMoney(sale.amountCollected, currency)}</span></div>` : ""}
          ${sale.changeDue != null ? `<div class="totals-row"><span>Change</span><span>${formatMoney(sale.changeDue, currency)}</span></div>` : ""}
        </div>

        <div class="footer">${esc(footerMessage)}</div>
        <div class="official-tag">This serves as your official receipt · Powered by GasTrack</div>
      </body>
    </html>
  `;
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