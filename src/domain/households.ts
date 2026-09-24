import type { DB } from '../db/db.ts';
import { tx } from '../db/db.ts';
import { Errors } from './errors.ts';

export function createHousehold(db: DB, input: { code: string; size: number; needs_accessible?: boolean; members?: { code: string; needs?: Record<string, unknown> }[]; notes?: string }) {
  return tx(db, () => {
    const existing = db.prepare('SELECT id FROM households WHERE code = ?').get(input.code) as any;
    if (existing) return getHousehold(db, existing.id);
    if (!input.size || input.size < 1) throw Errors.invalid('家庭人数必须 >= 1');
    const info = db.prepare('INSERT INTO households (code, size, needs_accessible, notes) VALUES (?, ?, ?, ?)')
      .run(input.code, input.size, input.needs_accessible ? 1 : 0, input.notes ?? '');
    const id = Number(info.lastInsertRowid);
    for (const m of input.members ?? [])
      db.prepare('INSERT INTO household_members (household_id, member_code, needs) VALUES (?, ?, ?)')
        .run(id, m.code, JSON.stringify(m.needs ?? {}));
    return getHousehold(db, id);
  });
}

export function getHousehold(db: DB, id: number) {
  const h = db.prepare('SELECT * FROM households WHERE id = ?').get(id) as any;
  if (!h) throw Errors.notFound(`家庭 ${id}`);
  h.members = db.prepare('SELECT member_code, needs FROM household_members WHERE household_id = ?').all(id)
    .map((m: any) => ({ member_code: m.member_code, needs: JSON.parse(m.needs) }));
  return h;
}

export function findHouseholdByCode(db: DB, code: string) {
  const row = db.prepare('SELECT id FROM households WHERE code = ?').get(code) as any;
  if (!row) throw Errors.notFound(`家庭编号 ${code}`);
  return getHousehold(db, row.id);
}

export function listHouseholds(db: DB) {
  return (db.prepare('SELECT id FROM households ORDER BY id').all() as any[]).map(r => getHousehold(db, r.id));
}
