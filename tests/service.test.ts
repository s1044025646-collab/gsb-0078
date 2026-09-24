import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db.js';
import { ShelterService } from '../src/service.js';

function service(): ShelterService {
  const db = new Database(':memory:');
  migrate(db);
  return new ShelterService(db);
}

function seed(service: ShelterService): void {
  service.configureSite({
    code: 'A',
    name: 'Alpha drill',
    reason: 'seed',
    capacities: [
      { bedType: 'standard', accessible: false, capacity: 1 },
      { bedType: 'standard', accessible: true, capacity: 1 }
    ]
  });
  service.configureSite({
    code: 'B',
    name: 'Beta drill',
    reason: 'seed',
    capacities: [
      { bedType: 'standard', accessible: false, capacity: 1 },
      { bedType: 'standard', accessible: true, capacity: 0 }
    ]
  });
  service.importRoster({
    code: 'H1',
    members: [
      { code: 'M1', bedType: 'standard' },
      { code: 'M2', bedType: 'standard', accessibleRequired: true }
    ]
  });
  service.importRoster({
    code: 'H2',
    members: [{ code: 'M3', bedType: 'standard' }]
  });
}

describe('shelter operations', () => {
  it('keeps a household together and honors accessible bed demand', () => {
    const shelter = service();
    seed(shelter);
    expect(shelter.checkIn({ householdCode: 'H1', siteCode: 'A', reason: 'drill check-in' })).toEqual({
      status: 'checked_in',
      shortages: []
    });
    const capacity = shelter.capacity('A');
    expect(capacity.find(pool => pool.accessible === false)?.available).toBe(0);
    expect(capacity.find(pool => pool.accessible === true)?.available).toBe(0);
    expect(() => shelter.checkIn({ householdCode: 'H2', siteCode: 'A', reason: 'over capacity' }))
      .toThrow('insufficient capacity');
  });

  it('rejects concurrent registrations beyond capacity and leaves no partial assignment', () => {
    const db = new Database(':memory:');
    migrate(db);
    const first = new ShelterService(db);
    const second = new ShelterService(db);
    seed(first);
    const results = [
      (() => { try { first.checkIn({ householdCode: 'H1', siteCode: 'A', reason: 'race 1' }); return 'ok'; } catch { return 'fail'; } })(),
      (() => { try { second.checkIn({ householdCode: 'H2', siteCode: 'A', reason: 'race 2' }); return 'ok'; } catch { return 'fail'; } })()
    ].sort();
    expect(results).toEqual(['fail', 'ok']);
    const occupied = db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE released_at IS NULL").get() as { count: number };
    expect(occupied.count).toBe(2);
  });

  it('expires reservations and releases held capacity', () => {
    const shelter = service();
    seed(shelter);
    shelter.reserve({
      reservationCode: 'R1',
      householdCode: 'H2',
      siteCode: 'A',
      expiresAt: '2000-01-01T00:00:00.000Z',
      reason: 'expiring reservation'
    });
    expect(shelter.expireReservations('2000-01-02T00:00:00.000Z')).toBe(1);
    const reserved = shelter.capacity('A').reduce((total, pool) => total + pool.reserved, 0);
    expect(reserved).toBe(0);
  });

  it('treats an identical active reservation request as idempotent', () => {
    const shelter = service();
    seed(shelter);
    const request = {
      reservationCode: 'R-SAME',
      householdCode: 'H2',
      siteCode: 'A',
      expiresAt: '2999-01-01T00:00:00.000Z',
      reason: 'idempotent reservation'
    };
    expect(shelter.reserve(request).status).toBe('reserved');
    expect(shelter.reserve(request).status).toBe('reserved');
    const standardPool = shelter.capacity('A').find(pool => !pool.accessible && pool.bedType === 'standard');
    expect(standardPool?.reserved).toBe(1);
  });

  it('does not place one household in two active sites', () => {
    const shelter = service();
    seed(shelter);
    shelter.checkIn({ householdCode: 'H1', siteCode: 'A', reason: 'first' });
    expect(() => shelter.checkIn({ householdCode: 'H1', siteCode: 'B', reason: 'duplicate' }))
      .toThrow('household already sheltered at A');
  });

  it('rolls back a failed transfer and preserves source occupancy', () => {
    const shelter = service();
    seed(shelter);
    shelter.checkIn({ householdCode: 'H1', siteCode: 'A', reason: 'start' });
    expect(() => shelter.transfer({
      householdCode: 'H1',
      fromSiteCode: 'A',
      toSiteCode: 'B',
      reason: 'destination lacks accessible bed'
    })).toThrow('insufficient destination capacity');
    const sourceOccupied = shelter.capacity('A').reduce((total, pool) => total + pool.occupied, 0);
    const targetOccupied = shelter.capacity('B').reduce((total, pool) => total + pool.occupied, 0);
    expect(sourceOccupied).toBe(2);
    expect(targetOccupied).toBe(0);
  });

  it('preserves inventory conservation, reports shortage, and deduplicates repeated requests', () => {
    const shelter = service();
    seed(shelter);
    shelter.addInventoryBatch({
      code: 'IB1',
      sku: 'MEAL',
      kind: 'meal',
      quantity: 2,
      unit: 'box',
      source: 'fictional stock'
    });
    const first = shelter.issueItems({
      requestKey: 'REQ-1',
      householdCode: 'H1',
      sku: 'MEAL',
      quantity: 5
    });
    expect(first.status).toBe('shortage');
    expect(first.issuedQuantity).toBe(2);
    expect(first.shortage).toBe(3);
    const duplicate = shelter.issueItems({
      requestKey: 'REQ-1',
      householdCode: 'H1',
      sku: 'MEAL',
      quantity: 5
    });
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.issuedQuantity).toBe(2);
    const balance = shelter.operationsSummary().inventory.find(item => item.sku === 'MEAL')?.available;
    expect(balance).toBe(0);
  });

  it('rejects and audits an offline batch with conflicting operations without partial effects', () => {
    const shelter = service();
    seed(shelter);
    const result = shelter.applyOfflineBatch({
      batchId: 'OFF-BAD',
      checksum: 'bad-checksum',
      operations: [
        {
          type: 'roster',
          householdCode: 'HOFF',
          members: [{ code: 'MOFF', bedType: 'standard' }]
        },
        {
          type: 'reserve',
          reservationCode: 'ROFF',
          householdCode: 'HOFF',
          siteCode: 'MISSING',
          expiresAt: '2999-01-01T00:00:00.000Z',
          reason: 'should conflict'
        }
      ]
    });
    expect(result.status).toBe('rejected');
    expect(result.conflicts.join(' ')).toContain('unknown active site');
    const householdCount = (shelter.operationsSummary().households.imported);
    expect(householdCount).toBe(2);
  });

  it('replays an identical offline batch idempotently and detects checksum reuse', () => {
    const shelter = service();
    seed(shelter);
    const batch = {
      batchId: 'OFF-OK',
      checksum: 'ok-checksum',
      operations: [
        {
          type: 'inventory',
          code: 'OFFWATER',
          sku: 'WATER',
          kind: 'supply' as const,
          quantity: 1,
          unit: 'bottle',
          source: 'offline'
        }
      ]
    };
    expect(shelter.applyOfflineBatch(batch).status).toBe('applied');
    expect(shelter.applyOfflineBatch(batch).status).toBe('replayed');
    expect(shelter.applyOfflineBatch({ ...batch, checksum: 'changed' }).status).toBe('rejected');
    expect(shelter.operationsSummary().inventory.find(item => item.sku === 'WATER')?.available).toBe(1);
  });

  it('keeps summaries free of plaintext identity schema', () => {
    const shelter = service();
    seed(shelter);
    const summary = shelter.operationsSummary();
    expect(summary.privacy).toContain('anonymous');
    expect(JSON.stringify(summary)).not.toMatch(/name\s+of\s+person|passport|national.?id|phone/i);
  });
});
