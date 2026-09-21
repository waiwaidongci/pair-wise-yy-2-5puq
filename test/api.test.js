import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { JsonStore } from "../src/store.js";
import { createApi, HttpError } from "../src/routes.js";

let dir, server, base;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "pigeon-"));
  const store = new JsonStore(join(dir, "pigeons.json"));
  const api = createApi(store);
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const result = await api.handle(req, url);
      res.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result.body));
    } catch (e) {
      const s = e instanceof HttpError ? e.status : 500;
      res.writeHead(s, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e.error || "server_error", message: e.message }));
    }
  });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });

test("端到端：登记→双方确认→停药期→生效→资格→409→更正/撤销重算→留档", async () => {
  // 建档（甲），今天 2026-09-21
  let r = await call("POST", "/api/pigeons", { ringNo: "P-1", owner: "甲", color: "灰", loft: "一号棚" });
  assert.equal(r.status, 201);

  // 9月10日用药，停药30天 → 10月10日解除
  r = await call("POST", "/api/pigeons/P-1/vaccines", { date: "2026-09-10", name: "呼肠孤", withdrawalDays: 30 });
  assert.equal(r.status, 201);

  // 登记转让：甲→乙，交接日 10-15，凭证号 V001（生效日 10-15）
  r = await call("POST", "/api/pigeons/P-1/transfers", { date: "2026-10-15", to: "乙", voucherNo: "V001" });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, "pending");
  const tid = r.data.id;

  // 区间重叠：同日再来一笔 → 409 且整笔不落库
  const before = await call("GET", "/api/pigeons");
  r = await call("POST", "/api/pigeons/P-1/transfers", { date: "2026-10-15", to: "丙", voucherNo: "V002" });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "transfer_overlap");
  const after = await call("GET", "/api/pigeons");
  assert.equal(before.data[0].transfers.length, after.data[0].transfers.length);
  assert.ok(!after.data[0].transfers.some(t => t.voucherNo === "V002"));

  // 甲报名 11-05 秋赛：转让尚未确认 → 比赛日权益人仍为甲 → qualified
  r = await call("POST", "/api/pigeons/P-1/entries", { raceDate: "2026-11-05", event: "秋赛", registeredBy: "甲" });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, "qualified");
  const eid = r.data.id;

  // 旧鸽主确认后仍待受让人确认
  r = await call("POST", `/api/pigeons/P-1/transfers/${tid}/confirm`, { side: "from" });
  assert.equal(r.data.status, "pending");
  // 受让人确认：双方齐，但今天停药期未满 → waiting
  r = await call("POST", `/api/pigeons/P-1/transfers/${tid}/confirm`, { side: "to" });
  assert.equal(r.data.status, "waiting");
  assert.equal(r.data.reason, "withdrawal_hold");

  // 当前鸽主仍是甲（今天 9-21，10-15 才交接）；但刷新视图可看到待生效区间
  let view = (await call("GET", "/api/pigeons")).data.find(p => p.ringNo === "P-1");
  assert.equal(view.owner, "甲");
  assert.equal(view.transfers[0].status, "waiting");
  // 确认后，甲的 11-05 报名按比赛日重算：当日权益人是乙 → 冻结
  assert.equal(view.entries.find(e => e.id === eid).status, "frozen");

  // 录历史赛绩（8-01，早于转让）：名次归旧鸽主甲
  r = await call("POST", "/api/pigeons/P-1/races", { date: "2026-08-01", event: "夏赛", rank: 9 });
  assert.equal(r.status, 201);
  assert.equal(r.data.attributedOwner, "甲");

  // 再登记一笔 11-01 → 丁，双方已确认：比赛日 11-05 的权益人进一步变为丁
  r = await call("POST", "/api/pigeons/P-1/transfers", { date: "2026-11-01", to: "丁", voucherNo: "V003",
    fromConfirmed: true, toConfirmed: true });
  assert.equal(r.status, 201);
  assert.equal(r.data.effectiveDate, "2026-11-01");
  view = (await call("GET", "/api/pigeons")).data.find(p => p.ringNo === "P-1");
  assert.equal(view.entries.find(e => e.id === eid).status, "frozen");

  // 撤销 11-01 转让：按时间顺序重算，11-05 权益人回到乙；甲仍冻结
  const t2 = view.transfers.find(t => t.voucherNo === "V003").id;
  r = await call("DELETE", `/api/pigeons/P-1/transfers/${t2}`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.transfer.status, "revoked");
  assert.equal(r.data.pigeon.entries.find(e => e.id === eid).status, "frozen");
  assert.ok(Array.isArray(r.data.entryChanges));

  // 更正首笔交接日 10-15 → 09-15：早于停药解除日，生效日仍为 10-10，旧版留档
  r = await call("PATCH", `/api/pigeons/P-1/transfers/${tid}`, { date: "2026-09-15" });
  assert.equal(r.status, 200);
  assert.equal(r.data.transfer.effectiveDate, "2026-10-10");
  // 更正成与已撤销 V003 同日(11-01)不冲突，但与自己原日重叠检查用 excludeId
  r = await call("PATCH", `/api/pigeons/P-1/transfers/${tid}`, { date: "2026-11-01" });
  assert.equal(r.status, 200);
  // 更正到未撤销区间之外再改，验证第二次留档也写入
  r = await call("GET", "/api/pigeons/P-1/history");
  const revisions = r.data.items.filter(i => i.kind === "revision");
  assert.ok(revisions.length >= 2);
  assert.ok(revisions.some(i => i.snapshot && i.snapshot.date === "2026-10-15"));
  const dates = r.data.items.map(i => i.date);
  assert.deepEqual(dates, [...dates].sort());

  // 与已撤销记录同日可重新登记
  r = await call("POST", "/api/pigeons/P-1/transfers", { date: "2026-11-01", to: "丁", voucherNo: "V004",
    fromConfirmed: true, toConfirmed: true });
  assert.equal(r.status, 409, "与刚更正到 11-01 的未撤销区间重叠应拒绝");
  r = await call("PATCH", `/api/pigeons/P-1/transfers/${tid}`, { date: "2026-10-15" });
  assert.equal(r.status, 200);
  r = await call("POST", "/api/pigeons/P-1/transfers", { date: "2026-11-01", to: "丁", voucherNo: "V004",
    fromConfirmed: true, toConfirmed: true });
  assert.equal(r.status, 201);

  // 刷新后一致：列表与详情同一口径
  r = await call("GET", "/api/pigeons/P-1/relation");
  const list = (await call("GET", "/api/pigeons")).data.find(p => p.ringNo === "P-1");
  assert.equal(r.data.pigeon.owner, list.owner);
  assert.equal(r.data.pigeon.transfers.length, list.transfers.length);
  assert.equal(r.data.pigeon.entries.length, list.entries.length);
});

test("入参校验：缺凭证号 400；错误日期格式 400；未知鸽只 404", async () => {
  let r = await call("POST", "/api/pigeons/NOPE/transfers", { date: "2026-10-01", to: "乙" });
  assert.equal(r.status, 404);
  await call("POST", "/api/pigeons", { ringNo: "P-2", owner: "甲", color: "灰", loft: "棚" });
  r = await call("POST", "/api/pigeons/P-2/transfers", { date: "2026-10-01", to: "乙" });
  assert.equal(r.status, 400);
  r = await call("POST", "/api/pigeons/P-2/transfers", { date: "10/01", to: "乙", voucherNo: "X" });
  assert.equal(r.status, 400);
});
