// Atomic sequence allocation; transaction callers retain the row lock until commit.
async function nextSequence(conn, table, column, prefix, includeYear = true) {
  if(conn.getConnection){const lease=await conn.getConnection();try{return await nextSequence(lease,table,column,prefix,includeYear);}finally{lease.release();}}
  const year = new Date().getFullYear();
  const stem = includeYear ? `${prefix}-${year}-` : `${prefix}-`;
  const key = `${table}.${column}.${stem}`;
  const [[row]] = await conn.query(`SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(${column},'-',-1) AS UNSIGNED)),0) AS highest FROM ${table} WHERE ${column} LIKE :pattern AND SUBSTRING_INDEX(${column},'-',-1) REGEXP '^[0-9]+$'`, {pattern: `${stem}%`});
  await conn.query(`INSERT INTO DocumentSequence(SequenceKey,LastNumber) VALUES (:key,:highest) ON DUPLICATE KEY UPDATE LastNumber=GREATEST(LastNumber,:highest)`, {key,highest:Number(row.highest)});
  await conn.query(`UPDATE DocumentSequence SET LastNumber=LAST_INSERT_ID(LastNumber+1) WHERE SequenceKey=:key`,{key});
  const [[number]]=await conn.query('SELECT LAST_INSERT_ID() AS n');
  return `${stem}${String(number.n).padStart(3,'0')}`;
}
module.exports={nextSequence};
