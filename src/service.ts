import type Database from 'better-sqlite3';

export interface MemberInput {
  code: string;
  bedType: string;
  accessibleRequired?: boolean;
}

export interface RosterInput {
  code: string;
  members: MemberInput[];
  checksum?: string;
}

export interface Shortage {
  siteCode?: string;
  sku?: string;
  bedType?: string;
  accessible?: boolean;
  required: number;
  available: number;
  missing: number;
}

function now(): string {
  return new Date().toISOString();
}

function tx<T>(db: Database.Database, fn: () => T): T {
  db.pragma('busy_timeout = 5000');
  return db.transaction(fn).immediate();
}

function recordEvent(db: Database.Database, row: {
  eventType: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  reason: string;
  source: string;
  batchId?: string | null;
  reversesEventId?: number | null;
}): number {
  return Number(db.prepare(`
    INSERT INTO events
    (event_type, entity_type, entity_id, payload, reason, source, batch_id, reverses_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.eventType,
    row.entityType,
    row.entityId,
    JSON.stringify(row.payload),
    row.reason,
    row.source,
    row.batchId ?? null,
    row.reversesEventId ?? null
  ).lastInsertRowid);
}

export class ShelterService {
  constructor(private readonly db: Database.Database) {}

  configureSite(input: {
    code: string;
    name: string;
    capacities: Array<{ bedType: string; accessible: boolean; capacity: number }>;
    reason: string;
    source?: string;
  }): { siteId: number } {
    return tx(this.db, () => {
      const existing = this.db.prepare('SELECT id FROM sites WHERE code=?').get(input.code) as { id: number } | undefined;
      let siteId: number;
      if (existing) {
        siteId = existing.id;
        this.db.prepare('UPDATE sites SET name=?, active=1 WHERE id=?').run(input.name, siteId);
      } else {
        siteId = Number(this.db.prepare('INSERT INTO sites(code, name) VALUES (?,?)').run(input.code, input.name).lastInsertRowid);
      }
      for (const pool of input.capacities) {
        this.setCapacity(siteId, input.code, pool, input.reason, input.source ?? 'manual');
      }
      recordEvent(this.db, {
        eventType: 'site.configured',
        entityType: 'site',
        entityId: input.code,
        payload: { name: input.name, capacities: input.capacities },
        reason: input.reason,
        source: input.source ?? 'manual'
      });
      return { siteId };
    });
  }

  private setCapacity(
    siteId: number,
    siteCode: string,
    pool: { bedType: string; accessible: boolean; capacity: number },
    reason: string,
    source: string,
    batchId?: string
  ): void {
    if (!Number.isInteger(pool.capacity) || pool.capacity < 0) throw new Error('capacity must be a non-negative integer');
    const accessible = pool.accessible ? 1 : 0;
    const occupied = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM assignments
      WHERE site_id=? AND released_at IS NULL AND bed_type=? AND accessible=?
    `).get(siteId, pool.bedType, accessible) as { count: number }).count;
    const reserved = (this.db.prepare(`
      SELECT COALESCE(SUM(u.seats),0) AS count
      FROM reservation_units u JOIN reservation_groups g ON g.id=u.group_id
      WHERE g.site_id=? AND g.status='active' AND u.bed_type=? AND u.accessible=?
    `).get(siteId, pool.bedType, accessible) as { count: number }).count;
    if (pool.capacity < occupied + reserved) {
      throw new Error('capacity cannot be lower than current occupied and reserved beds');
    }
    this.db.prepare(`
      INSERT INTO capacity_pools(site_id, bed_type, accessible, capacity, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(site_id, bed_type, accessible)
      DO UPDATE SET capacity=excluded.capacity, updated_at=excluded.updated_at
    `).run(siteId, pool.bedType, accessible, pool.capacity, now());
    this.db.prepare(`
      INSERT INTO capacity_history(site_id, bed_type, accessible, capacity, source, reason, batch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(siteId, pool.bedType, accessible, pool.capacity, source, reason, batchId ?? null);
    recordEvent(this.db, {
      eventType: 'capacity.changed',
      entityType: 'capacity',
      entityId: `${siteCode}:${pool.bedType}:${accessible}`,
      payload: { capacity: pool.capacity },
      reason,
      source,
      batchId
    });
  }

  importRoster(input: RosterInput, source = 'manual', batchId?: string): { householdId: number } {
    return tx(this.db, () => {
      if (!input.members.length) throw new Error('household requires at least one member');
      const existing = this.db.prepare('SELECT id, size FROM households WHERE code=?').get(input.code) as
        | { id: number; size: number }
        | undefined;
      if (existing) {
        if (existing.size !== input.members.length) throw new Error(`household conflict: ${input.code}`);
        return { householdId: existing.id };
      }
      const householdId = Number(this.db.prepare(`
        INSERT INTO households(code, size, accessible_need, checksum)
        VALUES (?, ?, ?, ?)
      `).run(
        input.code,
        input.members.length,
        input.members.some(member => member.accessibleRequired) ? 1 : 0,
        input.checksum ?? null
      ).lastInsertRowid);
      for (const member of input.members) {
        this.db.prepare(`
          INSERT INTO members(household_id, code, bed_type, accessible_required)
          VALUES (?, ?, ?, ?)
        `).run(householdId, member.code, member.bedType, member.accessibleRequired ? 1 : 0);
      }
      recordEvent(this.db, {
        eventType: 'household.imported',
        entityType: 'household',
        entityId: input.code,
        payload: {
          size: input.members.length,
          accessibleNeed: input.members.some(member => member.accessibleRequired)
        },
        reason: 'roster import',
        source,
        batchId
      });
      return { householdId };
    });
  }

  reserve(input: {
    reservationCode: string;
    householdCode: string;
    siteCode: string;
    expiresAt: string;
    reason: string;
    source?: string;
    batchId?: string;
  }): { status: 'reserved'; shortages: Shortage[] } {
    return tx(this.db, () => {
      this.expireReservations();
      const household = this.requireHousehold(input.householdCode);
      const site = this.requireSite(input.siteCode);
      this.assertNoOtherActiveSite(household.id, site.id, input.siteCode);
      const sameCode = this.db.prepare(`
        SELECT household_id, site_id, status FROM reservation_groups WHERE code=?
      `).get(input.reservationCode) as { household_id: number; site_id: number; status: string } | undefined;
      if (sameCode) {
        if (
          sameCode.status === 'active' &&
          sameCode.household_id === household.id &&
          sameCode.site_id === site.id
        ) return { status: 'reserved', shortages: [] };
        throw new Error(`reservation code conflict: ${input.reservationCode}`);
      }
      const activeReservation = this.db.prepare(`
        SELECT s.code FROM reservation_groups r JOIN sites s ON s.id=r.site_id
        WHERE r.household_id=? AND r.status='active'
      `).get(household.id) as { code: string } | undefined;
      if (activeReservation) throw new Error(`household already reserved at ${activeReservation.code}`);
      const demand = this.householdDemand(household.id);
      const shortages = this.capacityShortages(site.id, input.siteCode, demand);
      if (shortages.length) throw Object.assign(new Error('insufficient capacity'), { shortages });

      const groupId = Number(this.db.prepare(`
        INSERT INTO reservation_groups
        (code, household_id, site_id, status, expires_at, reason, source, batch_id)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
      `).run(
        input.reservationCode,
        household.id,
        site.id,
        input.expiresAt,
        input.reason,
        input.source ?? 'manual',
        input.batchId ?? null
      ).lastInsertRowid);
      for (const pool of demand) {
        this.db.prepare(`
          INSERT INTO reservation_units(group_id, bed_type, accessible, seats)
          VALUES (?, ?, ?, ?)
        `).run(groupId, pool.bedType, pool.accessible, pool.seats);
      }
      recordEvent(this.db, {
        eventType: 'reservation.created',
        entityType: 'reservation',
        entityId: input.reservationCode,
        payload: {
          householdCode: input.householdCode,
          siteCode: input.siteCode,
          expiresAt: input.expiresAt,
          demand
        },
        reason: input.reason,
        source: input.source ?? 'manual',
        batchId: input.batchId
      });
      return { status: 'reserved', shortages: [] };
    });
  }

  expireReservations(timestamp = now()): number {
    return tx(this.db, () => this.expireReservationsInternal(timestamp));
  }

  private expireReservationsInternal(timestamp = now()): number {
    const rows = this.db.prepare(`
      SELECT id, code FROM reservation_groups
      WHERE status='active' AND expires_at <= ?
    `).all(timestamp) as Array<{ id: number; code: string }>;
    for (const row of rows) {
      this.db.prepare("UPDATE reservation_groups SET status='expired' WHERE id=?").run(row.id);
      recordEvent(this.db, {
        eventType: 'reservation.expired',
        entityType: 'reservation',
        entityId: row.code,
        payload: { expiredAt: timestamp },
        reason: 'reservation expiry',
        source: 'system'
      });
    }
    return rows.length;
  }

  private requireHousehold(code: string) {
    const household = this.db.prepare('SELECT id, code, size FROM households WHERE code=?').get(code) as
      | { id: number; code: string; size: number }
      | undefined;
    if (!household) throw new Error(`unknown household: ${code}`);
    return household;
  }

  private requireSite(code: string) {
    const site = this.db.prepare('SELECT id, code FROM sites WHERE code=? AND active=1').get(code) as
      | { id: number; code: string }
      | undefined;
    if (!site) throw new Error(`unknown active site: ${code}`);
    return site;
  }

  private assertNoOtherActiveSite(householdId: number, siteId: number, siteCode: string): void {
    const placement = this.db.prepare(`
      SELECT s.code FROM placements p JOIN sites s ON s.id=p.site_id
      WHERE p.household_id=? AND p.status='active' AND p.site_id<>?
    `).get(householdId, siteId) as { code: string } | undefined;
    if (placement) throw new Error(`household already sheltered at ${placement.code}`);
    const reservation = this.db.prepare(`
      SELECT s.code FROM reservation_groups r JOIN sites s ON s.id=r.site_id
      WHERE r.household_id=? AND r.status='active' AND r.site_id<>?
    `).get(householdId, siteId) as { code: string } | undefined;
    if (reservation) throw new Error(`household already reserved at ${reservation.code}`);
  }

  private householdDemand(householdId: number): Array<{ bedType: string; accessible: 0 | 1; seats: number }> {
    const rows = this.db.prepare(`
      SELECT bed_type, accessible_required, COUNT(*) AS seats
      FROM members WHERE household_id=?
      GROUP BY bed_type, accessible_required
    `).all(householdId) as Array<{ bed_type: string; accessible_required: number; seats: number }>;
    return rows.map(row => ({ bedType: row.bed_type, accessible: row.accessible_required as 0 | 1, seats: row.seats }));
  }

  private poolOccupancy(siteId: number, bedType: string, accessible: number): number {
    const assignmentCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM assignments a
      WHERE a.site_id=? AND a.released_at IS NULL AND a.bed_type=? AND a.accessible=?
    `).get(siteId, bedType, accessible) as { count: number };
    const reservationCount = this.db.prepare(`
      SELECT COALESCE(SUM(u.seats),0) AS count
      FROM reservation_units u JOIN reservation_groups g ON g.id=u.group_id
      WHERE g.site_id=? AND g.status='active' AND u.bed_type=? AND u.accessible=?
    `).get(siteId, bedType, accessible) as { count: number };
    return assignmentCount.count + reservationCount.count;
  }

  private capacityShortages(
    siteId: number,
    siteCode: string,
    demand: Array<{ bedType: string; accessible: 0 | 1; seats: number }>
  ): Shortage[] {
    return demand.flatMap(pool => {
      const capacityRow = this.db.prepare(`
        SELECT capacity FROM capacity_pools
        WHERE site_id=? AND bed_type=? AND accessible=?
      `).get(siteId, pool.bedType, pool.accessible) as { capacity: number } | undefined;
      const capacity = capacityRow?.capacity ?? 0;
      const used = this.poolOccupancy(siteId, pool.bedType, pool.accessible);
      const available = capacity - used;
      const missing = pool.seats - available;
      return missing > 0
        ? [{
            siteCode,
            bedType: pool.bedType,
            accessible: pool.accessible === 1,
            required: pool.seats,
            available: Math.max(0, available),
            missing
          }]
        : [];
    });
  }

  checkIn(input: {
    householdCode: string;
    siteCode: string;
    reason: string;
    source?: string;
    reservationCode?: string;
  }): { status: 'checked_in'; shortages: Shortage[] } {
    return tx(this.db, () => {
      this.expireReservationsInternal();
      const household = this.requireHousehold(input.householdCode);
      const site = this.requireSite(input.siteCode);
      this.assertNoOtherActiveSite(household.id, site.id, input.siteCode);
      const existing = this.db.prepare("SELECT id FROM placements WHERE household_id=? AND site_id=? AND status='active'")
        .get(household.id, site.id);
      if (existing) return { status: 'checked_in', shortages: [] };

      if (input.reservationCode) {
        const reservation = this.db.prepare(`
          SELECT id, status FROM reservation_groups
          WHERE code=? AND household_id=? AND site_id=?
        `).get(input.reservationCode, household.id, site.id) as { id: number; status: string } | undefined;
        if (!reservation || reservation.status !== 'active') {
          throw new Error('reservation is not active for this household and site');
        }
        this.db.prepare("UPDATE reservation_groups SET status='consumed' WHERE id=?").run(reservation.id);
      }

      const demand = this.householdDemand(household.id);
      const shortages = this.capacityShortages(site.id, input.siteCode, demand);
      if (shortages.length) throw Object.assign(new Error('insufficient capacity'), { shortages });

      const placementId = Number(this.db.prepare(`
        INSERT INTO placements(household_id, site_id, status, reason, source)
        VALUES (?, ?, 'active', ?, ?)
      `).run(household.id, site.id, input.reason, input.source ?? 'manual').lastInsertRowid);
      const members = this.db.prepare(`
        SELECT id, bed_type, accessible_required FROM members WHERE household_id=? ORDER BY id
      `).all(household.id) as Array<{ id: number; bed_type: string; accessible_required: number }>;
      for (const member of members) {
        this.db.prepare(`
          INSERT INTO assignments(placement_id, member_id, site_id, bed_type, accessible)
          VALUES (?, ?, ?, ?, ?)
        `).run(placementId, member.id, site.id, member.bed_type, member.accessible_required);
      }
      this.cancelOtherReservations(household.id, site.id, input.reason, input.source ?? 'manual');
      recordEvent(this.db, {
        eventType: 'household.checked_in',
        entityType: 'household',
        entityId: input.householdCode,
        payload: { siteCode: input.siteCode, reservationCode: input.reservationCode ?? null },
        reason: input.reason,
        source: input.source ?? 'manual'
      });
      return { status: 'checked_in', shortages: [] };
    });
  }

  transfer(input: {
    householdCode: string;
    fromSiteCode: string;
    toSiteCode: string;
    reason: string;
    source?: string;
  }): { status: 'transferred'; shortages: Shortage[] } {
    return tx(this.db, () => {
      if (input.fromSiteCode === input.toSiteCode) throw new Error('source and destination sites must differ');
      const household = this.requireHousehold(input.householdCode);
      const fromSite = this.requireSite(input.fromSiteCode);
      const toSite = this.requireSite(input.toSiteCode);
      const placement = this.db.prepare(`
        SELECT id FROM placements WHERE household_id=? AND site_id=? AND status='active'
      `).get(household.id, fromSite.id) as { id: number } | undefined;
      if (!placement) throw new Error('household has no active placement at source site');
      const demand = this.householdDemand(household.id);
      const shortages = this.capacityShortages(toSite.id, input.toSiteCode, demand);
      if (shortages.length) throw Object.assign(new Error('insufficient destination capacity'), { shortages });

      this.db.prepare("UPDATE placements SET status='transferred', ended_at=?, reason=? WHERE id=?")
        .run(now(), input.reason, placement.id);
      this.db.prepare('UPDATE assignments SET released_at=? WHERE placement_id=? AND released_at IS NULL')
        .run(now(), placement.id);
      this.db.prepare("UPDATE reservation_groups SET status='cancelled' WHERE household_id=? AND site_id=? AND status='active'")
        .run(household.id, fromSite.id);

      const newPlacementId = Number(this.db.prepare(`
        INSERT INTO placements(household_id, site_id, status, reason, source)
        VALUES (?, ?, 'active', ?, ?)
      `).run(household.id, toSite.id, input.reason, input.source ?? 'manual').lastInsertRowid);
      const members = this.db.prepare('SELECT id, bed_type, accessible_required FROM members WHERE household_id=? ORDER BY id')
        .all(household.id) as Array<{ id: number; bed_type: string; accessible_required: number }>;
      for (const member of members) {
        this.db.prepare(`
          INSERT INTO assignments(placement_id, member_id, site_id, bed_type, accessible)
          VALUES (?, ?, ?, ?, ?)
        `).run(newPlacementId, member.id, toSite.id, member.bed_type, member.accessible_required);
      }
      recordEvent(this.db, {
        eventType: 'household.transferred',
        entityType: 'household',
        entityId: input.householdCode,
        payload: { fromSiteCode: input.fromSiteCode, toSiteCode: input.toSiteCode },
        reason: input.reason,
        source: input.source ?? 'manual'
      });
      return { status: 'transferred', shortages: [] };
    });
  }

  leave(input: {
    householdCode: string;
    siteCode: string;
    reason: string;
    source?: string;
  }): { status: 'left' } {
    return tx(this.db, () => {
      const household = this.requireHousehold(input.householdCode);
      const site = this.requireSite(input.siteCode);
      const placement = this.db.prepare(`
        SELECT id FROM placements WHERE household_id=? AND site_id=? AND status='active'
      `).get(household.id, site.id) as { id: number } | undefined;
      if (!placement) throw new Error('household has no active placement at this site');
      this.db.prepare("UPDATE placements SET status='left', ended_at=?, reason=? WHERE id=?")
        .run(now(), input.reason, placement.id);
      this.db.prepare('UPDATE assignments SET released_at=? WHERE placement_id=? AND released_at IS NULL')
        .run(now(), placement.id);
      this.db.prepare("UPDATE reservation_groups SET status='cancelled' WHERE household_id=? AND site_id=? AND status='active'")
        .run(household.id, site.id);
      recordEvent(this.db, {
        eventType: 'household.left',
        entityType: 'household',
        entityId: input.householdCode,
        payload: { siteCode: input.siteCode },
        reason: input.reason,
        source: input.source ?? 'manual'
      });
      return { status: 'left' };
    });
  }

  private cancelOtherReservations(householdId: number, siteId: number, reason: string, source: string): void {
    const rows = this.db.prepare(`
      UPDATE reservation_groups SET status='cancelled'
      WHERE household_id=? AND site_id<>? AND status='active'
      RETURNING code
    `).all(householdId, siteId) as Array<{ code: string }>;
    for (const row of rows) {
      recordEvent(this.db, {
        eventType: 'reservation.cancelled',
        entityType: 'reservation',
        entityId: row.code,
        payload: {},
        reason,
        source
      });
    }
  }

  addInventoryBatch(input: {
    code: string;
    sku: string;
    kind: 'meal' | 'supply';
    quantity: number;
    unit: string;
    source: string;
    reason?: string;
    batchId?: string;
  }): { batchId: number } {
    return tx(this.db, () => {
      if (!Number.isInteger(input.quantity) || input.quantity < 0) {
        throw new Error('quantity must be a non-negative integer');
      }
      const existing = this.db.prepare('SELECT id FROM inventory_batches WHERE code=?').get(input.code) as
        | { id: number }
        | undefined;
      if (existing) return { batchId: existing.id };
      const batchId = Number(this.db.prepare(`
        INSERT INTO inventory_batches(code, sku, kind, quantity, unit, source)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.code, input.sku, input.kind, input.quantity, input.unit, input.source).lastInsertRowid);
      this.db.prepare(`
        INSERT INTO inventory_history(batch_id, delta, balance_after, reason, source, batch_import_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        batchId,
        input.quantity,
        input.quantity,
        input.reason ?? 'batch received',
        input.source,
        input.batchId ?? null
      );
      recordEvent(this.db, {
        eventType: 'inventory.received',
        entityType: 'inventory_batch',
        entityId: input.code,
        payload: { sku: input.sku, quantity: input.quantity, unit: input.unit, kind: input.kind },
        reason: input.reason ?? 'batch received',
        source: input.source,
        batchId: input.batchId
      });
      return { batchId };
    });
  }

  issueItems(input: {
    requestKey: string;
    householdCode: string;
    sku: string;
    quantity: number;
    source?: string;
  }): {
    status: 'issued' | 'shortage' | 'duplicate';
    requestKey: string;
    issuedQuantity: number;
    shortage: number;
    allocations: Array<{ batchCode: string; quantity: number }>;
  } {
    return tx(this.db, () => {
      if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
        throw new Error('quantity must be a positive integer');
      }
      const household = this.requireHousehold(input.householdCode);
      const duplicate = this.db.prepare(`
        SELECT request_key, issued_quantity, shortage, status, unit
        FROM issues WHERE request_key=?
      `).get(input.requestKey) as
        | { request_key: string; issued_quantity: number; shortage: number; status: 'issued' | 'shortage'; unit: string }
        | undefined;
      if (duplicate) {
        return {
          status: 'duplicate',
          requestKey: duplicate.request_key,
          issuedQuantity: duplicate.issued_quantity,
          shortage: duplicate.shortage,
          allocations: []
        };
      }

      const batches = this.db.prepare(`
        SELECT id, code, quantity, unit FROM inventory_batches
        WHERE sku=? AND active=1 AND quantity>0
        ORDER BY received_at, id
      `).all(input.sku) as Array<{ id: number; code: string; quantity: number; unit: string }>;
      if (!batches.length) throw new Error(`unknown or exhausted sku: ${input.sku}`);
      const unit = batches[0].unit;
      let remaining = input.quantity;
      const allocations: Array<{ batchCode: string; quantity: number; batchId: number }> = [];
      for (const batch of batches) {
        if (remaining === 0) break;
        const take = Math.min(batch.quantity, remaining);
        allocations.push({ batchCode: batch.code, quantity: take, batchId: batch.id });
        remaining -= take;
      }
      const issuedQuantity = input.quantity - remaining;
      const issueId = Number(this.db.prepare(`
        INSERT INTO issues
        (request_key, household_id, sku, requested_quantity, issued_quantity, unit, status, shortage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.requestKey,
        household.id,
        input.sku,
        input.quantity,
        issuedQuantity,
        unit,
        remaining > 0 ? 'shortage' : 'issued',
        remaining
      ).lastInsertRowid);
      for (const allocation of allocations) {
        this.db.prepare('UPDATE inventory_batches SET quantity=quantity-? WHERE id=?')
          .run(allocation.quantity, allocation.batchId);
        const balance = (this.db.prepare('SELECT quantity FROM inventory_batches WHERE id=?')
          .get(allocation.batchId) as { quantity: number }).quantity;
        this.db.prepare(`
          INSERT INTO issue_items(issue_id, batch_id, quantity) VALUES (?, ?, ?)
        `).run(issueId, allocation.batchId, allocation.quantity);
        this.db.prepare(`
          INSERT INTO inventory_history(batch_id, delta, balance_after, reason, source)
          VALUES (?, ?, ?, ?, ?)
        `).run(allocation.batchId, -allocation.quantity, balance, `issue ${input.requestKey}`, input.source ?? 'manual');
      }
      recordEvent(this.db, {
        eventType: remaining > 0 ? 'items.shortage' : 'items.issued',
        entityType: 'issue',
        entityId: input.requestKey,
        payload: {
          householdCode: input.householdCode,
          sku: input.sku,
          requested: input.quantity,
          issued: issuedQuantity,
          shortage: remaining,
          allocations: allocations.map(allocation => ({ batchCode: allocation.batchCode, quantity: allocation.quantity }))
        },
        reason: remaining > 0 ? 'insufficient inventory' : 'manual issue',
        source: input.source ?? 'manual'
      });
      return {
        status: remaining > 0 ? 'shortage' : 'issued',
        requestKey: input.requestKey,
        issuedQuantity,
        shortage: remaining,
        allocations: allocations.map(allocation => ({ batchCode: allocation.batchCode, quantity: allocation.quantity }))
      };
    });
  }

  applyOfflineBatch(input: {
    batchId: string;
    checksum: string;
    operations: Array<Record<string, unknown>>;
    source?: string;
  }): { status: 'applied' | 'replayed' | 'rejected'; conflicts: string[] } {
    const seen = this.db.prepare('SELECT checksum, status, conflicts FROM batch_imports WHERE id=?')
      .get(input.batchId) as { checksum: string; status: string; conflicts: string } | undefined;
    if (seen) {
      if (seen.checksum === input.checksum) {
        return { status: 'replayed', conflicts: JSON.parse(seen.conflicts) };
      }
      const conflicts = [`batch ${input.batchId} reused with checksum ${input.checksum}; stored checksum is ${seen.checksum}`];
      tx(this.db, () => {
        recordEvent(this.db, {
          eventType: 'batch.rejected',
          entityType: 'batch_import',
          entityId: input.batchId,
          payload: { expectedChecksum: seen.checksum, actualChecksum: input.checksum },
          reason: 'batch identity conflict',
          source: input.source ?? 'offline'
        });
      });
      return { status: 'rejected', conflicts };
    }

    try {
      tx(this.db, () => {
        const conflicts: string[] = [];
        for (const operation of input.operations) {
          try {
            this.applyBatchOperation(operation, input.source ?? 'offline', input.batchId);
          } catch (error) {
            conflicts.push(String((error as Error).message));
          }
        }
        if (conflicts.length) throw new Error(conflicts.join('; '));
        this.db.prepare('INSERT INTO batch_imports(id, checksum, status, applied_at) VALUES (?,?,?,?)')
          .run(input.batchId, input.checksum, 'applied', now());
        recordEvent(this.db, {
          eventType: 'batch.applied',
          entityType: 'batch_import',
          entityId: input.batchId,
          payload: { operationCount: input.operations.length },
          reason: 'offline batch replay',
          source: input.source ?? 'offline',
          batchId: input.batchId
        });
      });
      return { status: 'applied', conflicts: [] };
    } catch (error) {
      const conflicts = String((error as Error).message).split('; ');
      tx(this.db, () => {
        this.db.prepare('INSERT INTO batch_imports(id, checksum, status, conflicts, applied_at) VALUES (?,?,?,?,?)')
          .run(input.batchId, input.checksum, 'rejected', JSON.stringify(conflicts), now());
        recordEvent(this.db, {
          eventType: 'batch.rejected',
          entityType: 'batch_import',
          entityId: input.batchId,
          payload: { operationCount: input.operations.length, conflicts },
          reason: 'offline batch conflicts',
          source: input.source ?? 'offline',
          batchId: input.batchId
        });
      });
      return { status: 'rejected', conflicts };
    }
  }

  private applyBatchOperation(operation: Record<string, unknown>, source: string, batchId: string): void {
    switch (operation.type) {
      case 'roster':
        this.importRoster({
          code: String(operation.householdCode),
          members: (operation.members as MemberInput[]).map(member => ({
            code: member.code,
            bedType: member.bedType,
            accessibleRequired: member.accessibleRequired
          })),
          checksum: operation.checksum as string | undefined
        }, source, batchId);
        break;
      case 'reserve':
        this.reserve({
          reservationCode: String(operation.reservationCode),
          householdCode: String(operation.householdCode),
          siteCode: String(operation.siteCode),
          expiresAt: String(operation.expiresAt),
          reason: String(operation.reason ?? 'offline batch reservation'),
          source,
          batchId
        });
        break;
      case 'inventory':
        this.addInventoryBatch({
          code: String(operation.code),
          sku: String(operation.sku),
          kind: operation.kind === 'meal' ? 'meal' : 'supply',
          quantity: Number(operation.quantity),
          unit: String(operation.unit),
          source: String(operation.source ?? source),
          reason: String(operation.reason ?? 'offline batch inventory'),
          batchId
        });
        break;
      default:
        throw new Error(`unsupported batch operation: ${String(operation.type)}`);
    }
  }

  capacity(siteCode?: string) {
    const sites = this.db.prepare(`
      SELECT s.id, s.code, s.name, c.bed_type, c.accessible, c.capacity,
        (SELECT COUNT(*) FROM assignments a WHERE a.site_id=s.id AND a.released_at IS NULL
          AND a.bed_type=c.bed_type AND a.accessible=c.accessible) AS occupied,
        (SELECT COALESCE(SUM(u.seats),0) FROM reservation_units u
          JOIN reservation_groups g ON g.id=u.group_id
          WHERE g.site_id=s.id AND g.status='active'
          AND u.bed_type=c.bed_type AND u.accessible=c.accessible) AS reserved
      FROM sites s JOIN capacity_pools c ON c.site_id=s.id
      WHERE s.active=1 ${siteCode ? 'AND s.code=?' : ''}
      ORDER BY s.code, c.bed_type, c.accessible
    `).all(...(siteCode ? [siteCode] : [])) as Array<{
      id: number;
      code: string;
      name: string;
      bed_type: string;
      accessible: number;
      capacity: number;
      occupied: number;
      reserved: number;
    }>;
    return sites.map(site => ({
      siteCode: site.code,
      siteName: site.name,
      bedType: site.bed_type,
      accessible: site.accessible === 1,
      capacity: site.capacity,
      occupied: site.occupied,
      reserved: site.reserved,
      available: site.capacity - site.occupied - site.reserved
    }));
  }

  operationsSummary() {
    const capacity = this.capacity();
    const inventory = this.db.prepare(`
      SELECT sku, kind, unit, SUM(quantity) AS available
      FROM inventory_batches WHERE active=1
      GROUP BY sku, kind, unit
      ORDER BY sku
    `).all() as Array<{ sku: string; kind: string; unit: string; available: number }>;
    const householdCount = (this.db.prepare('SELECT COUNT(*) AS count FROM households').get() as { count: number }).count;
    const activeCount = (this.db.prepare("SELECT COUNT(*) AS count FROM placements WHERE status='active'").get() as { count: number }).count;
    const events = this.db.prepare(`
      SELECT event_type, COUNT(*) AS count FROM events GROUP BY event_type ORDER BY event_type
    `).all() as Array<{ event_type: string; count: number }>;
    return {
      generatedAt: now(),
      privacy: 'anonymous household and member codes only; no plaintext identity fields are stored',
      households: { imported: householdCount, activeSheltered: activeCount },
      capacity,
      inventory,
      eventCounts: Object.fromEntries(events.map(row => [row.event_type, row.count]))
    };
  }

  reverseEvent(eventId: number, reason: string, source = 'manual'): { reversalEventId: number } {
    return tx(this.db, () => {
      const sourceEvent = this.db.prepare('SELECT * FROM events WHERE id=?').get(eventId) as
        | { event_type: string; entity_type: string; entity_id: string; payload: string }
        | undefined;
      if (!sourceEvent) throw new Error(`unknown event: ${eventId}`);
      if (sourceEvent.event_type === 'inventory.received') {
        const payload = JSON.parse(sourceEvent.payload) as { quantity: number };
        const batch = this.db.prepare('SELECT id, quantity FROM inventory_batches WHERE code=?')
          .get(sourceEvent.entity_id) as { id: number; quantity: number } | undefined;
        if (!batch) throw new Error('original inventory batch is missing');
        if (batch.quantity < payload.quantity) throw new Error('reversal would create negative inventory');
        this.db.prepare('UPDATE inventory_batches SET quantity=quantity-? WHERE id=?').run(payload.quantity, batch.id);
        this.db.prepare(`
          INSERT INTO inventory_history(batch_id, delta, balance_after, reason, source)
          VALUES (?, ?, ?, ?, ?)
        `).run(batch.id, -payload.quantity, batch.quantity - payload.quantity, `reverse event ${eventId}`, source);
      } else if (sourceEvent.event_type === 'capacity.changed') {
        const [siteCode, bedType, accessible] = sourceEvent.entity_id.split(':');
        const site = this.requireSite(siteCode);
        const previous = this.db.prepare(`
          SELECT capacity FROM capacity_history
          WHERE site_id=? AND bed_type=? AND accessible=? AND id < (
            SELECT id FROM capacity_history
            WHERE site_id=? AND bed_type=? AND accessible=?
            ORDER BY id DESC LIMIT 1
          )
          ORDER BY id DESC LIMIT 1
        `).get(site.id, bedType, Number(accessible), site.id, bedType, Number(accessible)) as { capacity: number } | undefined;
        if (!previous) throw new Error('no prior capacity snapshot exists for reversal');
        this.setCapacity(site.id, siteCode, {
          bedType,
          accessible: Number(accessible) === 1,
          capacity: previous.capacity
        }, reason, source);
      } else {
        throw new Error(`event type cannot be reversed: ${sourceEvent.event_type}`);
      }
      const reversalEventId = recordEvent(this.db, {
        eventType: `${sourceEvent.event_type}.reversed`,
        entityType: sourceEvent.entity_type,
        entityId: sourceEvent.entity_id,
        payload: { reversedEventId: eventId },
        reason,
        source,
        reversesEventId: eventId
      });
      return { reversalEventId };
    });
  }
}
