import './PaymentModal.css';
export default function EmptyCylinderReturns({items,value=[],onChange,disabled=false}) {
  const tanks=items.filter(item=>Number(item.isTank));
  if(!tanks.length)return null;
  return <fieldset className="empty-cylinder-returns" disabled={disabled}>
    <legend>Empty Cylinders Received</legend>
    <label className="empty-cylinder-checkbox">
      <input type="checkbox" checked={tanks.every(item=>Number(value.find(v=>v.productId===(item.productId || item.id))?.quantity)===Number(item.qty))} onChange={e=>onChange(e.target.checked?tanks.map(item=>({productId:item.productId || item.id,quantity:Number(item.qty)})):[])}/>
      <span>Empty tank received</span>
    </label>
  </fieldset>;
}
