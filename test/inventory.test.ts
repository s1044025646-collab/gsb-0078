import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.ts';
import { createShelter } from '../src/domain/shelters.ts';
import { createHousehold } from '../src/domain/households.ts';
import { checkIn } from '../src/domain/stays.ts';
import { createItem, receiveBatch, distribute, reverseDistribution, stockOf, listDistributions } from '../src/domain/inventory.ts';

function setup() {
  const db = openDb(':memory:');
  createShelter(db, { code: 'S1', name: '甲点', capacity: { standard: 10 } });
  createItem(db, { code: 'MEAL', name: '盒饭', category: 'meal' });
  createHousehold(db, { code: 'HH-1', size: 2 });
  checkIn(db, { householdCode: 'HH-1', shelterId: 1 });
  return db;
}

test('发放扣减库存，物资守恒：入库 = 剩余 + 已发放', () => {
  const db = setup();
  receiveBatch(db, { shelterId: 1, itemCode: 'MEAL', qty: 10, source: '捐赠A' });
  receiveBatch(db, { shelterId: 1, itemCode: 'MEAL', qty: 5, source: '捐赠B' });
  distribute(db, { shelterId: 1, householdCode: 'HH-1', itemCode: 'MEAL', qty: 12 });
  assert.equal(stockOf(db, 1, 'MEAL'), 3);
  const batches = db.prepare('SELECT SUM(qty_initial) AS init, SUM(qty_remaining) AS rem FROM inventory_batches').get() as any;
  const issued = db.prepare("SELECT COALESCE(SUM(qty),0) AS q FROM distributions WHERE status='issued'").get() as any;
  assert.equal(batches.init, batches.rem + issued.q);
});

test('短缺时返回明确缺口，不产生负库存', () => {
  const db = setup();
  receiveBatch(db, { shelterId: 1, itemCode: 'MEAL', qty: 3, source: '捐赠A' });
  try {
    distribute(db, { shelterId: 1, householdCode: 'HH-1', itemCode: 'MEAL', qty: 5 });
    assert.fail('应抛出短缺');
  } catch (err: any) {
    assert.equal(err.code, 'SHORTAGE');
    assert.equal(err.detail.gap, 2);
    assert.equal(err.detail.available, 3);
  }
  assert.equal(stockOf(db, 1, 'MEAL'), 3);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM distributions').get() as any).n, 0);
});

test('幂等键重复发放只执行一次', () => {
  const db = setup();
  receiveBatch(db, { shelterId: 1, itemCode: 'MEAL', qty: 10, source: '捐赠A' });
  const d1 = distribute(db, { shelterId: 1, householdCode: 'HH-1', itemCode: 'MEAL', qty: 4, idempotencyKey: 'req-1' }) as any;
  const d2 = distribute(db, { shelterId: 1, householdCode: 'HH-1', itemCode: 'MEAL', qty: 4, idempotencyKey: 'req-1' }) as any;
  assert.equal(d1.id, d2.id);
  assert.equal(d2.idempotent_replay, true);
  assert.equal(stockOf(db, 1, 'MEAL'), 6);
});

test('撤销只能追加冲正事件，原记录保留', () => {
  const db = setup();
  receiveBatch(db, { shelterId: 1, itemCode: 'MEAL', qty: 10, source: '捐赠A' });
  const d = distribute(db, { shelterId: 1, householdCode: 'HH-1', itemCode: 'MEAL', qty: 4 }) as any;
  reverseDistribution(db, { distributionId: d.id, reason: '错发' });
  const events = db.prepare('SELECT * FROM distribution_events ORDER BY id').all() as any[];
  assert.deepEqual(events.map(e => e.type), ['issue', 'reversal']);
  assert.equal((listDistributions(db)[0] as any).status, 'reversed');
  assert.equal(stockOf(db, 1, 'MEAL'), 10);
  assert.throws(() => reverseDistribution(db, { distributionId: d.id, reason: '再次' }), /已冲正/);
});

test('入库批次幂等：batch_key 重放不重复入库', () => {
  const db = setup();
  receiveBatch(db, { shelterId: 1, itemCode: 'MEAL', qty: 10, source: '夜间导入', batchKey: 'b1' });
  const again = receiveBatch(db, { shelterId: 1, itemCode: 'MEAL', qty: 10, source: '夜间导入', batchKey: 'b1' }) as any;
  assert.equal(again.idempotent_replay, true);
  assert.equal(stockOf(db, 1, 'MEAL'), 10);
});
