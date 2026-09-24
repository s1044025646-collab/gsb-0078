import type { DB } from '../db/db.ts';
import { tx, now } from '../db/db.ts';
import { Errors } from './errors.ts';
import { findHouseholdByCode } from './households.ts';

export function createItem(db: DB, input: { code: string; name: string; unit?: string; category?: string }) {
  return tx(db, () => {
    const existing = db.prepare('SELECT * FROM items WHERE code = ?').get(input.code) as any;
    if (existing) return existing;
    const info = db.prepare('INSERT INTO items (code, name, unit, category) VALUES (?, ?, ?, ?)')
      .run(input.code, input.name, input.unit ?? '份', input.category ?? 'supply');
    return db.prepare('SELECT * FROM items WHERE id = ?').get(Number(info.lastInsertRowid));
  });
}

export function receiveBatch(db: DB, input: { shelterId: number; itemCode: string; qty: number; source: string; batchKey?: string }) {
  return tx(db, () => {
    if (input.batchKey) {
      const dup = db.prepare('SELECT * FROM inventory_batches WHERE batch_key = ?').get(input.batchKey) as any;
      if (dup) return { ...dup, idempotent_replay: true };
    }
    const item = db.prepare('SELECT * FROM items WHERE code = ?').get(input.itemCode) as any;
    if (!item) throw Errors.notFound(`物资 ${input.itemCode}`);
    if (input.qty <= 0) throw Errors.invalid('入库数量必须 > 0');
    const info = db.prepare(`INSERT INTO inventory_batches (shelter_id, item_id, qty_initial, qty_remaining, source, batch_key)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.shelterId, item.id, input.qty, input.qty, input.source, input.batchKey ?? null);
    return db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(Number(info.lastInsertRowid));
  });
}

export function stockOf(db: DB, shelterId: number, itemCode: string): number {
  const row = db.prepare(`SELECT COALESCE(SUM(b.qty_remaining), 0) AS qty FROM inventory_batches b
    JOIN items i ON i.id = b.item_id WHERE b.shelter_id = ? AND i.code = ?`).get(shelterId, itemCode) as any;
  return row.qty;
}

export function distribute(db: DB, input: { shelterId: number; householdCode: string; itemCode: string; qty: number; idempotencyKey?: string; source?: string }) {
  return tx(db, () => {
    if (input.idempotencyKey) {
      const dup = db.prepare(`SELECT d.*, i.code AS item_code FROM distributions d JOIN items i ON i.id = d.item_id
        WHERE d.idempotency_key = ?`).get(input.idempotencyKey) as any;
      if (dup) return { ...dup, idempotent_replay: true };
    }
    const h = findHouseholdByCode(db, input.householdCode);
    const item = db.prepare('SELECT * FROM items WHERE code = ?').get(input.itemCode) as any;
    if (!item) throw Errors.notFound(`物资 ${input.itemCode}`);
    if (input.qty <= 0) throw Errors.invalid('发放数量必须 > 0');
    const available = stockOf(db, input.shelterId, input.itemCode);
    if (available < input.qty)
      throw Errors.shortage({ item: input.itemCode, requested: input.qty, available, gap: input.qty - available });
    // FIFO 扣减批次，绝不产生负库存
    let remaining = input.qty;
    const batches = db.prepare(`SELECT b.* FROM inventory_batches b JOIN items i ON i.id = b.item_id
      WHERE b.shelter_id = ? AND i.code = ? AND b.qty_remaining > 0 ORDER BY b.received_at, b.id`).all(input.shelterId, input.itemCode) as any[];
    for (const b of batches) {
      if (remaining <= 0) break;
      const take = Math.min(b.qty_remaining, remaining);
      db.prepare('UPDATE inventory_batches SET qty_remaining = qty_remaining - ? WHERE id = ? AND qty_remaining >= ?')
        .run(take, b.id, take);
      remaining -= take;
    }
    if (remaining > 0) throw Errors.shortage({ item: input.itemCode, gap: remaining });
    const info = db.prepare(`INSERT INTO distributions (shelter_id, household_id, item_id, qty, idempotency_key, source)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.shelterId, h.id, item.id, input.qty, input.idempotencyKey ?? null, input.source ?? 'manual');
    const distId = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO distribution_events (distribution_id, type, qty, reason) VALUES (?, 'issue', ?, ?)")
      .run(distId, input.qty, input.source ?? 'manual');
    return db.prepare('SELECT * FROM distributions WHERE id = ?').get(distId);
  });
}

// 撤销只能追加冲正事件，不删除原记录
export function reverseDistribution(db: DB, input: { distributionId: number; reason: string; source?: string }) {
  return tx(db, () => {
    const d = db.prepare('SELECT * FROM distributions WHERE id = ?').get(input.distributionId) as any;
    if (!d) throw Errors.notFound(`发放记录 ${input.distributionId}`);
    if (d.status === 'reversed') throw Errors.conflict('该发放已冲正，不能重复冲正');
    db.prepare("UPDATE distributions SET status = 'reversed' WHERE id = ?").run(d.id);
    db.prepare("INSERT INTO distribution_events (distribution_id, type, qty, reason) VALUES (?, 'reversal', ?, ?)")
      .run(d.id, d.qty, input.reason);
    // 库存回补为新批次，保留历史批次不变
    db.prepare(`INSERT INTO inventory_batches (shelter_id, item_id, qty_initial, qty_remaining, source)
      VALUES (?, ?, 0, ?, ?)`).run(d.shelter_id, d.item_id, d.qty, `reversal_of_distribution_${d.id}`);
    return db.prepare('SELECT * FROM distributions WHERE id = ?').get(d.id);
  });
}

export function listDistributions(db: DB, shelterId?: number) {
  if (shelterId)
    return db.prepare(`SELECT d.*, i.code AS item_code, h.code AS household_code FROM distributions d
      JOIN items i ON i.id = d.item_id JOIN households h ON h.id = d.household_id
      WHERE d.shelter_id = ? ORDER BY d.id`).all(shelterId);
  return db.prepare(`SELECT d.*, i.code AS item_code, h.code AS household_code FROM distributions d
    JOIN items i ON i.id = d.item_id JOIN households h ON h.id = d.household_id ORDER BY d.id`).all();
}
