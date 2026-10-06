import test from 'node:test';
import assert from 'node:assert/strict';
import {checkRelease,checkDatabaseRelease} from '../scripts/check-release.mjs';
test('app, assets and database migration have the same build',async()=>assert.equal(await checkRelease(),138));
test('deployment refuses a missing or older database release',async()=>{
 const fake=data=>async()=>({ok:true,json:async()=>data});
 await assert.rejects(checkDatabaseRelease(128,'https://example.test','public-key',fake({schema_build:127})),/at least Build 128/);
 await assert.rejects(checkDatabaseRelease(128,'https://example.test','public-key',async()=>({ok:false})),/apply the migration/);
 await checkDatabaseRelease(128,'https://example.test','public-key',fake({schema_build:128}));
});
