export const APP_DOMAINS=[
  ['orders','Orders','Purchase suggestions and order checklist'],
  ['purchase','Purchases','Record purchases and invoices'],
  ['extra-time','Transfers','Request, dispatch and receive transfers'],
  ['summary','Daily Summary','Sales, expenses and daily closing'],
  ['cigarettes','Cigarettes','Cigarette orders, purchases, POS sales and daily stock check'],
  ['delta','Delta','Compare café stock counts']
];
export function roleModuleAccess(role='Staff',accessClass='STAFF'){
  const admin=accessClass==='ADMIN',manager=['Manager','Ops Manager'].includes(role);
  return Object.fromEntries(['dashboard','credits','attendance','salary','cigarettes','stock','orders','purchase','extra-time','summary','delta','people','my-profile'].map(id=>[id,id==='my-profile'?!admin:admin||['attendance','salary','cigarettes','stock','orders','purchase','extra-time'].includes(id)||(manager&&id==='summary')]));
}
export function effectiveModuleAccess(profile){
  const defaults=roleModuleAccess(profile.role,profile.access_class);
  if(profile.access_class==='ADMIN')return defaults;
  const custom=profile.permissions?.module_access;
  return {...defaults,...Object.fromEntries(APP_DOMAINS.map(([id])=>[id,typeof custom?.[id]==='boolean'?custom[id]:defaults[id]]))};
}
export const hasModuleAccess=(profile,id)=>effectiveModuleAccess(profile)[id]===true;

