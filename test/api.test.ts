import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/api/server.ts';

let server: any;
let base: string;

async function api(path: string, body?: unknown) {
  const res = await fetch(base + path, body !== undefined
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return { status: res.status, body: await res.json() };
}

before(async () => {
  server = createServer(':memory:');
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); server.db.close(); });

test('API 仅绑定回环地址', () => {
  assert.equal(server.address().address, '127.0.0.1');
  assert.ok(server.address().port > 0);
});

test('并发入住不超员', async () => {
  await api('/api/shelters', { code: 'SC', name: '并发点', capacity: { standard: 3 } });
  const shelterId = (await api('/api/shelters')).body.find((s: any) => s.code === 'SC').id;
  for (let i = 0; i < 10; i++)
    await api('/api/households', { code: `C-${i}`, size: 1 });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    api('/api/check-ins', {}).then(() => null).catch(() => null) // placeholder
  ));
  void results;
  const attempts = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    api('/api/check-ins', { householdCode: `C-${i}`, shelterId })));
  const ok = attempts.filter(r => r.status === 201);
  const rejected = attempts.filter(r => r.status === 409);
  assert.equal(ok.length, 3);
  assert.equal(rejected.length, 7);
  const cap = (await api(`/api/shelters/${shelterId}/capacity`)).body.find((c: any) => c.bed_type === 'standard');
  assert.equal(cap.occupied, 3);
});

test('重复请求（同幂等键）不重复发放', async () => {
  await api('/api/items', { code: 'MEALX', name: '盒饭' });
  const shelters = (await api('/api/shelters')).body;
  const sid = shelters.find((s: any) => s.code === 'SC').id;
  await api('/api/inventory/batches', { shelterId: sid, itemCode: 'MEALX', qty: 10, source: 'test' });
  await api('/api/households', { code: 'D-1', size: 1 });
  await api('/api/check-ins', { householdCode: 'D-1', shelterId: sid });
  const r1 = await api('/api/distributions', { shelterId: sid, householdCode: 'D-1', itemCode: 'MEALX', qty: 4, idempotencyKey: 'dup-1' });
  const r2 = await api('/api/distributions', { shelterId: sid, householdCode: 'D-1', itemCode: 'MEALX', qty: 4, idempotencyKey: 'dup-1' });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(r2.body.id, r1.body.id);
  const dists = (await api('/api/distributions')).body.filter((d: any) => d.item_code === 'MEALX');
  assert.equal(dists.length, 1);
});

test('短缺返回明确缺口', async () => {
  const shelters = (await api('/api/shelters')).body;
  const sid = shelters.find((s: any) => s.code === 'SC').id;
  const r = await api('/api/distributions', { shelterId: sid, householdCode: 'D-1', itemCode: 'MEALX', qty: 100 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'SHORTAGE');
  assert.ok(r.body.detail.gap > 0);
});
