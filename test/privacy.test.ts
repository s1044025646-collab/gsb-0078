import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.ts';
import { createShelter } from '../src/domain/shelters.ts';
import { createHousehold } from '../src/domain/households.ts';
import { checkIn } from '../src/domain/stays.ts';
import { createItem, receiveBatch, distribute } from '../src/domain/inventory.ts';
import { operationalSummary } from '../src/domain/summary.ts';

test('运营汇总不含任何家庭/成员编号（隐私边界）', () => {
  const db = openDb(':memory:');
  createShelter(db, { code: 'S1', name: '甲点', capacity: { standard: 10 } });
  createHousehold(db, { code: 'HH-SECRET-001', size: 2, notes: '敏感备注' });
  checkIn(db, { householdCode: 'HH-SECRET-001', shelterId: 1 });
  createItem(db, { code: 'MEAL', name: '盒饭' });
  receiveBatch(db, { shelterId: 1, itemCode: 'MEAL', qty: 10, source: '捐赠' });
  distribute(db, { shelterId: 1, householdCode: 'HH-SECRET-001', itemCode: 'MEAL', qty: 2 });
  const text = JSON.stringify(operationalSummary(db));
  assert.ok(!text.includes('HH-SECRET-001'), '汇总不得包含家庭编号');
  assert.ok(!text.includes('敏感备注'), '汇总不得包含备注');
});
