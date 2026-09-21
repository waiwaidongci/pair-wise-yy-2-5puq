import test from "node:test";
import assert from "node:assert/strict";
import {
  createTransfer, confirmTransfer, correctTransfer, cancelTransfer,
  createEntry, recordResult, ownerAt, transferStatus
} from "../src/domain/equity.js";

const at = date => new Date(`${date}T09:00:00.000Z`);

function freshDb() {
  return {
    seq: 1,
    pigeons: [
      { ringNo: "R-1", owner: "甲棚", fatherRing: "", motherRing: "", color: "灰", loft: "A棚", vaccines: [] }
    ],
    transfers: [],
    entries: []
  };
}

// 登记一笔转让并完成双方确认：交接日 2026-05-01 + 停药期 7 天 → 生效日 2026-05-08
function confirmedTransfer(db, patch = {}) {
  const transfer = createTransfer(db, "R-1",
    { to: "乙棚", handoverDate: "2026-05-01", voucherNo: "PZ-1", withdrawalDays: 7, ...patch },
    at("2026-04-20"));
  confirmTransfer(db, transfer.id, "from", at("2026-05-01"));
  confirmTransfer(db, transfer.id, "to", at("2026-05-02"));
  return transfer;
}

test("同一羽鸽生效区间重叠返回409且整笔不落库", () => {
  const db = freshDb();
  createTransfer(db, "R-1", { to: "乙棚", handoverDate: "2026-05-01", voucherNo: "PZ-1", withdrawalDays: 7 }, at("2026-04-20"));
  assert.throws(
    () => createTransfer(db, "R-1", { to: "丙棚", handoverDate: "2026-04-28", voucherNo: "PZ-2", withdrawalDays: 7 }, at("2026-04-21")),
    error => error.status === 409 && error.code === "transfer_interval_overlap"
  );
  assert.equal(db.transfers.length, 1);
  assert.equal(db.transfers[0].voucherNo, "PZ-1");
});

test("生效区间首尾相接不算重叠", () => {
  const db = freshDb();
  confirmedTransfer(db);
  const next = createTransfer(db, "R-1", { to: "丙棚", handoverDate: "2026-06-01", voucherNo: "PZ-2", withdrawalDays: 7 }, at("2026-05-10"));
  assert.equal(next.from, "乙棚");
  assert.equal(db.transfers.length, 2);
});

test("双方确认且过停药期才生效", () => {
  const db = freshDb();
  const transfer = createTransfer(db, "R-1", { to: "乙棚", handoverDate: "2026-05-01", voucherNo: "PZ-1", withdrawalDays: 7 }, at("2026-04-20"));
  assert.equal(transferStatus(transfer, "2026-05-03"), "pending");
  confirmTransfer(db, transfer.id, "from", at("2026-05-02"));
  assert.equal(transferStatus(transfer, "2026-05-03"), "pending");
  confirmTransfer(db, transfer.id, "to", at("2026-05-03"));
  assert.equal(transfer.effectiveDate, "2026-05-08");
  assert.equal(transferStatus(transfer, "2026-05-07"), "confirmed");
  assert.equal(transferStatus(transfer, "2026-05-08"), "effective");
  assert.equal(ownerAt(db, "R-1", "2026-05-07"), "甲棚");
  assert.equal(ownerAt(db, "R-1", "2026-05-08"), "乙棚");
});

test("确认完成日晚于停药期时以确认日为生效日", () => {
  const db = freshDb();
  const transfer = createTransfer(db, "R-1", { to: "乙棚", handoverDate: "2026-05-01", voucherNo: "PZ-1", withdrawalDays: 7 }, at("2026-04-20"));
  confirmTransfer(db, transfer.id, "from", at("2026-05-10"));
  confirmTransfer(db, transfer.id, "to", at("2026-05-11"));
  assert.equal(transfer.effectiveDate, "2026-05-11");
});

test("旧鸽主未完成报名冻结，已产生名次仍归旧鸽主", () => {
  const db = freshDb();
  const ranked = createEntry(db, "R-1", { event: "200公里资格赛", distance: 200, raceDate: "2026-04-20" }, at("2026-04-10"));
  recordResult(db, ranked.id, { rank: 3, returnTime: "10:01" }, at("2026-04-20"));
  const pending = createEntry(db, "R-1", { event: "300公里预赛", distance: 300, raceDate: "2026-06-01" }, at("2026-04-25"));
  assert.equal(pending.status, "entered");

  confirmedTransfer(db); // 生效日 2026-05-08

  assert.equal(pending.status, "frozen");
  assert.equal(ranked.status, "ranked");
  assert.equal(ranked.rankOwner, "甲棚");
  assert.throws(
    () => recordResult(db, pending.id, { rank: 1 }, at("2026-06-01")),
    error => error.status === 409 && error.code === "entry_frozen"
  );
});

test("更正交接日后按时间顺序重算报名资格，旧版本留档", () => {
  const db = freshDb();
  const entry = createEntry(db, "R-1", { event: "300公里预赛", distance: 300, raceDate: "2026-06-01" }, at("2026-04-25"));
  const transfer = confirmedTransfer(db);
  assert.equal(entry.status, "frozen");

  correctTransfer(db, transfer.id, { handoverDate: "2026-06-15" }, at("2026-05-03"));

  assert.equal(transfer.effectiveDate, "2026-06-22");
  assert.equal(entry.status, "entered");
  assert.equal(transfer.revisions.length, 1);
  assert.equal(transfer.revisions[0].snapshot.handoverDate, "2026-05-01");
  assert.equal(transfer.revisions[0].snapshot.effectiveDate, "2026-05-08");
});

test("更正交接日造成区间重叠同样409且不留档", () => {
  const db = freshDb();
  confirmedTransfer(db);
  const second = createTransfer(db, "R-1", { to: "丙棚", handoverDate: "2026-06-01", voucherNo: "PZ-2", withdrawalDays: 7 }, at("2026-05-10"));
  assert.throws(
    () => correctTransfer(db, second.id, { handoverDate: "2026-04-25" }, at("2026-05-11")),
    error => error.status === 409 && error.code === "transfer_interval_overlap"
  );
  assert.equal(second.handoverDate, "2026-06-01");
  assert.equal(second.revisions.length, 0);
});

test("撤销转让后按时间顺序重算报名资格并留档", () => {
  const db = freshDb();
  const entry = createEntry(db, "R-1", { event: "300公里预赛", distance: 300, raceDate: "2026-06-01" }, at("2026-04-25"));
  const transfer = confirmedTransfer(db);
  assert.equal(entry.status, "frozen");

  cancelTransfer(db, transfer.id, at("2026-05-05"));

  assert.equal(transferStatus(transfer, "2026-05-06"), "cancelled");
  assert.equal(entry.status, "entered");
  assert.equal(ownerAt(db, "R-1", "2026-06-01"), "甲棚");
  assert.equal(transfer.revisions.length, 1);
  assert.equal(transfer.revisions[0].reason, "撤销转让");
});

test("生效后新鸽主报名有效且名次归新鸽主", () => {
  const db = freshDb();
  confirmedTransfer(db);
  const entry = createEntry(db, "R-1", { event: "500公里决赛", distance: 500, raceDate: "2026-06-10" }, at("2026-05-20"));
  assert.equal(entry.entrant, "乙棚");
  assert.equal(entry.status, "entered");
  recordResult(db, entry.id, { rank: 2 }, at("2026-06-10"));
  assert.equal(entry.rankOwner, "乙棚");
});

test("同一羽鸽凭证号重复返回409", () => {
  const db = freshDb();
  createTransfer(db, "R-1", { to: "乙棚", handoverDate: "2026-05-01", voucherNo: "PZ-1", withdrawalDays: 7 }, at("2026-04-20"));
  assert.throws(
    () => createTransfer(db, "R-1", { to: "丙棚", handoverDate: "2026-06-01", voucherNo: "PZ-1", withdrawalDays: 7 }, at("2026-05-10")),
    error => error.status === 409 && error.code === "voucher_no_exists"
  );
  assert.equal(db.transfers.length, 1);
});
