// 本地演练：用虚构数据演示七类场景，全部输出到控制台，不连接任何外部服务。
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db/db.ts';
import { createShelter, getShelter } from '../src/domain/shelters.ts';
import { createHousehold } from '../src/domain/households.ts';
import { reserve, checkIn, transfer, depart, expireReservations } from '../src/domain/stays.ts';
import { createItem, receiveBatch, distribute, stockOf } from '../src/domain/inventory.ts';
import { applyOfflineBatch, listConflicts } from '../src/domain/offline.ts';
import { operationalSummary } from '../src/domain/summary.ts';

const db = openDb(':memory:');
const log = (title: string, v: unknown) => console.log(`\n=== ${title} ===\n` + JSON.stringify(v, null, 2));
const attempt = (fn: () => unknown) => { try { return fn(); } catch (e: any) { return { error: e.code, message: e.message, detail: e.detail }; } };

createShelter(db, { code: 'S1', name: '演练点甲', capacity: { standard: 6, accessible: 2 }, facilities: ['ramp', 'accessible_toilet'] });
createShelter(db, { code: 'S2', name: '演练点乙', capacity: { standard: 2 } });
createItem(db, { code: 'MEAL', name: '盒饭', category: 'meal' });
createItem(db, { code: 'WATER', name: '饮用水' });
receiveBatch(db, { shelterId: 1, itemCode: 'MEAL', qty: 8, source: '演练捐赠', batchKey: 'donation-1' });

const households = JSON.parse(readFileSync('fixtures/households.json', 'utf8'));
for (const h of households) createHousehold(db, h);

// 场景1 家庭分配：整体入住同一安置点
log('1 家庭分配（HH-FAM-01 四口之家）', checkIn(db, { householdCode: 'HH-FAM-01', shelterId: 1 }));

// 场景2 无障碍需求
log('2 无障碍需求（HH-ACC-01 → accessible 床位）', checkIn(db, { householdCode: 'HH-ACC-01', shelterId: 1 }));

// 场景3 并发超员：S2 仅剩 2 床，3 个单人家庭同时登记
const over = ['HH-SOLO-01', 'HH-SOLO-02', 'HH-SOLO-03'].map(c => attempt(() => checkIn(db, { householdCode: c, shelterId: 2 })));
log('3 超员保护（S2 容量 2，3 个家庭登记）', over);

// 场景4 预留过期
reserve(db, { householdCode: 'HH-SOLO-04', shelterId: 1, ttlMinutes: -1 });
log('4 预留过期', { expired: expireReservations(db), checkin: attempt(() => checkIn(db, { householdCode: 'HH-SOLO-04' })) });

// 场景5 物资耗尽：库存 8，发 6 后再发 5 → 明确缺口
distribute(db, { shelterId: 1, householdCode: 'HH-FAM-01', itemCode: 'MEAL', qty: 6, idempotencyKey: 'meal-1' });
log('5 物资耗尽（剩余 ' + stockOf(db, 1, 'MEAL') + '，再发 5）', attempt(() => distribute(db, { shelterId: 1, householdCode: 'HH-ACC-01', itemCode: 'MEAL', qty: 5 })));

// 场景6 离线批次重放：夜间名单与现场手工登记冲突 + 整批重放幂等
checkIn(db, { householdCode: 'HH-SOLO-05', shelterId: 1, source: 'manual' });
const batch = JSON.parse(readFileSync('fixtures/offline_checkin_batch.json', 'utf8'));
const first = applyOfflineBatch(db, batch);
const replay = applyOfflineBatch(db, batch);
log('6 离线批次重放', { first, replay_status: replay.status, conflicts: listConflicts(db) });

// 场景7 转移失败：HH-FAM-01（4 人）转入仅剩 2 床的 S2 → 原子回滚
log('7 转移失败回滚', attempt(() => transfer(db, { householdCode: 'HH-FAM-01', toShelterId: 2 })));

log('最终容量', [getShelter(db, 1).capacity, getShelter(db, 2).capacity]);
log('运营汇总（无身份明文）', operationalSummary(db));
depart(db, { householdCode: 'HH-SOLO-01', reason: '演练结束' });
db.close();
