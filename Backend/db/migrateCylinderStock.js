const pool=require('../config/db');
async function migrate(conn=pool){
  const [columns]=await conn.query(`SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()`);
  const existing=new Set(columns.map(c=>`${c.TABLE_NAME}.${c.COLUMN_NAME}`.toLowerCase()));
  if(!existing.has('inventory.emptystock')) await conn.query(`ALTER TABLE Inventory ADD COLUMN EmptyStock INT NOT NULL DEFAULT 0 CHECK (EmptyStock>=0)`);
  if(!existing.has('order.emptyreturnsrecordedat')) await conn.query(`ALTER TABLE \`Order\` ADD COLUMN EmptyReturnsRecordedAt DATETIME NULL`);
  if(!existing.has('transfer.stocktype')) await conn.query(`ALTER TABLE Transfer ADD COLUMN StockType ENUM('filled','empty') NOT NULL DEFAULT 'filled'`);
  console.log('Cylinder stock migration complete: existing StockOnHand remains filled/sellable stock; empty counts start at zero.');
}
if(require.main===module)migrate().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>pool.end());
module.exports=migrate;
