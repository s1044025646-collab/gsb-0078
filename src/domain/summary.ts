import type { DB } from '../db/db.ts';

// 运营汇总：仅聚合数据，不含任何身份明文（家庭编号也不出现）。
export function operationalSummary(db: DB) {
  const shelters = (db.prepare('SELECT id, code, name, status FROM shelters ORDER BY id').all() as any[]).map(s => {
    const capacity = db.prepare(`SELECT bed_type, total, occupied, reserved,
      (total - occupied - reserved) AS available FROM shelter_capacity WHERE shelter_id = ?`).all(s.id);
    const activeHouseholds = (db.prepare("SELECT COUNT(*) AS n FROM stays WHERE shelter_id = ? AND status = 'active'").get(s.id) as any).n;
    const activeBeds = (db.prepare("SELECT COALESCE(SUM(beds),0) AS n FROM stays WHERE shelter_id = ? AND status = 'active'").get(s.id) as any).n;
    const distributions = db.prepare(`SELECT i.code AS item, i.unit, COALESCE(SUM(CASE WHEN d.status='issued' THEN d.qty ELSE 0 END),0) AS issued,
        COALESCE(SUM(CASE WHEN d.status='reversed' THEN d.qty ELSE 0 END),0) AS reversed
      FROM distributions d JOIN items i ON i.id = d.item_id WHERE d.shelter_id = ? GROUP BY i.code, i.unit`).all(s.id);
    const stock = db.prepare(`SELECT i.code AS item, i.unit, COALESCE(SUM(b.qty_remaining),0) AS remaining
      FROM inventory_batches b JOIN items i ON i.id = b.item_id WHERE b.shelter_id = ? GROUP BY i.code, i.unit`).all(s.id);
    return { shelter_code: s.code, name: s.name, status: s.status, capacity, active_households: activeHouseholds, active_beds: activeBeds, distributions, stock };
  });
  const totals = {
    shelters: shelters.length,
    active_households: shelters.reduce((a, s) => a + s.active_households, 0),
    active_beds: shelters.reduce((a, s) => a + s.active_beds, 0),
    active_reservations: (db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status = 'active'").get() as any).n,
    conflicts: (db.prepare('SELECT COUNT(*) AS n FROM conflicts').get() as any).n,
  };
  return { generated_at: new Date().toISOString(), totals, shelters };
}
