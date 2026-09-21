# 赛鸽血统环号登记站

运行：

```bash
npm start
```

访问 `http://localhost:3024`。支持档案、血统查询、转让生效、权益台与归巢成绩。

测试：`npm test`

## 模块划分

- `src/http/router.js` — 请求入口：HTTP 路由、请求解析、领域错误到状态码的映射
- `src/domain/equity.js` — 权益判定：转让生命周期、生效区间、归属推导、报名资格重算
- `src/store/repository.js` — 记录持久化：JSON 台账读写（临时文件 + 原子替换）、旧版结构迁移、写操作串行化

## 转让生效规则

- 每笔转让登记原鸽主、受让人、交接日、凭证号、停药期天数。
- 双方确认且过停药期才生效：生效日 = max（交接日 + 停药期，双方确认完成日）。
- 同一羽鸽的生效区间重叠时返回 409，且整笔不落库（先校验后写库，写库经临时文件原子替换）。
- 转让生效后，旧鸽主未完成的报名自动冻结；已产生的名次仍归旧鸽主。
- 更正交接日或撤销转让时，按时间顺序重算后续报名资格，旧版本在 `revisions` 留档。

## 接口

- `GET /api/pigeons` 鸽只列表（含当前归属、进行中转让、报名统计）
- `POST /api/pigeons` 创建档案
- `GET /api/pigeons/:ringNo/relation` 血统（父母、子代）
- `GET /api/pigeons/:ringNo/ledger` 权益台履历（归属区间、转让单及留档、报名记录）
- `POST /api/pigeons/:ringNo/transfers` 登记转让 `{to, handoverDate, voucherNo, withdrawalDays}`
- `POST /api/transfers/:id/confirm` 双方确认 `{role: "from" | "to"}`
- `PATCH /api/transfers/:id` 更正交接日 / 凭证号 / 停药期
- `POST /api/transfers/:id/cancel` 撤销转让
- `POST /api/pigeons/:ringNo/entries` 比赛报名 `{event, distance, raceDate}`
- `POST /api/entries/:id/result` 录入名次 `{rank, returnTime}`
- `POST /api/pigeons/:ringNo/vaccines` 疫苗记录

列表、履历均由同一份台账实时推导，每次变更后前端重新拉取，刷新后一致。
