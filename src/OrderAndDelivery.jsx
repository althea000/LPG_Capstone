import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Pencil, Printer, Trash2 } from 'lucide-react';
import { apiRequest } from './api';
import { printReceipt, receiptFromOrder } from './utils/receipt';
import { isRiderRole } from './rbac';
import Pagination from './Pagination';
import EmptyCylinderReturns from './EmptyCylinderReturns';
import './OrderAndDelivery.css';
const peso=n=>new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(n||0));
const date=value=>value ? new Date(value).toLocaleString():' — ';
const pickupStatuses=['Preparing','Ready for Pickup','Claimed','Cancelled','Unclaimed'];
const deliveryStatuses=['Preparing','Out for Delivery','Failed Attempt','Delivered','Cancelled','Delivery Failed / Restocked'];
const failureReasons=['Customer Unreachable','House Closed / No Recipient','Incorrect Address','Refused Acceptance','Other'];
function Badge({value}) {
  const tone=['Paid','Claimed','Delivered','Refunded','Active'].includes(value)?'green':['Cancelled','Unpaid','Unclaimed','Delivery Failed / Restocked','Failed Attempt'].includes(value)?'red':['Out for Delivery','Ready for Pickup'].includes(value)?'blue':'yellow';
  return <span className={`od-badge od-badge-${tone}`}>{value==='Unclaimed'?'⚠ Expired (Unclaimed)':value || ' — '}</span>;
}
function Field({label,children}) {return <div className="od-form-row"><label>{label}</label>{children}</div>;}
function Modal({title,onClose,children}) {
  const ref=useRef(null);
  useEffect(()=>{
    const previous=document.activeElement;
    ref.current?.querySelector('input,select,textarea,button')?.focus();
    const listener=e=>{
      if(e.key==='Escape')onClose();
      if(e.key==='Tab'){
        const elements=Array.from(ref.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')||[]);
        const first=elements[0],last=elements[elements.length-1];
        if(e.shiftKey && document.activeElement===first){e.preventDefault();last?.focus();}
        else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',listener);
    return()=>{document.removeEventListener('keydown',listener);previous?.focus();};
  },[onClose]);
  return <div className="od-modal-overlay open"><div className="od-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="od-dialog-title"><h3 id="od-dialog-title">{title}</h3>{children}</div></div>;
}
function OrderSummary({order}) {
  return <><p><strong>{order.id}</strong> · {order.customerName || ' — '} · {order.customerPhone || ' — '}</p><p>{order.deliveryAddress || order.customerAddress}</p>
    <div className="od-items-header"><span>Product</span><span>Qty</span><span>Unit price</span><span>Subtotal</span></div>
    {(order.items||[]).map((item,i)=><div key={i} className="od-item-row"><span>{item.name}<small className="od-cell-detail">{item.unit==='piece'?'1 piece':`${item.unitValue ?? ' — '} ${item.unit || ''}`}</small></span><span>{item.qty}</span><span>{peso(item.unitPrice)}</span><span>{peso(item.subtotal)}</span></div>)}
    <p><strong>Total:</strong> {peso(order.totalAmount)} · <strong>Paid:</strong> {peso(order.amountPaid)} ({order.paymentMethod || ' — '})</p>
    {order.type==='Delivery' && <p>Delivery fee: {peso(order.deliveryFee)} · Attempt {order.attemptCount}/{order.maxAttempts}</p>}
    {(order.attempts||[]).map(a=><p key={a.attempt} className="od-attempt-log">Attempt {a.attempt} · {date(a.dispatchedAt)}{a.failedAt && <> · {a.reason}: {a.notes}</>}</p>)}
  </>;
}
export default function OrderAndDelivery() {
  const user=JSON.parse(localStorage.getItem('user')||'{}');
  const rider=isRiderRole(user.role);
  const [tab,setTab]=useState(rider?'delivery':new URLSearchParams(window.location.search).get('tab')==='delivery'?'delivery':'pickup');
  const [orders,setOrders]=useState([]),[customers,setCustomers]=useState([]),[riders,setRiders]=useState([]);
  const [policy,setPolicy]=useState({allowIssueRefund:true,allowForfeitPayment:true,canSettle:false});
  const [search,setSearch]=useState(''),[status,setStatus]=useState(''),[customerTypeFilter,setCustomerTypeFilter]=useState(''),[page,setPage]=useState(1);
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [modal,setModal]=useState(null),[form,setForm]=useState({}),[busy,setBusy]=useState(false),[modalError,setModalError]=useState('');
  const request=useRef(0);
  const load=useCallback(async()=>{
    const version=++request.current;
    try{
      const [orderData,policyData,customerData,riderData]=await Promise.all([apiRequest(rider?'/orders/deliveries':'/orders'),apiRequest('/orders/policy'),rider?Promise.resolve([]):apiRequest('/customers'),rider?Promise.resolve([]):apiRequest('/orders/riders')]);
      if(version!==request.current)return;
      setOrders(orderData);setPolicy(policyData);setCustomers(customerData);setRiders(riderData);setError('');
    }catch(err){if(version===request.current)setError(err.message);}
    finally{if(version===request.current)setLoading(false);}
  },[rider]);
  useEffect(()=>{load();const timer=setInterval(load,30000);return()=>{clearInterval(timer);};},[load]);
  useEffect(()=>{setPage(1);},[tab,search,status,customerTypeFilter]);
  const pickups=orders.filter(o=>o.type==='Pick-up'),deliveries=orders.filter(o=>o.type==='Delivery');
  const rows=(tab==='customers'?customers:tab==='delivery'?deliveries:pickups).filter(row=>{
    const haystack=tab==='customers'?`${row.id} ${row.name} ${row.phone} ${row.address} ${row.landmark}`:`${row.id} ${row.customerName} ${row.customerPhone} ${row.drNo} ${row.deliveryAddress}`;
    return haystack.toLowerCase().includes(search.toLowerCase()) && (!status || (tab==='delivery'?row.deliveryStatus:row.pickupStatus)===status) && (tab!=='customers' || !customerTypeFilter || row.type===customerTypeFilter);
  });
  const currentPage=Math.min(page,Math.max(1,Math.ceil(rows.length/7)));
  const visible=rows.slice((currentPage-1)*7,currentPage*7);
  const close=useCallback(()=>{if(!busy){setModal(null);setModalError('');}},[busy]);
  const update=(key,value)=>setForm(prev=>({...prev,[key]:value}));
  async function openOrder(order,action='details') {
    setModalError('');setError('');
    try{
      const full=await apiRequest(`/orders/${order.orderId}`);
      setForm({remarks:full.remarks || '',scheduledPickupTime:full.scheduledPickupTime?.replace(' ','T').slice(0,16) || '',deliveryAddress:full.deliveryAddress || '',landmark:full.landmark || '',riderId:full.deliveryRiderId || '',paymentMethod:full.paymentMethod==='Cash on Delivery (COD)'?'Cash':full.paymentMethod || 'Cash',amountPaid:Math.max(0,Number(full.totalAmount)-Number(full.amountPaid)),reason:'',driverNotes:'',failureReason:failureReasons[0],restockConfirmed:true,resolutionAction:policy.allowIssueRefund?'Refunded':'Forfeited',refundDeliveryFee:true,emptyCylinderReturned:false,referenceNo:'',collectPayment:true});
      setModal({kind:'order',order:full,action});
    }catch(err){setError(err.message);}
  }
  async function submit(e) {
    e.preventDefault();if(busy)return;setBusy(true);setModalError('');
    try{
      if(modal.kind==='customer-delete'){
        await apiRequest(`/customers/${modal.customer.id}`,{method:'DELETE'});
        setCustomers(prev=>prev.filter(c=>c.id!==modal.customer.id));setMessage('Customer deleted.');
      } else if(modal.kind==='customer-edit'){
        await apiRequest(modal.customer?.id?`/customers/${modal.customer.id}`:'/customers',{method:modal.customer?.id?'PUT':'POST',body:JSON.stringify(form)});setMessage('Customer saved.');
      } else if(modal.kind==='order'){
        const {order}=modal;
        const action=e.nativeEvent.submitter?.value==='assign' ? 'assign' : modal.action;
        const payload=action==='details'?{riderId:form.riderId,remarks:form.remarks}:{...form,action};
        await apiRequest(action==='details'?`/orders/${order.orderId}`:`/orders/${order.orderId}/actions`,{method:action==='details'?'PUT':'POST',body:JSON.stringify(payload)});
        if (action==='assign' && modal.action==='dispatch') {
          const full=await apiRequest(`/orders/${order.orderId}`);
          setModal({kind:'order',order:full,action:'dispatch'});
          setMessage('Rider assignment saved.');
          await load();
          return;
        }
        if(action==='cancel' && Number(order.amountPaid)>0){
          const full=await apiRequest(`/orders/${order.orderId}`);setModal({kind:'order',order:full,action:'settle'});setForm(prev=>({...prev,reason:prev.reason}));setMessage('Cancelled; payment resolution is pending.');await load();return;
        }
        setMessage(action==='settle'?'Order restocked and settled.':'Order updated.');
      }
      setModal(null);await load();
    }catch(err){setModalError(err.message);}
    finally{setBusy(false);}
  }
  async function print(order) {
    try{
      const full=await apiRequest(`/orders/${order.orderId}`);
      await printReceipt(receiptFromOrder(full,full.type==='Pick-up'?'pickup':'delivery'));
    }catch(err){setError(err.message);}
  }
  async function profile(customer) {
    try{const history=await apiRequest(`/customers/${customer.id}/history`);setModal({kind:'profile',customer,history});}catch(err){setError(err.message);}
  }
  function editCustomer(customer=null) {
    setModalError('');setForm({name:customer?.name || '',phone:customer?.phone || '',address:customer?.address || '',landmark:customer?.landmark || '',customerType:customer?.type==='Commercial'?'Commercial':'Residential'});setModal({kind:'customer-edit',customer});
  }
  const rowActions=order=><div className="od-actions od-lifecycle-actions">
    {order.type==='Pick-up' && <>
      {order.pickupStatus==='Preparing' && <button className="od-btn od-btn-outline" onClick={()=>openOrder(order,'ready')}>Mark Ready</button>}
      {order.pickupStatus==='Ready for Pickup' && <button className="od-btn od-btn-primary" onClick={()=>openOrder(order,'claim')}>Complete Claim</button>}
      {['Cancelled','Unclaimed'].includes(order.pickupStatus) && Number(order.amountPaid)>0 && <button className="od-btn od-btn-danger" disabled={!policy.canSettle} onClick={()=>openOrder(order,'settle')}>Restock & Settle</button>}
      {order.pickupStatus==='Claimed' && order.paymentStatus==='Unpaid' && <button className="od-btn od-btn-primary" onClick={()=>openOrder(order,'pay')}>Collect Payment</button>}
    </>}
    {order.type==='Delivery' && <>
      {!rider && ['Preparing','Failed Attempt','Out for Delivery'].includes(order.deliveryStatus) && <button className="od-btn od-btn-outline" onClick={()=>openOrder(order,order.deliveryStatus==='Out for Delivery'?'assign':'dispatch')}>{order.deliveryStatus==='Out for Delivery'?'Reassign Rider':'Dispatch'}</button>}
      {order.deliveryStatus==='Out for Delivery' && <><button className="od-btn od-btn-primary" onClick={()=>openOrder(order,'delivered')}>Confirm Delivery</button><button className="od-btn od-btn-outline" onClick={()=>openOrder(order,'failed')}>Log Failed Attempt</button></>}
      {!rider && order.deliveryStatus==='Delivered' && order.paymentStatus==='Unpaid' && <button className="od-btn od-btn-primary" onClick={()=>openOrder(order,'pay')}>Record Remittance</button>}
      {!rider && ['Cancelled','Delivery Failed / Restocked'].includes(order.deliveryStatus) && Number(order.amountPaid)>0 && <button className="od-btn od-btn-danger" disabled={!policy.canSettle} onClick={()=>openOrder(order,'settle')}>Restock & Settle</button>}
    </>}
  </div>;
  const iconActions=order=><div className="od-actions">
    {!rider && <><button className="od-action-btn od-act-view" title="View / Edit" onClick={()=>openOrder(order)}><FileText size={18}/></button><button className="od-action-btn od-act-print" title="Print" onClick={()=>print(order)}><Printer size={18}/></button></>}
    {!rider && !['Claimed','Cancelled','Unclaimed'].includes(order.pickupStatus) && !['Delivered','Cancelled','Delivery Failed / Restocked'].includes(order.deliveryStatus) && <button className="od-action-btn od-act-delete" title="Delete" onClick={()=>openOrder(order,'cancel')}><Trash2 size={18}/></button>}
  </div>;

  const action=modal?.action,selected=modal?.order;
  return <div className="od-page"><h1 className="od-page-title">Orders & Delivery</h1>
    {error && <p role="alert" className="od-error">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="od-panel"><div className="od-tabs" role="tablist">
      {(rider?[['delivery','Delivery',deliveries.length]]:[['pickup','Pick-up',pickups.length],['delivery','Delivery',deliveries.length],['customers','Customers',customers.length]]).map(([key,label,count])=><button key={key} role="tab" aria-selected={tab===key} className={`od-tab ${tab===key?'active':''}`} onClick={()=>{setTab(key);setSearch('');setStatus('');}}>{label} {key!=='customers' && <span className="od-tab-count">{count}</span>}</button>)}
    </div><div className="od-filters"><div className="od-search-box"><input aria-label="Search" placeholder={tab==='customers'?'Search Customer':`Search ${tab==='pickup'?'Pick-up':'Delivery'} Orders`} value={search} onChange={e=>setSearch(e.target.value)}/></div>
      {tab!=='customers' && <select aria-label="Filter status" value={status} onChange={e=>setStatus(e.target.value)}><option value="">All Statuses</option>{(tab==='pickup'?pickupStatuses:deliveryStatuses).map(s=><option key={s}>{s}</option>)}</select>}
      {tab==='customers' && <select aria-label="Customer Type" value={customerTypeFilter} onChange={e=>setCustomerTypeFilter(e.target.value)}><option value="">All Customer Types</option><option>Residential</option><option>Commercial</option></select>}
      {tab==='customers' && <button className="od-btn od-btn-primary" onClick={()=>editCustomer()}>+ Add Customer</button>}
    </div><div className={`od-table-wrap${tab==='delivery'?' od-delivery-table':''}`}><table><thead><tr>
      {(tab==='pickup'?['Order ID','Customer','Pickup Status','Payment Status','Total Amount','Date','Change Status','Actions']:tab==='delivery'?['Delivery No.','Order ID','Customer','Rider','Delivery Status','Attempts','Payment Status','Delivery Address','Change Status','Actions']:['Customer ID','Customer Name','Contact Number','Address','Customer Type','Total Orders Placed','Actions']).map(label=><th key={label}>{label}</th>)}
    </tr></thead><tbody>
      {loading?<tr><td colSpan={tab==='delivery'?10:tab==='pickup'?8:7} className="od-empty-state">Loading…</td></tr>:visible.map(row=><tr key={row.orderId||row.id}>
        {tab==='pickup'?<><td>{row.id}</td><td>{row.customerName}<small className="od-cell-detail">{row.customerPhone || ' — '}</small></td><td><Badge value={row.pickupStatus}/>{row.lifecycleWarning && <small className="od-cell-detail od-error">{row.lifecycleWarning}</small>}</td><td><Badge value={row.paymentStatus}/></td><td>{peso(row.totalAmount)}</td><td>{date(row.scheduledPickupTime)}<small className="od-cell-detail">Deadline: {date(row.pickupDeadline)}</small></td><td>{rowActions(row)}</td><td>{iconActions(row)}</td></>:
        tab==='delivery'?<><td>{row.drNo || ' — '}</td><td>{row.id}</td><td>{row.customerName}<small className="od-cell-detail">{row.customerPhone}</small></td><td>{row.deliveryRiderName || <Badge value="Unassigned"/>}</td><td><Badge value={row.deliveryStatus}/>{row.nextAttemptDate && <small className="od-cell-detail">Retry: {date(row.nextAttemptDate)}</small>}</td><td><Badge value={`Attempt ${row.attemptCount}/${row.maxAttempts}${Number(row.attemptCount)===3?' - Final':''}`}/></td><td><Badge value={row.paymentStatus}/><small className="od-cell-detail">{row.paymentMethod || (row.paymentStatus==='Unpaid'?'COD':' — ')}</small></td><td>{row.deliveryAddress || ' — '}</td><td>{rowActions(row)}</td><td>{iconActions(row)}</td></>:
        <><td>{row.id}</td><td>{row.name}</td><td>{row.phone}</td><td>{['WALKIN','IMPORTED'].includes(row.phone)?' \u2014 ':row.address}</td><td>{row.type}</td><td>{row.totalOrders || 0}</td><td><div className="od-actions"><button className="od-action-btn od-act-view" title="View Profile & History" onClick={()=>profile(row)}><FileText size={18}/></button><button className="od-action-btn od-act-edit" title="Edit" onClick={()=>editCustomer(row)}><Pencil size={18}/></button><button className="od-action-btn od-act-delete" title="Delete" onClick={()=>{setModalError('');setModal({kind:'customer-delete',customer:row});}}><Trash2 size={18}/></button></div></td></>}
      </tr>)}
      {!loading && !visible.length && <tr><td colSpan={tab==='delivery'?10:tab==='pickup'?8:7} className="od-empty-state">No records match your search.</td></tr>}
    </tbody></table><Pagination page={currentPage} total={rows.length} onChange={setPage}/></div></div>
    {modal && <Modal title={modal.kind==='order'?({details:'Order Details / Edit',ready:'Mark Ready for Pickup',claim:'Complete Claim',pay:'Collect Payment / Remittance',assign:'Reassign Rider',dispatch:'Dispatch Delivery',failed:'Log Failed Attempt',delivered:'Confirm Delivery',cancel:'Cancel Order',settle:'Restock & Settle'}[action]):modal.kind==='profile'?'Customer Profile & History':modal.kind==='customer-delete'?'Delete Customer':modal.customer?'Edit Customer':'Add Customer'} onClose={close}>
      {modalError && <p role="alert" className="od-error">{modalError}</p>}
      {modal.kind==='profile'?<><p><strong>{modal.customer.name}</strong> · {modal.customer.phone}</p><p>{modal.customer.address} {modal.customer.landmark}</p>{modal.history.length?modal.history.map(o=><p key={o.orderId}>{o.id} · {o.type} · {date(o.date)} · {o.status} · {o.paymentStatus} · {peso(o.totalAmount)}</p>):<p>No order history.</p>}<button className="od-btn od-btn-outline" onClick={close}>Close</button></>:
      <form onSubmit={submit}>
        {modal.kind==='customer-delete'?<p>Are you sure you want to delete this customer? This action cannot be undone. Historical orders will be preserved.</p>:
        modal.kind==='customer-edit'?<><Field label="Customer Name"><input required maxLength={150} value={form.name} onChange={e=>update('name',e.target.value)}/></Field><Field label="Contact Number"><input required maxLength={30} value={form.phone} onChange={e=>update('phone',e.target.value)}/></Field><Field label="Address"><textarea required value={form.address} onChange={e=>update('address',e.target.value)}/></Field><Field label="Customer Type"><select value={form.customerType} onChange={e=>update('customerType',e.target.value)}><option>Residential</option><option>Commercial</option></select></Field></>:
        <><OrderSummary order={selected}/>
          {action==='details' && <><p><Badge value={selected.pickupStatus || selected.deliveryStatus}/> <Badge value={selected.paymentStatus}/></p>{selected.type==='Pick-up'?<Field label="Scheduled Pickup Time"><input readOnly type="datetime-local" value={form.scheduledPickupTime}/><small>Pickup window: 3 days. Deadline: {date(selected.pickupDeadline)}</small></Field>:<><Field label="Delivery Address"><p>{selected.deliveryAddress}</p></Field><Field label="Delivery Instructions"><p>{selected.deliveryInstructions || ' \u2014 '}</p></Field><Field label="Assigned Delivery Rider"><select value={form.riderId} onChange={e=>update('riderId',e.target.value)}><option value="">Unassigned</option>{riders.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></Field></>}<Field label="Notes">{selected.type==='Delivery'?<textarea maxLength={255} value={form.remarks} onChange={e=>update('remarks',e.target.value)}/>:<p>{selected.remarks || ' \u2014 '}</p>}</Field></>}
          {(action==='pay' || (['claim','delivered'].includes(action) && selected.paymentStatus!=='Paid')) && <><p>Collect {peso(form.amountPaid)} before continuing.</p><Field label="Payment Method"><select value={form.paymentMethod} onChange={e=>update('paymentMethod',e.target.value)}>{['Cash','GCash','Card','Bank Transfer'].map(m=><option key={m}>{m}</option>)}</select></Field>{form.paymentMethod!=='Cash' && <Field label="Reference No."><input required maxLength={50} value={form.referenceNo || ''} onChange={e=>update('referenceNo',e.target.value)}/></Field>}</>}
          {['dispatch','assign'].includes(action) && <><Field label="Assigned Rider"><select required value={form.riderId} onChange={e=>update('riderId',e.target.value)}><option value="">Select Rider</option>{riders.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>{selected.nextAttemptDate && <><p>Next business-day retry: {selected.nextAttemptDate} (Asia/Manila).</p></>}</>}
          {action==='failed' && <><Field label="Failure Reason"><select required value={form.failureReason} onChange={e=>update('failureReason',e.target.value)}>{failureReasons.map(r=><option key={r}>{r}</option>)}</select></Field><Field label="Driver Notes (Required)"><textarea required maxLength={255} value={form.driverNotes} onChange={e=>update('driverNotes',e.target.value)}/></Field></>}
          {['claim','delivered'].includes(action) && <EmptyCylinderReturns items={selected.items || []} value={form.emptyReturns || []} onChange={value=>update('emptyReturns',value)} disabled={busy}/>}
          {action==='cancel' && <><p>{Number(selected.amountPaid)>0?'Paid orders require manager resolution after cancellation.':'This will restore the original stock quantities and archive the order.'}</p><Field label="Cancellation Remarks (Required)"><textarea required maxLength={255} value={form.reason} onChange={e=>update('reason',e.target.value)}/></Field></>}
          {action==='settle' && <><label className="od-check"><input required type="checkbox" checked={form.restockConfirmed} onChange={e=>update('restockConfirmed',e.target.checked)}/>Automatically return {(selected.items||[]).map(i=>`${i.qty}x ${i.name}`).join(', ')} to stock</label>
            {policy.allowIssueRefund && <label className="od-check"><input type="radio" name="resolution" checked={form.resolutionAction==='Refunded'} disabled={!policy.allowForfeitPayment} onChange={()=>update('resolutionAction','Refunded')}/>Issue Refund — {peso(Number(selected.amountPaid)-(form.refundDeliveryFee?0:Number(selected.deliveryFee||0)))}</label>}
            {policy.allowForfeitPayment && <label className="od-check"><input type="radio" name="resolution" checked={form.resolutionAction==='Forfeited'} disabled={!policy.allowIssueRefund} onChange={()=>update('resolutionAction','Forfeited')}/>Forfeit Payment — retain {peso(selected.amountPaid)} as cancellation / logistics income</label>}
            {selected.type==='Delivery' && form.resolutionAction==='Refunded' && <label className="od-check"><input type="checkbox" checked={form.refundDeliveryFee} onChange={e=>update('refundDeliveryFee',e.target.checked)}/>Refund full amount including delivery fee (uncheck to retain {peso(selected.deliveryFee)})</label>}
            <Field label="Reason / Notes (Required)"><textarea required maxLength={255} value={form.reason} onChange={e=>update('reason',e.target.value)}/></Field>{!policy.canSettle && <p>Manager authorization is required.</p>}
          </>}
        </>}
        <div className="od-modal-actions"><button type="button" className="od-btn od-btn-outline" disabled={busy} onClick={close}>Cancel</button>{action==='dispatch' && <button type="submit" name="action" value="assign" className="od-btn od-btn-outline" disabled={busy || !form.riderId}>Save Rider</button>}{!(action==='details' && selected?.type==='Pick-up') && <button type="submit" className={`od-btn ${['cancel','settle'].includes(action) || modal.kind==='customer-delete'?'od-btn-danger':'od-btn-primary'}`} disabled={busy || (action==='settle' && !policy.canSettle) || (action==='dispatch' && (!form.riderId || !selected.retryDue))}>{busy?'Saving…':action==='details' || modal.kind==='customer-edit'?'Save':action==='dispatch'?'Dispatch':'Confirm'}</button>}</div>
      </form>}
    </Modal>}
  </div>;
}
