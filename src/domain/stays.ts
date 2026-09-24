import type { DB } from '../db/db.ts';
import { tx, now } from '../db/db.ts';
import { Errors } from './errors.ts';
import { adjustOccupancy } from './shelters.ts';
import { findHouseholdByCode } from './households.ts';

function bedTypeFor(household: any): string {
  return household.needs_accessible ? 'accessible' : 'standard';
}

export function reserve(db: DB, input: { householdCode: string; shelterId: number; ttlMinutes?: number; idempotencyKey?: string; source?: string }) {
  return tx(db, () => {
    if (input.idempotencyKey) {
      const dup = db.prepare('SELECT * FROM reservations WHERE idempotency_key = ?').get(input.idempotencyKey) as any;
      if (dup) return { ...dup, idempotent_replay: true };
    }
    const h = findHouseholdByCode(db, input.householdCode);
    const activeStay = db.prepare("SELECT id FROM stays WHERE household_id = ? AND status = 'active'").get(h.id);
    if (activeStay) throw Errors.conflict('家庭已有有效入住，不能重复预留');
    const activeRes = db.prepare("SELECT id FROM reservations WHERE household_id = ? AND status = 'active'").get(h.id);
    if (activeRes) throw Errors.conflict('家庭已有有效预留，不能重复预留');
    const bedType = bedTypeFor(h);
    adjustOccupancy(db, input.shelterId, bedType, 0, h.size, 'reserve', input.source ?? 'manual');
    const expiresAt = new Date(Date.now() + (input.ttlMinutes ?? 120) * 60000).toISOString();
    const info = db.prepare(`INSERT INTO reservations (household_id, shelter_id, bed_type, beds, expires_at, idempotency_key, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(h.id, input.shelterId, bedType, h.size, expiresAt, input.idempotencyKey ?? null, input.source ?? 'manual');
    return db.prepare('SELECT * FROM reservations WHERE id = ?').get(Number(info.lastInsertRowid));
  });
}

export function expireReservations(db: DB, at?: string): number {
  return tx(db, () => {
    const rows = db.prepare("SELECT * FROM reservations WHERE status = 'active' AND expires_at <= ?").all(at ?? now()) as any[];
    for (const r of rows) {
      db.prepare("UPDATE reservations SET status = 'expired' WHERE id = ?").run(r.id);
      adjustOccupancy(db, r.shelter_id, r.bed_type, 0, -r.beds, 'reservation_expired', 'system');
    }
    return rows.length;
  });
}

export function checkIn(db: DB, input: { householdCode: string; shelterId?: number; reason?: string; source?: string }) {
  return tx(db, () => {
    const h = findHouseholdByCode(db, input.householdCode);
    const dup = db.prepare("SELECT * FROM stays WHERE household_id = ? AND status = 'active'").get(h.id) as any;
    if (dup) throw Errors.conflict('家庭已在住，不能重复入住');
    const res = db.prepare("SELECT * FROM reservations WHERE household_id = ? AND status = 'active'").get(h.id) as any;
    const bedType = res?.bed_type ?? bedTypeFor(h);
    const shelterId = input.shelterId ?? res?.shelter_id;
    if (!shelterId) throw Errors.invalid('未指定安置点且无有效预留');
    if (res && res.shelter_id !== shelterId) throw Errors.invalid('入住安置点与预留不一致');
    if (res && res.expires_at <= now()) throw Errors.conflict('预留已过期，无法入住');
    if (res) {
      db.prepare("UPDATE reservations SET status = 'checked_in' WHERE id = ?").run(res.id);
      adjustOccupancy(db, shelterId, bedType, h.size, -h.size, 'check_in', input.source ?? 'manual');
    } else {
      adjustOccupancy(db, shelterId, bedType, h.size, 0, 'check_in_walkin', input.source ?? 'manual');
    }
    const info = db.prepare('INSERT INTO stays (household_id, shelter_id, bed_type, beds) VALUES (?, ?, ?, ?)')
      .run(h.id, shelterId, bedType, h.size);
    const stayId = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO stay_events (stay_id, household_id, type, to_shelter_id, reason, source) VALUES (?, ?, 'check_in', ?, ?, ?)")
      .run(stayId, h.id, shelterId, input.reason ?? '', input.source ?? 'manual');
    return db.prepare('SELECT * FROM stays WHERE id = ?').get(stayId);
  });
}

export function transfer(db: DB, input: { householdCode: string; toShelterId: number; reason?: string; source?: string }) {
  return tx(db, () => {
    const h = findHouseholdByCode(db, input.householdCode);
    const stay = db.prepare("SELECT * FROM stays WHERE household_id = ? AND status = 'active'").get(h.id) as any;
    if (!stay) throw Errors.conflict('家庭当前无有效入住，无法转移');
    if (stay.shelter_id === input.toShelterId) throw Errors.invalid('目标安置点与当前相同');
    const toBedType = bedTypeFor(h);
    // 先在目标点占位（可能抛容量错误 → 整体回滚），再释放源点
    adjustOccupancy(db, input.toShelterId, toBedType, h.size, 0, 'transfer_in', input.source ?? 'manual');
    adjustOccupancy(db, stay.shelter_id, stay.bed_type, -h.size, 0, 'transfer_out', input.source ?? 'manual');
    db.prepare('UPDATE stays SET shelter_id = ?, bed_type = ? WHERE id = ?').run(input.toShelterId, toBedType, stay.id);
    db.prepare("INSERT INTO stay_events (stay_id, household_id, type, from_shelter_id, to_shelter_id, reason, source) VALUES (?, ?, 'transfer_out', ?, ?, ?, ?)")
      .run(stay.id, h.id, stay.shelter_id, input.toShelterId, input.reason ?? '', input.source ?? 'manual');
    db.prepare("INSERT INTO stay_events (stay_id, household_id, type, from_shelter_id, to_shelter_id, reason, source) VALUES (?, ?, 'transfer_in', ?, ?, ?, ?)")
      .run(stay.id, h.id, stay.shelter_id, input.toShelterId, input.reason ?? '', input.source ?? 'manual');
    return db.prepare('SELECT * FROM stays WHERE id = ?').get(stay.id);
  });
}

export function depart(db: DB, input: { householdCode: string; reason?: string; source?: string }) {
  return tx(db, () => {
    const h = findHouseholdByCode(db, input.householdCode);
    const stay = db.prepare("SELECT * FROM stays WHERE household_id = ? AND status = 'active'").get(h.id) as any;
    if (!stay) throw Errors.conflict('家庭当前无有效入住，无法离开');
    adjustOccupancy(db, stay.shelter_id, stay.bed_type, -stay.beds, 0, 'depart', input.source ?? 'manual');
    db.prepare("UPDATE stays SET status = 'departed', departed_at = ? WHERE id = ?").run(now(), stay.id);
    db.prepare("INSERT INTO stay_events (stay_id, household_id, type, from_shelter_id, reason, source) VALUES (?, ?, 'depart', ?, ?, ?)")
      .run(stay.id, h.id, stay.shelter_id, input.reason ?? '', input.source ?? 'manual');
    return db.prepare('SELECT * FROM stays WHERE id = ?').get(stay.id);
  });
}
