# 应急安置点入住与物资发放后端（本地演练版）

纯本地运行的后端：TypeScript + Node.js（内置 `node:sqlite`，零原生依赖）+ SQLite。
仅提供 HTTP API、CLI、演练夹具与自动化测试。**不包含网页界面，不连接任何真实政府或救援服务，全部数据均为虚构。**

## 环境要求

- Node.js >= 22（使用内置 `node:sqlite` 与 TypeScript 类型擦除运行，无需编译）
- 仅绑定 `127.0.0.1`，端口由系统自动分配（`listen(0)`）

## 启动 / 停止

```bash
npm start                 # 启动 API（默认库文件 data/shelter.db，可用 DB_PATH 覆盖）
# 输出示例: API listening on http://127.0.0.1:51234 (db: data/shelter.db)
# 停止: Ctrl+C（SIGINT/SIGTERM 会优雅关闭并落盘）
```

## 测试

```bash
npm test                  # 27 个用例：容量/物资守恒、幂等、原子回滚、隐私边界、崩溃恢复
npm run typecheck         # tsc 严格类型检查
npm run drill             # 本地演练：家庭分配/无障碍/超员/预留过期/物资耗尽/离线重放/转移失败
```

## CLI 速览

```bash
node src/cli/cli.ts shelter add --code S1 --name 演练点A --capacity standard=100,accessible=10 --facilities ramp
node src/cli/cli.ts item add --code MEAL --name 盒饭 --category meal
node src/cli/cli.ts inventory receive --shelter 1 --item MEAL --qty 500 --source 演练捐赠 --batch-key d1
node src/cli/cli.ts household import fixtures/households.json     # 导入演练名单
node src/cli/cli.ts reserve --household HH-SOLO-01 --shelter 1 --ttl 120 --key r1
node src/cli/cli.ts expire                                        # 处理过期预留
node src/cli/cli.ts checkin --household HH-SOLO-01
node src/cli/cli.ts transfer --household HH-SOLO-01 --to 2 --reason 点内调整
node src/cli/cli.ts depart --household HH-SOLO-01
node src/cli/cli.ts distribute --shelter 1 --household HH-FAM-01 --item MEAL --qty 4 --key req-1
node src/cli/cli.ts reverse --distribution 1 --reason 错发冲正     # 仅追加冲正事件
node src/cli/cli.ts offline import fixtures/offline_checkin_batch.json
node src/cli/cli.ts shelter capacity                              # 查询容量
node src/cli/cli.ts conflicts                                     # 离线/手工冲突审计
node src/cli/cli.ts summary --out summary.json                    # 导出运营汇总（无身份明文）
```

## 设计要点

- **守恒**：容量 `occupied + reserved <= total` 由数据库 CHECK 约束兜底；物资 `入库 = 剩余 + 已发放`，FIFO 扣减批次，绝不产生负库存，短缺返回明确 `gap`。
- **幂等**：预留/发放/入库/离线批次均支持幂等键（`idempotency_key` / `batch_key` 唯一约束），重复请求返回原记录。
- **原子性**：预留到期、入住、转移、离开均在单事务内更新床位与事件；转移先占目标后释放源点，失败整体回滚（嵌套事务用 SAVEPOINT）。
- **并发**：`BEGIN IMMEDIATE` + WAL + 唯一部分索引（`stays`/`reservations` 每家庭仅一条有效记录），并发登记不超员、不重复安排。
- **审计**：每次容量变化写 `capacity_events` 与 `capacity_snapshots`（含原因与来源）；发放撤销只追加 `reversal` 冲正事件；夜间离线批次与现场手工登记冲突写入 `conflicts` 表，不覆盖现场数据。
- **隐私**：家庭仅用匿名编号；运营汇总只输出聚合数据（测试断言不含任何家庭编号）。
- **恢复**：WAL 模式，崩溃后重开库数据一致；迁移记录于 `schema_migrations`，可重复执行。

## 目录

- `migrations/001_init.sql` — 全部表结构（含 CHECK/唯一约束）
- `src/db/db.ts` — 连接、迁移、事务（SAVEPOINT 嵌套）
- `src/domain/` — shelters / households / stays / inventory / offline / summary
- `src/api/server.ts` — 本机回环 HTTP API
- `src/cli/cli.ts` — 命令行
- `fixtures/` — 虚构演练数据（家庭名单、离线入住批次、离线物资批次）
- `scripts/drill.ts` — 七场景演练
- `test/` — node:test 自动化测试
