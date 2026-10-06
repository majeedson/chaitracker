export const SK_PRICES=[10,15,20,25,28,30];
export function cigaretteGroups(items,sales=[],counts={},date){
 const yesterday=new Date(date+'T12:00:00Z');yesterday.setUTCDate(yesterday.getUTCDate()-1);
 const prices=[...new Set([...SK_PRICES,...items.map(i=>Number(i.pos_price)).filter(n=>n>0),...sales.map(s=>Number(s.price))])].sort((a,b)=>a-b);
 const unassigned=items.filter(i=>!Number(i.pos_price));
 return prices.map(price=>{
  const brands=items.filter(i=>Number(i.pos_price)===price),sale=sales.find(s=>Number(s.price)===price);
  const complete=unassigned.length===0&&(brands.length>0||(sale&&Number(sale.pieces)===0))&&brands.every(i=>String(i.opening_date)===yesterday.toISOString().slice(0,10)&&counts[i.item_id]!==undefined&&counts[i.item_id]!==null&&Number.isFinite(Number(counts[i.item_id])));
  const movement=complete?brands.reduce((sum,i)=>sum+Number(i.opening||0)+Number(i.purchased||0)+Number(i.transfer_in||0)-Number(i.transfer_out||0)+Number(i.adjustment||0)-Number(counts[i.item_id]),0):null;
  const difference=complete&&sale?movement-Number(sale.pieces):null;
  const cost=complete&&brands.every(i=>i.cost_per_piece!=null)?brands.reduce((sum,i)=>sum+(Number(i.opening||0)+Number(i.purchased||0)+Number(i.transfer_in||0)-Number(i.transfer_out||0)+Number(i.adjustment||0)-Number(counts[i.item_id]))*Number(i.cost_per_piece),0):null;
  return {price,brands,sold:sale?Number(sale.pieces):null,revenue:sale?Number(sale.amount):null,movement,difference,cost,complete,unassigned:unassigned.length};
 });
}
export const packPieces=(packs,loose,size)=>Number(packs)*Number(size)+Number(loose);
