import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.ts';
import { createShelter } from '../src/domain/shelters.ts';
import { createHousehold } from '../src/domain/households.ts';
import { checkIn, transfer } from '../src/domain/stays.ts';

test('崩溃恢复：未 checkpoint 的 WAL 数据重开后一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shelter-test-'));
  const dbPath = join(dir, 'crash.db');
  try {
    const db1 = openDb(dbPath);
    createShelter(db1, { code: 'S1', name: '甲点', capacity: { standard: 5 } });
    createHousehold(db1, { code: 'HH-1', size: 2 });
    checkIn(db1, { householdCode: 'HH-1', shelterId: 1 });
    db1.close(); // 不做显式 checkpoint，模拟进程退出
    const db2 = openDb(dbPath);
    const cap = db2.prepare('SELECT occupied FROM shelter_capacity WHERE shelter_id = 1').get() as any;
    assert.equal(cap.occupied, 2);
    const stays = db2.prepare("SELECT COUNT(*) AS n FROM stays WHERE status='active'").get() as any;
    assert.equal(stays.n, 1);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移可重复执行（幂等）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shelter-test-'));
  try {
    const p = join(dir, 'm.db');
    openDb(p).close();
    const db = openDb(p); // 第二次打开重复跑迁移
    const v = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as any;
    assert.ok(v.n >= 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('失败转移原子回滚：容量与在住状态不变', () => {
  const db = openDb(':memory:');
  createShelter(db, { code: 'S1', name: '甲', capacity: { standard: 5 } });
  createShelter(db, { code: 'S2', name: '乙', capacity: { standard: 1 } });
  createHousehold(db, { code: 'HH-1', size: 3 });
  checkIn(db, { householdCode: 'HH-1', shelterId: 1 });
  const before = db.prepare('SELECT * FROM capacity_events').all().length;
  assert.throws(() => transfer(db, { householdCode: 'HH-1', toShelterId: 2 }), /容量不足/);
  const after = db.prepare('SELECT * FROM capacity_events').all().length;
  assert.equal(before, after, '失败转移不得留下容量事件');
  assert.equal((db.prepare('SELECT occupied FROM shelter_capacity WHERE shelter_id=1').get() as any).occupied, 3);
  assert.equal((db.prepare('SELECT occupied FROM shelter_capacity WHERE shelter_id=2').get() as any).occupied, 0);
});
