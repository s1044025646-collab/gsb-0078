import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const db = 'data/smoke.db';
rmSync(db, { force: true });
rmSync(`${db}-wal`, { force: true });
rmSync(`${db}-shm`, { force: true });

function run(args: string[]): unknown {
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, SHELTER_DB: db },
    encoding: 'utf8'
  });
  return JSON.parse(output);
}

run(['configure-site', '--json', '@fixtures/sites.json']);
run(['configure-site', '--json', '@fixtures/site-beta.json']);
run(['import-roster', '--json', '@fixtures/household-accessible.json']);
run(['import-roster', '--json', '@fixtures/household-family.json']);
run(['reserve', '--json', JSON.stringify({
  reservationCode: 'RES-SMOKE-001',
  householdCode: 'HH-DRILL-001',
  siteCode: 'SITE-ALPHA',
  expiresAt: '2999-01-01T00:00:00.000Z',
  reason: 'smoke reservation'
})]);
run(['checkin', '--json', JSON.stringify({
  householdCode: 'HH-DRILL-001',
  siteCode: 'SITE-ALPHA',
  reservationCode: 'RES-SMOKE-001',
  reason: 'smoke check-in'
})]);
run(['add-batch', '--json', '@fixtures/inventory-meal.json']);
run(['issue', '--json', JSON.stringify({
  requestKey: 'ISSUE-SMOKE-001',
  householdCode: 'HH-DRILL-001',
  sku: 'MEAL-BOX',
  quantity: 2
})]);
run(['replay-batch', '--json', '@fixtures/offline-batch.json']);
run(['capacity']);
run(['summary']);
console.log(JSON.stringify({ status: 'ok', database: db }, null, 2));
