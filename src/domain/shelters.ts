import type { DB } from '../db/db.ts';
import { tx, now } from '../db/db.ts';
import { Errors } from './errors.ts';

export interface CapacityRow { shelter_id: number; bed_type: string; total: number; occupied: number; reserved: number }

export function createShelter(db: DB, input: { code: string; name: string; address?: string; facilities?: string[]; capacity: Record<string, number> }) {
  return tx(db, () => {
    const existing = db.prepare('SELECT id FROM shelters WHERE code = ?').get(input.code) as any;
    if (existing) return getShelter(db, existing.id);
    const info = db.prepare('INSERT INTO shelters (code, name, address) VALUES (?, ?, ?)')
      .run(input.code, input.name, input.address ?? '');
    const id = Number(info.lastInsertRowid);
    for (const f of input.facilities ?? [])
      db.prepare('INSERT OR IGNORE INTO shelter_facilities (shelter_id, facility) VALUES (?, ?)').run(id, f);
    for (const [bedType, total] of Object.entries(input.capacity))
      setCapacity(db, id, bedType, total, 'initial_config', 'cli');
    return getShelter(db, id);
  });
}

export function setCapacity(db: DB, shelterId: number, bedType: string, total: number, reason: string, source: string) {
  return tx(db, () => {
    const cur = db.prepare('SELECT * FROM shelter_capacity WHERE shelter_id = ? AND bed_type = ?').get(shelterId, bedType) as unknown as CapacityRow | undefined;
    const occupied = cur?.occupied ?? 0;
    const reserved = cur?.reserved ?? 0;
    if (total < occupied + reserved)
      throw Errors.capacity({ bed_type: bedType, requested_total: total, occupied, reserved });
    db.prepare(`INSERT INTO shelter_capacity (shelter_id, bed_type, total, occupied, reserved) VALUES (?, ?, ?, 0, 0)
      ON CONFLICT (shelter_id, bed_type) DO UPDATE SET total = excluded.total`).run(shelterId, bedType, total);
    const delta = total - (cur?.total ?? 0);
    db.prepare('INSERT INTO capacity_events (shelter_id, bed_type, delta_total, reason, source) VALUES (?, ?, ?, ?, ?)')
      .run(shelterId, bedType, delta, reason, source);
    snapshot(db, shelterId, bedType, reason);
    return db.prepare('SELECT * FROM shelter_capacity WHERE shelter_id = ? AND bed_type = ?').get(shelterId, bedType);
  });
}

export function adjustOccupancy(db: DB, shelterId: number, bedType: string, dOcc: number, dRes: number, reason: string, source: string) {
  const cur = db.prepare('SELECT * FROM shelter_capacity WHERE shelter_id = ? AND bed_type = ?').get(shelterId, bedType) as unknown as CapacityRow | undefined;
  if (!cur) throw Errors.capacity({ bed_type: bedType, available: 0 });
  const occ = cur.occupied + dOcc;
  const res = cur.reserved + dRes;
  if (occ < 0 || res < 0 || occ + res > cur.total)
    throw Errors.capacity({ bed_type: bedType, total: cur.total, occupied: cur.occupied, reserved: cur.reserved, want_occupied: occ, want_reserved: res });
  db.prepare('UPDATE shelter_capacity SET occupied = ?, reserved = ? WHERE shelter_id = ? AND bed_type = ?').run(occ, res, shelterId, bedType);
  db.prepare('INSERT INTO capacity_events (shelter_id, bed_type, delta_occupied, delta_reserved, reason, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(shelterId, bedType, dOcc, dRes, reason, source);
  snapshot(db, shelterId, bedType, reason);
}

function snapshot(db: DB, shelterId: number, bedType: string, reason: string) {
  const cur = db.prepare('SELECT * FROM shelter_capacity WHERE shelter_id = ? AND bed_type = ?').get(shelterId, bedType) as unknown as CapacityRow;
  db.prepare('INSERT INTO capacity_snapshots (shelter_id, bed_type, total, occupied, reserved, reason) VALUES (?, ?, ?, ?, ?, ?)')
    .run(shelterId, bedType, cur.total, cur.occupied, cur.reserved, reason);
}

export function getShelter(db: DB, id: number) {
  const s = db.prepare('SELECT * FROM shelters WHERE id = ?').get(id) as any;
  if (!s) throw Errors.notFound(`安置点 ${id}`);
  s.facilities = db.prepare('SELECT facility FROM shelter_facilities WHERE shelter_id = ?').all(id).map((r: any) => r.facility);
  s.capacity = db.prepare('SELECT bed_type, total, occupied, reserved FROM shelter_capacity WHERE shelter_id = ?').all(id);
  return s;
}

export function listShelters(db: DB) {
  return (db.prepare('SELECT id FROM shelters ORDER BY id').all() as any[]).map(r => getShelter(db, r.id));
}

export function listCapacitySnapshots(db: DB, shelterId: number) {
  return db.prepare('SELECT * FROM capacity_snapshots WHERE shelter_id = ? ORDER BY id').all(shelterId);
}
