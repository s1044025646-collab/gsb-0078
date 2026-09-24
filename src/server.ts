import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDb } from './db.js';
import { ShelterService, type Shortage } from './service.js';

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(json);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

export function createApp(dbPath = process.env.SHELTER_DB ?? 'data/shelter.db'): Server {
  const service = new ShelterService(openDb(dbPath));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { status: 'ok' });
    if (request.method === 'GET' && url.pathname === '/capacity') {
      return send(response, 200, { capacity: service.capacity(url.searchParams.get('site') ?? undefined) });
    }
    if (request.method === 'GET' && url.pathname === '/summary') return send(response, 200, service.operationsSummary());
    if (request.method !== 'POST') return send(response, 405, { error: 'method not allowed' });

    readJson(request).then(body => {
      const payload = body as Record<string, unknown>;
      switch (url.pathname) {
        case '/admin/sites':
          return send(response, 200, service.configureSite(payload as never));
        case '/roster/import':
          return send(response, 200, service.importRoster(payload as never));
        case '/reservations':
          return send(response, 200, service.reserve(payload as never));
        case '/checkins':
          return send(response, 200, service.checkIn(payload as never));
        case '/transfers':
          return send(response, 200, service.transfer(payload as never));
        case '/departures':
          return send(response, 200, service.leave(payload as never));
        case '/inventory/batches':
          return send(response, 200, service.addInventoryBatch(payload as never));
        case '/issues':
          return send(response, 200, service.issueItems(payload as never));
        case '/batch-imports':
          return send(response, 200, service.applyOfflineBatch(payload as never));
        case '/reversals':
          return send(response, 200, service.reverseEvent(
            Number(payload.eventId),
            String(payload.reason),
            payload.source === undefined ? 'manual' : String(payload.source)
          ));
        default:
          return send(response, 404, { error: 'not found' });
      }
    }).catch(error => {
      const shortages = (error as { shortages?: Shortage[] }).shortages;
      return send(response, shortages ? 409 : 400, {
        error: (error as Error).message,
        ...(shortages ? { shortages } : {})
      });
    });
  });
  server.on('close', () => {
    const database = (service as unknown as { db: import('better-sqlite3').Database }).db;
    database.close();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createApp();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind local port');
    console.log(JSON.stringify({ host: '127.0.0.1', port: address.port }));
  });
}
