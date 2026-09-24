import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { ShelterService } from '../src/service.js';

const dirs: string[] = [];
const servers: Server[] = [];

async function startServer(dbPath: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = createApp(dbPath);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('local HTTP API', () => {
  it('binds only to localhost, handles JSON, and makes duplicate issues idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shelter-api-'));
    dirs.push(dir);
    const dbPath = join(dir, 'shelter.db');
    const app = await startServer(dbPath);
    const post = (path: string, body: unknown) => fetch(`${app.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(async response => ({ status: response.status, body: await response.json() }));

    await post('/admin/sites', {
      code: 'A',
      name: 'API drill',
      reason: 'api setup',
      capacities: [{ bedType: 'standard', accessible: false, capacity: 1 }]
    });
    await post('/roster/import', {
      code: 'H1',
      members: [{ code: 'M1', bedType: 'standard' }]
    });
    await post('/inventory/batches', {
      code: 'B1',
      sku: 'WATER',
      kind: 'supply',
      quantity: 1,
      unit: 'bottle',
      source: 'fictional'
    });
    const issue = { requestKey: 'REQ-API-1', householdCode: 'H1', sku: 'WATER', quantity: 1 };
    const first = await post('/issues', issue);
    const second = await post('/issues', issue);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('issued');
    expect(second.body.status).toBe('duplicate');

    const health = await fetch(`${app.url}/health`).then(response => response.json());
    expect(health).toEqual({ status: 'ok' });
    await app.stop();
  });

  it('recovers committed data after reopening the SQLite database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shelter-recovery-'));
    dirs.push(dir);
    const dbPath = join(dir, 'shelter.db');
    const before = new ShelterService(openDb(dbPath));
    before.configureSite({
      code: 'A',
      name: 'Recovery drill',
      reason: 'persist',
      capacities: [{ bedType: 'standard', accessible: false, capacity: 1 }]
    });
    before.importRoster({
      code: 'H1',
      members: [{ code: 'M1', bedType: 'standard' }]
    });
    before.checkIn({ householdCode: 'H1', siteCode: 'A', reason: 'committed' });
    (before as unknown as { db: import('better-sqlite3').Database }).db.close();

    const after = new ShelterService(openDb(dbPath));
    const pool = after.capacity('A')[0];
    expect(pool.occupied).toBe(1);
    expect(pool.available).toBe(0);
    expect(after.operationsSummary().households.activeSheltered).toBe(1);
    (after as unknown as { db: import('better-sqlite3').Database }).db.close();
  });
});
