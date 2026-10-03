import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

export async function checkRelease() {
  const app=await fs.readFile(new URL('../src/app.js',import.meta.url),'utf8');
  const build=Number(app.match(/const APP_BUILD\s*=\s*(\d+)/)?.[1]);
  assert.ok(build>0,'APP_BUILD is required');
  const html=await fs.readFile(new URL('../index.html',import.meta.url),'utf8');
  const manifest=await fs.readFile(new URL('../public/manifest.webmanifest',import.meta.url),'utf8');
  for(const [name,source] of [['app',app],['HTML',html],['manifest',manifest]]) {
    const versions=[...source.matchAll(/\?v=(\d+)/g)].map(x=>Number(x[1]));
    assert.ok(versions.length,`${name} needs versioned assets`);
    assert.ok(versions.every(v=>v===build),`${name} asset versions must match Build ${build}`);
  }
  const migrationNames=await fs.readdir(new URL('../supabase/migrations/',import.meta.url));
  const migration=migrationNames.find(name=>name.endsWith(`_b${build}.sql`));
  assert.ok(migration,`Build ${build} needs a database migration`);
  const sql=await fs.readFile(new URL('../supabase/migrations/'+migration,import.meta.url),'utf8');
  assert.ok(sql.includes(`jsonb_build_object('schema_build',${build})`),'Database release must match APP_BUILD');
  return build;
}

export async function checkDatabaseRelease(build,url,key,fetcher=fetch) {
  assert.ok(url&&key,'Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY');
  const response=await fetcher(`${url.replace(/\/$/,'')}/rest/v1/rpc/get_app_release`,{
    method:'POST',headers:{apikey:key,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)
  });
  assert.ok(response.ok,'Database release RPC unavailable; apply the migration before deployment');
  const release=await response.json();
  assert.ok(Number(release?.schema_build)>=build,`Database must be at least Build ${build} before deployment`);
}
if(process.argv[1]===new URL(import.meta.url).pathname) {
  const build=await checkRelease();
  if(process.argv.includes('--database'))await checkDatabaseRelease(build,process.env.VITE_SUPABASE_URL,process.env.VITE_SUPABASE_PUBLISHABLE_KEY);
  console.log(`Build ${build} release checks passed`);
}
