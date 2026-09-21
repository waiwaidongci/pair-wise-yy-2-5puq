# 赛鸽转让生效与权益台

在原赛鸽血统环号登记站基础上补全「转让生效 + 权益判定」。

```bash
npm start        # http://localhost:3024
npm test         # node --test（8 个用例，含端到端）
```

## 三业务模块

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 请求入口 | `src/routes.js` | HTTP 路由、入参校验、状态码（400/404/409/2xx），只编排不落规则 |
| 权益判定 | `src/rights.js` | 纯函数、无 IO：生效条件、区间重叠、权益鸽主、报名资格重算、统一视图/履历 |
| 记录持久化 | `src/store.js` | JSON 原子写（临时文件+rename）、写入串行队列、旧数据迁移 |

页面在 `src/page.js`，HTTP 装配在 `server.js`。

## 业务规则

- **每笔转让四要素**：原鸽主 `from`、受让人 `to`、交接日 `date`、凭证号 `voucherNo`（同羽鸽未撤销凭证号唯一）。
- **生效条件**：双方（旧鸽主/受让人）都确认 **且** 过停药期 **且** 到达交接日；
  生效日 = `max(交接日, 最近用药日+停药天数, 双方确认完成日)`。未满足前状态为
  `pending`（待确认）/ `waiting`（停药期未满 `withdrawal_hold` 或交接日未到 `scheduled`）。
- **区间重叠 409**：同一羽鸽存在未撤销且交接日相同的转让时，登记/更正直接 `409 transfer_overlap`，
  冲突在写入前判定，**整笔不落库**（队列里先克隆草稿，抛错不替换正式文件）。
- **旧鸽主冻结**：未完赛报名若报名人 ≠ 该比赛日权益鸽主，则 `frozen`；一致为 `qualified`。
- **名次归旧鸽主**：赛绩落库瞬间把名次归属冻结到比赛日权益鸽主（`attributedOwner`），后续转让不改变。
- **更正交接日 / 撤销转让**：旧版本完整快照写入该笔转让 `revisions` 与鸽只 `revisionLog`，
  随后按比赛日时间顺序 `recomputeEntries` 重算全部未完赛报名资格；已完赛 `completed` 不动。
  接口返回 `entryChanges` 说明哪些报名资格发生了变化。
- **一致性**：列表、血统详情、刷新后展示都走唯一口径 `buildView`；
  时间线（转让/确认/报名/成绩/用药/旧版本留档）走 `buildHistory`，按日期排序。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/pigeons` | 列表（统一权益视图） |
| POST | `/api/pigeons` | 建档（足环号重复 409） |
| GET | `/api/pigeons/:ring/relation` | 血统 + 权益 |
| GET | `/api/pigeons/:ring/history` | 时间顺序履历（含旧版留档） |
| POST | `/api/pigeons/:ring/transfers` | 登记转让（重叠/凭证号重复 409） |
| POST | `/api/pigeons/:ring/transfers/:tid/confirm` | `{side:"from"|"to"}` 任一方确认 |
| PATCH | `/api/pigeons/:ring/transfers/:tid` | `{date}` 更正交接日（留档+重算） |
| DELETE | `/api/pigeons/:ring/transfers/:tid` | 撤销转让（留档+重算） |
| POST | `/api/pigeons/:ring/entries` | 报名（按比赛日权益判定 qualified/frozen） |
| POST | `/api/pigeons/:ring/races` | 录成绩（归属冻结到比赛日权益鸽主） |
| POST | `/api/pigeons/:ring/vaccines` | 录用药及停药天数（默认 21 天） |

老版本数据文件首次加载时自动迁移：旧转让补凭证号并视为双方已确认，旧疫苗补默认停药期，
旧赛绩不预填归属而由权益模块按比赛日回溯判定。
