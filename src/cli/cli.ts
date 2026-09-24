import { readFileSync, writeFileSync } from 'node:fs';
import { openDb } from '../db/db.ts';
import * as shelters from '../domain/shelters.ts';
import * as households from '../domain/households.ts';
import * as stays from '../domain/stays.ts';
import * as inventory from '../domain/inventory.ts';
import * as offline from '../domain/offline.ts';
import { operationalSummary } from '../domain/summary.ts';

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function parseCapacity(spec: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of spec.split(',')) {
    const [k, v] = part.split('=');
    out[k.trim()] = Number(v);
  }
  return out;
}

const USAGE = `用法: node src/cli/cli.ts [--db path] <command> [options]
命令:
  shelter add --code S1 --name 名称 --capacity standard=100,accessible=10 [--facilities ramp,elevator]
  shelter capacity --shelter 1 --bed-type standard --total 120 --reason 扩容
  shelter list | capacity | snapshots --shelter 1
  item add --code MEAL --name 盒饭 [--category meal] [--unit 份]
  inventory receive --shelter 1 --item MEAL --qty 500 --source 捐赠A [--batch-key K]
  household add --code HH-001 --size 3 [--accessible]
  household import <file.json>            # 导入演练名单
  reserve --household HH-001 --shelter 1 [--ttl 120] [--key K]
  expire [--at ISO]
  checkin --household HH-001 [--shelter 1]
  transfer --household HH-001 --to 2 [--reason 原因]
  depart --household HH-001 [--reason 原因]
  distribute --shelter 1 --household HH-001 --item MEAL --qty 3 [--key K]
  reverse --distribution 1 --reason 错发冲正
  distributions
  offline import <file.json>              # 离线批次导入（幂等/冲突审计）
  conflicts
  summary [--out file.json]               # 导出运营汇总（无身份明文）
`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const dbPath = (flags.db as string) ?? process.env.DB_PATH ?? 'data/shelter.db';
  const [cmd, sub] = positional;
  if (!cmd) { console.log(USAGE); return; }
  const db = openDb(dbPath);
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  try {
    if (cmd === 'shelter' && sub === 'add')
      out(shelters.createShelter(db, { code: String(flags.code), name: String(flags.name), capacity: parseCapacity(String(flags.capacity)), facilities: flags.facilities ? String(flags.facilities).split(',') : [] }));
    else if (cmd === 'shelter' && sub === 'capacity' && flags.shelter)
      out(shelters.setCapacity(db, Number(flags.shelter), String(flags['bed-type']), Number(flags.total), String(flags.reason ?? 'manual_adjust'), 'cli'));
    else if (cmd === 'shelter' && sub === 'capacity')
      out(shelters.listShelters(db).map(s => ({ code: s.code, capacity: s.capacity })));
    else if (cmd === 'shelter' && sub === 'list') out(shelters.listShelters(db));
    else if (cmd === 'shelter' && sub === 'snapshots') out(shelters.listCapacitySnapshots(db, Number(flags.shelter)));
    else if (cmd === 'item' && sub === 'add')
      out(inventory.createItem(db, { code: String(flags.code), name: String(flags.name), unit: flags.unit as string, category: flags.category as string }));
    else if (cmd === 'inventory' && sub === 'receive')
      out(inventory.receiveBatch(db, { shelterId: Number(flags.shelter), itemCode: String(flags.item), qty: Number(flags.qty), source: String(flags.source ?? 'cli'), batchKey: flags['batch-key'] as string }));
    else if (cmd === 'household' && sub === 'add')
      out(households.createHousehold(db, { code: String(flags.code), size: Number(flags.size), needs_accessible: !!flags.accessible }));
    else if (cmd === 'household' && sub === 'import') {
      const list = JSON.parse(readFileSync(positional[2], 'utf8')) as any[];
      out(list.map(h => households.createHousehold(db, h)));
    }
    else if (cmd === 'reserve')
      out(stays.reserve(db, { householdCode: String(flags.household), shelterId: Number(flags.shelter), ttlMinutes: flags.ttl ? Number(flags.ttl) : undefined, idempotencyKey: flags.key as string, source: 'cli' }));
    else if (cmd === 'expire') out({ expired: stays.expireReservations(db, flags.at as string) });
    else if (cmd === 'checkin')
      out(stays.checkIn(db, { householdCode: String(flags.household), shelterId: flags.shelter ? Number(flags.shelter) : undefined, source: 'cli' }));
    else if (cmd === 'transfer')
      out(stays.transfer(db, { householdCode: String(flags.household), toShelterId: Number(flags.to), reason: flags.reason as string, source: 'cli' }));
    else if (cmd === 'depart')
      out(stays.depart(db, { householdCode: String(flags.household), reason: flags.reason as string, source: 'cli' }));
    else if (cmd === 'distribute')
      out(inventory.distribute(db, { shelterId: Number(flags.shelter), householdCode: String(flags.household), itemCode: String(flags.item), qty: Number(flags.qty), idempotencyKey: flags.key as string, source: 'cli' }));
    else if (cmd === 'reverse')
      out(inventory.reverseDistribution(db, { distributionId: Number(flags.distribution), reason: String(flags.reason), source: 'cli' }));
    else if (cmd === 'distributions') out(inventory.listDistributions(db, flags.shelter ? Number(flags.shelter) : undefined));
    else if (cmd === 'offline' && sub === 'import')
      out(offline.applyOfflineBatch(db, JSON.parse(readFileSync(positional[2], 'utf8'))));
    else if (cmd === 'conflicts') out(offline.listConflicts(db));
    else if (cmd === 'summary') {
      const summary = operationalSummary(db);
      if (flags.out) { writeFileSync(String(flags.out), JSON.stringify(summary, null, 2)); console.log(`已导出 ${flags.out}`); }
      else out(summary);
    }
    else { console.log(USAGE); process.exitCode = 1; }
  } catch (err: any) {
    console.error(JSON.stringify({ error: err.code ?? 'ERROR', message: err.message, detail: err.detail }));
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
