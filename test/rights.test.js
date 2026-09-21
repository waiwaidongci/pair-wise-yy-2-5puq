import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, withdrawalClearDate, effectiveDate, annotateTransfer,
  hasDateOverlap, ownerOn, currentOwner, recomputeEntries, buildView, buildHistory
} from "../src/rights.js";

const TODAY = "2026-09-21";

const pigeon = (over = {}) => ({
  ringNo: "P1", initialOwner: "甲", owner: "甲",
  vaccines: [], transfers: [], entries: [], races: [],
  ...over
});

test("停药解除日取各针次 date+停药天 的最大值", () => {
  const p = pigeon({ vaccines: [
    { date: "2026-09-01", name: "A", withdrawalDays: 21 },
    { date: "2026-09-10", name: "B", withdrawalDays: 7 }
  ] });
  assert.equal(withdrawalClearDate(p, TODAY), addDays("2026-09-01", 21));
  assert.equal(withdrawalClearDate(p, TODAY), "2026-09-22");
});

test("双方确认 + 过停药期 + 到交接日才生效，生效日取三者最大", () => {
  const p = pigeon({ vaccines: [{ date: "2026-09-10", withdrawalDays: 30 }] });
  const t = { id: "t1", date: "2026-09-15", from: "甲", to: "乙",
    fromConfirmed: true, toConfirmed: true, confirmedAt: "2026-09-12T08:00:00Z" };
  assert.equal(effectiveDate(t, p), "2026-10-10");
  assert.equal(annotateTransfer(t, p, TODAY).status, "waiting");
  assert.equal(annotateTransfer(t, p, TODAY).reason, "withdrawal_hold");

  const half = { ...t, toConfirmed: false };
  assert.equal(annotateTransfer(half, p, TODAY).status, "pending");

  const cleanPigeon = pigeon({ vaccines: [] });
  const clean = { ...t, date: "2026-11-01" };
  assert.equal(annotateTransfer(clean, cleanPigeon, TODAY).reason, "scheduled");
});

test("生效区间重叠：同日且未撤销即冲突，撤销后不冲突", () => {
  const p = pigeon({ transfers: [
    { id: "t1", date: "2026-10-01", revoked: false },
    { id: "t2", date: "2026-10-02", revoked: true }
  ] });
  assert.equal(hasDateOverlap(p, "2026-10-01"), true);
  assert.equal(hasDateOverlap(p, "2026-10-01", "t1"), false);
  assert.equal(hasDateOverlap(p, "2026-10-02"), false);
});

test("鸽主随生效区间变化，未确认转让不改变归属", () => {
  const p = pigeon({ transfers: [
    { id: "t1", date: "2026-05-01", from: "甲", to: "乙", fromConfirmed: true, toConfirmed: true, confirmedAt: "2026-05-01T00:00Z" },
    { id: "t2", date: "2026-08-01", from: "乙", to: "丙", fromConfirmed: true, toConfirmed: false, confirmedAt: "" }
  ] });
  assert.equal(ownerOn(p, "2026-04-30", TODAY), "甲");
  assert.equal(ownerOn(p, "2026-06-01", TODAY), "乙");
  assert.equal(currentOwner(p, TODAY), "乙"); // 未确认不生效
});

test("旧鸽主未完成报名冻结，已产生名次归旧鸽主", () => {
  const p = pigeon({
    transfers: [{ id: "t1", date: "2026-05-01", from: "甲", to: "乙",
      fromConfirmed: true, toConfirmed: true, confirmedAt: "2026-05-01T00:00Z" }],
    entries: [
      { id: "e1", raceDate: "2026-10-01", event: "秋赛", registeredBy: "甲", status: "pending" },
      { id: "e2", raceDate: "2026-10-02", event: "秋赛B", registeredBy: "乙", status: "pending" },
      { id: "e3", raceDate: "2026-06-01", event: "春赛", registeredBy: "甲", status: "completed", attributedOwner: "甲" }
    ],
    races: [{ id: "r1", date: "2026-06-01", event: "春赛", rank: 3, attributedOwner: "甲" }]
  });
  const entries = recomputeEntries(p, TODAY);
  const byId = Object.fromEntries(entries.map(e => [e.id, e.status]));
  assert.equal(byId.e1, "frozen");
  assert.equal(byId.e2, "qualified");
  assert.equal(byId.e3, "completed");
  const view = buildView(p, TODAY);
  assert.equal(view.races[0].attributedOwner, "甲"); // 名次不随后续转让变
});

test("撤销转让后按时间顺序重算资格，履历含旧版本留档", () => {
  const p = pigeon({
    transfers: [{ id: "t1", date: "2026-05-01", from: "甲", to: "乙",
      fromConfirmed: true, toConfirmed: true, confirmedAt: "2026-05-01T00:00Z",
      revoked: true, revokedAt: "2026-09-01T00:00Z",
      revisions: [{ at: "2026-09-01T00:00Z", action: "revoke",
        before: { date: "2026-05-01", from: "甲", to: "乙" }, after: { revoked: true } }] }],
    entries: [{ id: "e1", raceDate: "2026-10-01", event: "秋赛", registeredBy: "甲", status: "pending" }]
  });
  const [e] = recomputeEntries(p, TODAY);
  assert.equal(e.status, "qualified"); // 撤销后甲仍是权益鸽主
  assert.equal(currentOwner(p, TODAY), "甲");
  const history = buildHistory(p, TODAY);
  assert.ok(history.some(i => i.kind === "revision" && i.snapshot));
});
