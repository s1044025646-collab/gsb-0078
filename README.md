# 虚构应急安置点入住与物资发放后端

这是一个仅用于本机演练的 TypeScript、Node.js、SQLite 后端。系统只保存安置点、匿名家庭/成员编号、床位需求、物资批次和操作审计，不提供网页，也不连接政府、救援或外部身份服务。所有夹具数据均为虚构数据。

## 能力

- 安置点、床位类型、无障碍床位容量配置与历史快照。
- 家庭及匿名成员导入；入住时家庭整体分配，并强制满足个体床位与无障碍需求。
- 临时预留、预留到期、入住、转移、离开；重复有效安置点会被拒绝。
- 餐食和基础物资批次入库、FIFO 发放、短缺数量返回、请求键幂等。
- 容量、预留、入住与库存扣减都在 SQLite immediate transaction 中原子提交。
- 容量与物资变化保留快照；撤销通过追加冲正事件实现，不删除历史。
- 离线夜间批次按批次号和校验和重放；冲突批次整批回滚并写入审计事件。
- 运营汇总只包含匿名编号、数量、容量和事件计数。

## 安装与测试

```powershell
npm install
npm test
npm run smoke
```

`npm run smoke` 使用 `fixtures/` 下的虚构夹具创建本机演练库：`data/smoke.db`。

## 启动与停止

```powershell
npm start
```

服务只绑定 `127.0.0.1`，端口由操作系统自动分配。启动后 stdout 输出一行 JSON，例如：

```json
{ "host": "127.0.0.1", "port": 51234 }
```

停止服务：在运行服务的终端按 `Ctrl+C`。项目不安装 Windows 服务或后台守护进程。

可通过环境变量指定数据库；不设置时使用 `data/shelter.db`：

```powershell
$env:SHELTER_DB="data/drill-a.db"; npm start
```

迁移在打开数据库时执行，只使用 `CREATE TABLE IF NOT EXISTS` 和 `CREATE INDEX IF NOT EXISTS`，可重复启动。

## API

- `GET /health`
- `GET /capacity?site=SITE-ALPHA`
- `GET /summary`
- `POST /admin/sites`
- `POST /roster/import`
- `POST /reservations`
- `POST /checkins`
- `POST /transfers`
- `POST /departures`
- `POST /inventory/batches`
- `POST /issues`
- `POST /batch-imports`
- `POST /reversals`

容量不足返回 HTTP 409，响应体包含 `shortages`；库存不足仍记录发放请求，返回 `status: "shortage"` 和缺口数量。重复 `requestKey` 返回 `status: "duplicate"`，不会二次扣减库存。

## CLI

```powershell
npm run cli -- configure-site --json '@fixtures/sites.json'
npm run cli -- import-roster --json '@fixtures/household-accessible.json'
npm run cli -- reserve --json '{"reservationCode":"R1","householdCode":"HH-DRILL-001","siteCode":"SITE-ALPHA","expiresAt":"2999-01-01T00:00:00.000Z","reason":"drill"}'
npm run cli -- checkin --json '{"householdCode":"HH-DRILL-001","siteCode":"SITE-ALPHA","reservationCode":"R1","reason":"drill"}'
npm run cli -- transfer --json '{"householdCode":"HH-DRILL-001","fromSiteCode":"SITE-ALPHA","toSiteCode":"SITE-BETA","reason":"drill"}'
npm run cli -- leave --json '{"householdCode":"HH-DRILL-001","siteCode":"SITE-BETA","reason":"drill"}'
npm run cli -- add-batch --json '@fixtures/inventory-meal.json'
npm run cli -- issue --json '{"requestKey":"REQ-1","householdCode":"HH-DRILL-001","sku":"MEAL-BOX","quantity":2}'
npm run cli -- replay-batch --json '@fixtures/offline-batch.json'
npm run cli -- capacity
npm run cli -- summary --out summary.json
npm run cli -- reverse --event-id 1 --reason "correction drill"
```

## 测试覆盖

- 家庭整体分配与无障碍需求。
- 并发/竞争登记下不超员。
- 预留到期释放容量。
- 家庭不能同时存在两个有效安置点。
- 转移目标容量不足时原子回滚。
- 物资耗尽、缺口、FIFO 与重复请求幂等。
- 离线批次重放、校验和冲突、整批失败无半成品。
- 匿名运营汇总隐私边界。
- SQLite 关闭重开后的崩溃恢复。

## 数据边界

系统没有姓名、证件号、手机号、住址等明文字段；家庭和成员只使用调用方提供的匿名编号。审计载荷也只记录这些编号和运营数量。即使如此，也不要在匿名编号或备注中填入真实身份信息。
