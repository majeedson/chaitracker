export async function loadSalaryTransfers(supabase,staffId,start,end) {
  const rows=[];
  let after=0;
  for(;;){
    const {data,error}=await supabase.rpc('get_salary_transfer_payments',{
      p_staff_id:staffId,p_start:start,p_end:end,p_after_id:after
    });
    if(error)throw error;
    const page=data||[];
    rows.push(...page);
    if(page.length<300)return rows;
    const next=Number(page.at(-1).id);
    if(next<=after)throw new Error('Transfer pagination did not advance');
    after=next;
  }
}
