import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db/db.ts';
import { createShelter } from '../src/domain/shelters.ts';
import { createHousehold } from '../src/domain/households.ts';
import { checkIn } from '../src/domain/stays.ts';
import { createItem } from '../src/domain/inventory.ts';
import { applyOfflineBatch, listConflicts } from '../src/domain/offline.ts';

const roster = JSON.parse(readFileSync('fixtures/offline_checkin_batch.json', 'utf8'));
const invBatch = JSON.parse(readFileSync('fixtures/offline_inventory_batch.json', 'utf8'));

function setup() {
  const db = openDb(':memory:');
  createShelter(db, { code: 'S1', name: '甲点', capacity: { standard: 10 } });
  createShelter(db, { code: 'S2', name: '乙点', capacity: { standard: 10 } });
  createItem(db, { code: 'MEAL', name: '盒饭', category: 'meal' });
  createItem(db, { code: 'WATER', name: '饮用水', category: 'supply' });
  for (const code of ['HH-SOLO-03', 'HH-SOLO-04', 'HH-SOLO-05'])
    createHousehold(db, { code, size: 1 });
  return db;
}

test('离线批次整体幂等：同一 batchKey 重放不重复应用', () => {
  const db = setup();
  const r1 = applyOfflineBatch(db, roster);
  assert.equal(r1.applied, 3);
  const r2 = applyOfflineBatch(db, roster);
  assert.equal(r2.status, 'duplicate');
  assert.equal(r2.applied, 0);
  const stays = db.prepare("SELECT COUNT(*) AS n FROM stays WHERE status='active'").get() as any;
  assert.equal(stays.n, 3);
});

test('夜间批次与现场手工登记冲突：识别并审计，不覆盖', () => {
  const db = setup();
  checkIn(db, { householdCode: 'HH-SOLO-04', shelterId: 2, source: 'manual' });
  const result = applyOfflineBatch(db, roster);
  assert.equal(result.applied, 2);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].record_key, 'r2');
  const conflicts = listConflicts(db) as any[];
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].detail, /重复入住/);
  const stay = db.prepare("SELECT s.shelter_id FROM stays s JOIN households h ON h.id = s.household_id WHERE h.code='HH-SOLO-04'").get() as any;
  assert.equal(stay.shelter_id, 2);
});

test('离线物资批次幂等且库存守恒', () => {
  const db = setup();
  const r1 = applyOfflineBatch(db, invBatch);
  assert.equal(r1.applied, 3);
  applyOfflineBatch(db, invBatch);
  const stock = db.prepare('SELECT COALESCE(SUM(qty_remaining),0) AS q FROM inventory_batches').get() as any;
  assert.equal(stock.q, 600);
});
