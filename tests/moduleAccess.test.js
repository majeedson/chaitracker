import test from 'node:test';
import assert from 'node:assert/strict';
import {APP_DOMAINS,roleModuleAccess,effectiveModuleAccess,hasModuleAccess} from '../src/moduleAccess.js';
test('operational domains include the dedicated Cigarettes module',()=>{
 assert.deepEqual(APP_DOMAINS.map(x=>x[0]),['orders','purchase','extra-time','summary','cigarettes','delta']);
});
test('existing roles retain their actual access despite unused legacy flags',()=>{
 for(const role of ['Staff','Manager','Ops Manager']){
  const access=effectiveModuleAccess({role,permissions:{salary:false,summary:true,purchase:false}});
  assert.equal(access.salary,true);assert.equal(access.purchase,true);
  assert.equal(access.summary,role!=='Staff');assert.equal(access.delta,false);assert.equal(access.people,false);
 }
});
test('module overrides apply independently and leave role-only domains intact',()=>{
 const profile={role:'Staff',permissions:{module_access:{orders:false,purchase:true,'extra-time':false,summary:true,delta:true,people:true,salary:false}}};
 const access=effectiveModuleAccess(profile);
 assert.equal(access.orders,false);assert.equal(access.purchase,true);assert.equal(access['extra-time'],false);
 assert.equal(access.summary,true);assert.equal(access.delta,true);assert.equal(access.people,false);
 assert.equal(access.salary,true);assert.equal(access.attendance,true);assert.equal(access.stock,true);
 assert.equal(hasModuleAccess(profile,'unknown'),false);
});
test('admins retain administrative access and resetting uses role defaults',()=>{
 const access=effectiveModuleAccess({access_class:'ADMIN',role:'Owner',permissions:{module_access:{summary:false,delta:false}}});
 assert.ok(Object.entries(access).filter(([id])=>id!=='my-profile').every(([,allowed])=>allowed));
 assert.equal(access['my-profile'],false);
 assert.equal(roleModuleAccess('Staff').summary,false);assert.equal(roleModuleAccess('Manager').summary,true);
});
test('My profile is available to staff and managers, excluded from all administrators',()=>{
 for(const role of ['Staff','Manager','Ops Manager'])assert.equal(hasModuleAccess({role,access_class:'STAFF'},'my-profile'),true);
 for(const role of ['Owner','Staff','Manager'])assert.equal(hasModuleAccess({role,access_class:'ADMIN',permissions:{module_access:{'my-profile':true}}},'my-profile'),false);
});
