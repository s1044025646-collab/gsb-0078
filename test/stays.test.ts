import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/db.ts';
import { createShelter, getShelter } from '../src/domain/shelters.ts';
import { createHousehold } from '../src/domain/households.ts';
import { reserve, checkIn, transfer, depart, expireReservations } from '../src/domain/stays.ts';

function setup() {
  const db = openDb(':memory:');
  createShelter(db, { code: 'S1', name: '甲点', capacity: { standard: 5, accessible: 2 } });
  createShelter(db, { code: 'S2', name: '乙点', capacity: { standard: 3, accessible: 0 } });
  return db;
}

const cap = (db: any, id: number, type: string) =>
  (getShelter(db, id).capacity as any[]).find(c => c.bed_type === type);

test('家庭整体分配到同一安置点，不拆分', () => {
  const db = setup();
  createHousehold(db, { code: 'HH-1', size: 4 });
  checkIn(db, { householdCode: 'HH-1', shelterId: 1 });
  assert.equal(cap(db, 1, 'standard').occupied, 4);
  const stays = db.prepare("SELECT * FROM stays WHERE household_id = 1 AND status = 'active'").all();
  assert.equal(stays.length, 1);
  assert.equal((stays[0] as any).beds, 4);
});

test('无障碍需求家庭分配无障碍床位', () => {
  const db = setup();
  createHousehold(db, { code: 'HH-A', size: 2, needs_accessible: true });
  checkIn(db, { householdCode: 'HH-A', shelterId: 1 });
  assert.equal(cap(db, 1, 'accessible').occupied, 2);
  assert.equal(cap(db, 1, 'standard').occupied, 0);
});

test('无障碍床位不足时明确报错且不产生部分占用', () => {
  const db = setup();
  createHousehold(db, { code: 'HH-A', size: 3, needs_accessible: true });
  assert.throws(() => checkIn(db, { householdCode: 'HH-A', shelterId: 1 }), /容量不足/);
  assert.equal(cap(db, 1, 'accessible').occupied, 0);
});

test('同一家庭不能重复安排到两个有效安置点', () => {
  const db = setup();
  createHousehold(db, { code: 'HH-1', size: 2 });
  checkIn(db, { householdCode: 'HH-1', shelterId: 1 });
  assert.throws(() => checkIn(db, { householdCode: 'HH-1', shelterId: 2 }), /不能重复入住/);
  assert.throws(() => reserve(db, { householdCode: 'HH-1', shelterId: 2 }), /不能重复预留/);
});

test('预留占用容量，过期后自动释放', () => {
  const db = setup();
  createHousehold(db, { code: 'HH-1', size: 2 });
  reserve(db, { householdCode: 'HH-1', shelterId: 1, ttlMinutes: 1 });
  assert.equal(cap(db, 1, 'standard').reserved, 2);
  const expired = expireReservations(db, new Date(Date.now() + 120000).toISOString());
  assert.equal(expired, 1);
  assert.equal(cap(db, 1, 'standard').reserved, 0);
});

test('过期预留不能入住', () => {
  const db = setup();
  createHousehold(db, { code: 'HH-1', size: 2 });
  reserve(db, { householdCode: 'HH-1', shelterId: 1, ttlMinutes: -1 });
  assert.throws(() => checkIn(db, { householdCode: 'HH-1' }), /预留已过期/);
});

test('预留幂等键重复请求返回同一预留', () => {
  const db = setup();
  createHousehold(db, { code: 'HH-1', size: 2 });
  const r1 = reserve(db, { householdCode: 'HH-1', shelterId: 1, idempotencyKey: 'k1' });
  const r2 = reserve(db, { householdCode: 'HH-1', shelterId: 1, idempotencyKey: 'k1' });
  assert.equal((r1 as any).id, (r2 as any).id);
  assert.equal(cap(db, 1, 'standard').reserved, 2);
});

test('转移原子性：目标点容量不足时整体回滚', () => {
  const db = setup();
  createHousehold(db, { code: 'HH-1', size: 4 });
  checkIn(db, { householdCode: 'HH-1', shelterId: 1 });
  assert.throws(() => transfer(db, { householdCode: 'HH-1', toShelterId: 2 }), /容量不足/);
  assert.equal(cap(db, 1, 'standard').occupied, 4);
  assert.equal(cap(db, 2, 'standard').occupied, 0);
  const stay = db.prepare("SELECT * FROM stays WHERE household_id = 1").get() as any;
  assert.equal(stay.shelter_id, 1);
});

test('转移成功后源点释放、目标点占用，容量守恒', () => {
  const db = setup();
  createHousehold(db, { code: 'HH-1', size: 2 });
  checkIn(db, { householdCode: 'HH-1', shelterId: 1 });
  transfer(db, { householdCode: 'HH-1', toShelterId: 2 });
  assert.equal(cap(db, 1, 'standard').occupied, 0);
  assert.equal(cap(db, 2, 'standard').occupied, 2);
  const events = db.prepare('SELECT * FROM stay_events ORDER BY id').all() as any[];
  assert.deepEqual(events.map(e => e.type), ['check_in', 'transfer_out', 'transfer_in']);
});

test('离开释放床位，容量守恒', () => {
  const db = setup();
  createHousehold(db, { code: 'HH-1', size: 3 });
  checkIn(db, { householdCode: 'HH-1', shelterId: 1 });
  depart(db, { householdCode: 'HH-1' });
  assert.equal(cap(db, 1, 'standard').occupied, 0);
  assert.throws(() => depart(db, { householdCode: 'HH-1' }), /无有效入住/);
});

test('容量变化均记录事件与快照', () => {
  const db = setup();
  createHousehold(db, { code: 'HH-1', size: 2 });
  checkIn(db, { householdCode: 'HH-1', shelterId: 1 });
  const events = db.prepare('SELECT * FROM capacity_events').all() as any[];
  assert.ok(events.length >= 3);
  assert.ok(events.every(e => e.reason && e.source));
  const snaps = db.prepare('SELECT * FROM capacity_snapshots ORDER BY id').all() as any[];
  const last = snaps[snaps.length - 1];
  assert.equal(last.occupied, 2);
});
