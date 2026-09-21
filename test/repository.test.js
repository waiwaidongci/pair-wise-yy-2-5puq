import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("旧版嵌入式转让/成绩迁移为转让单与报名台账", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pigeon-"));
  process.env.PIGEON_DB = join(dir, "db.json");
  const legacy = {
    pigeons: [{
      ringNo: "R-1", owner: "乙棚", fatherRing: "", motherRing: "", color: "灰", loft: "A棚",
      vaccines: [{ date: "2026-04-01", name: "新城疫" }],
      transfers: [{ date: "2026-04-15", from: "甲棚", to: "乙棚" }],
      races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }]
    }]
  };
  await writeFile(process.env.PIGEON_DB, JSON.stringify(legacy));
  try {
    const { loadDb } = await import("../src/store/repository.js");
    const db = await loadDb();
    assert.equal(db.pigeons[0].owner, "甲棚"); // 初始鸽主还原为最早一笔转让的转出方
    assert.equal(db.pigeons[0].transfers, undefined);
    assert.equal(db.pigeons[0].races, undefined);
    assert.equal(db.transfers.length, 1);
    assert.equal(db.transfers[0].effectiveDate, "2026-04-15");
    assert.equal(db.transfers[0].voucherNo, "LEGACY-R-1-1");
    assert.equal(db.entries.length, 1);
    assert.equal(db.entries[0].status, "ranked");
    assert.equal(db.entries[0].entrant, "乙棚"); // 名次按比赛日归属
    assert.equal(db.entries[0].rankOwner, "乙棚");
    const again = await loadDb(); // 迁移幂等
    assert.equal(again.transfers.length, 1);
    assert.equal(again.entries.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
