#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from './db.js';
import { ShelterService } from './service.js';

function parseJson(value: string): unknown {
  if (value.startsWith('@')) return JSON.parse(readFileSync(resolve(value.slice(1)), 'utf8'));
  return JSON.parse(value);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const dbPath = process.env.SHELTER_DB ?? 'data/shelter.db';
  const service = new ShelterService(openDb(dbPath));
  const arg = (name: string): string => {
    const index = rest.indexOf(name);
    const value = rest[index + 1];
    if (!value) throw new Error(`missing argument: ${name}`);
    return value;
  };

  switch (command) {
    case 'configure-site':
      print(service.configureSite(parseJson(arg('--json')) as never));
      break;
    case 'import-roster':
      print(service.importRoster(parseJson(arg('--json')) as never));
      break;
    case 'reserve':
      print(service.reserve(parseJson(arg('--json')) as never));
      break;
    case 'checkin':
      print(service.checkIn(parseJson(arg('--json')) as never));
      break;
    case 'transfer':
      print(service.transfer(parseJson(arg('--json')) as never));
      break;
    case 'leave':
      print(service.leave(parseJson(arg('--json')) as never));
      break;
    case 'add-batch':
      print(service.addInventoryBatch(parseJson(arg('--json')) as never));
      break;
    case 'issue':
      print(service.issueItems(parseJson(arg('--json')) as never));
      break;
    case 'replay-batch':
      print(service.applyOfflineBatch(parseJson(arg('--json')) as never));
      break;
    case 'capacity':
      print({ capacity: service.capacity(rest.includes('--site') ? arg('--site') : undefined) });
      break;
    case 'summary': {
      const output = rest.includes('--out') ? arg('--out') : undefined;
      const summary = service.operationsSummary();
      if (output) writeFileSync(resolve(output), JSON.stringify(summary, null, 2));
      print(summary);
      break;
    }
    case 'reverse':
      print(service.reverseEvent(Number(arg('--event-id')), arg('--reason')));
      break;
    default:
      console.error('commands: configure-site, import-roster, reserve, checkin, transfer, leave, add-batch, issue, replay-batch, capacity, summary, reverse');
      process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.message, shortages: error.shortages }, null, 2));
  process.exitCode = 1;
});
