import type { DB } from '../db/db.ts';
import { tx } from '../db/db.ts';
import { receiveBatch } from './inventory.ts';
import { checkIn } from './stays.ts';

export interface OfflineRecord {
  record_key: string;
  household_code?: string;
  shelter_id?: number;
  item_code?: string;
  qty?: number;
  reason?: string;
}

export interface ApplyResult {
  batch_key: string;
  status: 'applied' | 'duplicate';
  applied: number;
  skipped_duplicates: number;
  conflicts: { record_key: string; kind: string; detail: string }[];
}

// 夜间离线批次导入：整批幂等（batch_key），记录级幂等（record_key），
// 与现场手工登记冲突时不覆盖，记录冲突供审计。
export function applyOfflineBatch(db: DB, input: { batchKey: string; kind: 'checkin_roster' | 'inventory'; records: OfflineRecord[] }): ApplyResult {
  return tx(db, () => {
    const existing = db.prepare('SELECT * FROM offline_batches WHERE batch_key = ?').get(input.batchKey) as any;
    if (existing) {
      return { batch_key: input.batchKey, status: 'duplicate', applied: 0, skipped_duplicates: input.records.length, conflicts: [] };
    }
    const result: ApplyResult = { batch_key: input.batchKey, status: 'applied', applied: 0, skipped_duplicates: 0, conflicts: [] };
    for (const rec of input.records) {
      const recordKey = `${input.batchKey}:${rec.record_key}`;
      const seen = db.prepare('SELECT batch_key FROM offline_batches WHERE batch_key = ?').get(recordKey);
      if (seen) { result.skipped_duplicates++; continue; }
      try {
        if (input.kind === 'checkin_roster') {
          if (!rec.household_code || rec.shelter_id == null) throw new Error('缺少 household_code 或 shelter_id');
          checkIn(db, { householdCode: rec.household_code, shelterId: rec.shelter_id, reason: rec.reason ?? 'offline_batch', source: `offline:${input.batchKey}` });
        } else {
          if (!rec.item_code || rec.shelter_id == null || !rec.qty) throw new Error('缺少 item_code / shelter_id / qty');
          receiveBatch(db, { shelterId: rec.shelter_id, itemCode: rec.item_code, qty: rec.qty, source: `offline:${input.batchKey}`, batchKey: recordKey });
        }
        db.prepare("INSERT INTO offline_batches (batch_key, kind, payload, status) VALUES (?, ?, ?, 'applied')")
          .run(recordKey, input.kind, JSON.stringify(rec));
        result.applied++;
      } catch (err: any) {
        // 冲突（如与手工登记重复入住、容量不足）→ 记录冲突，不中断整批
        db.prepare("INSERT INTO offline_batches (batch_key, kind, payload, status) VALUES (?, ?, ?, 'conflict')")
          .run(recordKey, input.kind, JSON.stringify(rec));
        db.prepare('INSERT INTO conflicts (batch_key, kind, detail) VALUES (?, ?, ?)')
          .run(input.batchKey, rec.record_key, `${err.code ?? 'ERROR'}: ${err.message}`);
        result.conflicts.push({ record_key: rec.record_key, kind: err.code ?? 'ERROR', detail: err.message });
      }
    }
    db.prepare("INSERT INTO offline_batches (batch_key, kind, payload, status) VALUES (?, ?, ?, 'applied')")
      .run(input.batchKey, input.kind, JSON.stringify({ record_count: input.records.length }));
    return result;
  });
}

export function listConflicts(db: DB) {
  return db.prepare('SELECT * FROM conflicts ORDER BY id').all();
}
