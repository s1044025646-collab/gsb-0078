import http from 'node:http';
import { openDb } from '../db/db.ts';
import type { DB } from '../db/db.ts';
import { DomainError } from '../domain/errors.ts';
import * as shelters from '../domain/shelters.ts';
import * as households from '../domain/households.ts';
import * as stays from '../domain/stays.ts';
import * as inventory from '../domain/inventory.ts';
import * as offline from '../domain/offline.ts';
import { operationalSummary } from '../domain/summary.ts';

type Handler = (db: DB, body: any, params: Record<string, string>) => unknown;

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/health$/, () => ({ ok: true })],
  ['POST', /^\/api\/shelters$/, (db, b) => shelters.createShelter(db, b)],
  ['GET', /^\/api\/shelters$/, (db) => shelters.listShelters(db)],
  ['POST', /^\/api\/shelters\/(?<id>\d+)\/capacity$/, (db, b, p) => shelters.setCapacity(db, Number(p.id), b.bed_type, b.total, b.reason ?? 'manual_adjust', b.source ?? 'api')],
  ['GET', /^\/api\/shelters\/(?<id>\d+)\/capacity$/, (db, _b, p) => shelters.getShelter(db, Number(p.id)).capacity],
  ['GET', /^\/api\/shelters\/(?<id>\d+)\/snapshots$/, (db, _b, p) => shelters.listCapacitySnapshots(db, Number(p.id))],
  ['POST', /^\/api\/households$/, (db, b) => households.createHousehold(db, b)],
  ['GET', /^\/api\/households$/, (db) => households.listHouseholds(db)],
  ['POST', /^\/api\/reservations$/, (db, b) => stays.reserve(db, b)],
  ['POST', /^\/api\/reservations\/expire$/, (db, b) => ({ expired: stays.expireReservations(db, b?.at) })],
  ['POST', /^\/api\/check-ins$/, (db, b) => stays.checkIn(db, b)],
  ['POST', /^\/api\/transfers$/, (db, b) => stays.transfer(db, b)],
  ['POST', /^\/api\/departures$/, (db, b) => stays.depart(db, b)],
  ['POST', /^\/api\/items$/, (db, b) => inventory.createItem(db, b)],
  ['POST', /^\/api\/inventory\/batches$/, (db, b) => inventory.receiveBatch(db, b)],
  ['POST', /^\/api\/distributions$/, (db, b) => inventory.distribute(db, b)],
  ['POST', /^\/api\/distributions\/(?<id>\d+)\/reverse$/, (db, b, p) => inventory.reverseDistribution(db, { distributionId: Number(p.id), reason: b.reason ?? 'reversal', source: 'api' })],
  ['GET', /^\/api\/distributions$/, (db) => inventory.listDistributions(db)],
  ['POST', /^\/api\/offline-batches$/, (db, b) => offline.applyOfflineBatch(db, b)],
  ['GET', /^\/api\/conflicts$/, (db) => offline.listConflicts(db)],
  ['GET', /^\/api\/summary$/, (db) => operationalSummary(db)],
];

export function createServer(dbPath: string): http.Server & { db: DB } {
  const db = openDb(dbPath);
  const server = http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => {
      const data = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(data);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const body = req.method === 'POST' ? JSON.parse(await readBody(req) || '{}') : undefined;
      for (const [method, pattern, handler] of routes) {
        if (req.method !== method) continue;
        const m = pattern.exec(url.pathname);
        if (!m) continue;
        const result = handler(db, body, (m.groups ?? {}) as Record<string, string>);
        send(method === 'POST' ? 201 : 200, result);
        return;
      }
      send(404, { error: 'NOT_FOUND', message: '路由不存在' });
    } catch (err: any) {
      if (err instanceof DomainError) send(err.status, { error: err.code, message: err.message, detail: err.detail });
      else send(500, { error: 'INTERNAL', message: String(err?.message ?? err) });
    }
  }) as http.Server & { db: DB };
  server.db = db;
  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// 直接运行：仅绑定 127.0.0.1，端口 0（自动分配）
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const dbPath = process.env.DB_PATH ?? 'data/shelter.db';
  const server = createServer(dbPath);
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as any;
    console.log(`API listening on http://127.0.0.1:${addr.port} (db: ${dbPath})`);
  });
  const shutdown = () => { server.close(); server.db.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
