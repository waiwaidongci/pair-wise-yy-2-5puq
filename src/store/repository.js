// 记录持久化模块：JSON 台账读写（临时文件 + 原子替换）、旧版结构迁移、写操作串行化。
// 判定逻辑见 src/domain/equity.js，本模块只负责把内存状态安全落盘。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownerAt } from "../domain/equity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.PIGEON_DB || join(__dirname, "..", "..", "data", "pigeons.json");

const seed = {
  seq: 3,
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "育种棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫" }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [] }
  ],
  transfers: [
    {
      id: "T-0001", ringNo: "CHN-2026-001", from: "育种棚", to: "北岸棚",
      handoverDate: "2026-04-15", voucherNo: "LEGACY-CHN-2026-001-1", withdrawalDays: 0,
      confirmations: { from: "2026-04-15T00:00:00.000Z", to: "2026-04-15T00:00:00.000Z" },
      effectiveDate: "2026-04-15", cancelledAt: null, revisions: [],
      createdAt: "2026-04-15T00:00:00.000Z", seq: 1
    }
  ],
  entries: [
    {
      id: "E-0002", ringNo: "CHN-2026-001", event: "120公里训放", distance: 120,
      raceDate: "2026-06-01", entrant: "北岸棚", status: "ranked",
      rank: 18, returnTime: "10:42", rankOwner: "北岸棚",
      rankedAt: "2026-06-01T10:42:00.000Z", createdAt: "2026-06-01T10:42:00.000Z", seq: 2
    }
  ]
};

// 旧版结构（转让/成绩嵌在鸽只档案内）迁移为转让单 + 报名台账
function migrate(db) {
  const pigeons = db.pigeons || [];
  const alreadyMigrated = Array.isArray(db.transfers) && Array.isArray(db.entries) &&
    pigeons.every(item => !item.transfers && !item.races);
  if (alreadyMigrated) return db;

  const next = {
    seq: db.seq || 1,
    pigeons: [],
    transfers: [...(db.transfers || [])],
    entries: [...(db.entries || [])]
  };
  const legacyRaces = [];
  for (const pigeon of pigeons) {
    const { transfers: legacyTransfers = [], races = [], ...rest } = pigeon;
    const sorted = [...legacyTransfers].sort((a, b) => a.date.localeCompare(b.date));
    // 旧档案的 owner 已被末笔转让覆盖，用最早一笔转让的转出方还原初始鸽主
    next.pigeons.push({ ...rest, owner: sorted.length ? sorted[0].from : pigeon.owner, vaccines: pigeon.vaccines || [] });
    for (const [index, item] of legacyTransfers.entries()) {
      const seq = next.seq++;
      next.transfers.push({
        id: `T-${String(seq).padStart(4, "0")}`,
        ringNo: pigeon.ringNo,
        from: item.from,
        to: item.to,
        handoverDate: item.date,
        voucherNo: `LEGACY-${pigeon.ringNo}-${index + 1}`,
        withdrawalDays: 0,
        confirmations: { from: `${item.date}T00:00:00.000Z`, to: `${item.date}T00:00:00.000Z` },
        effectiveDate: item.date,
        cancelledAt: null,
        revisions: [],
        createdAt: `${item.date}T00:00:00.000Z`,
        seq
      });
    }
    for (const race of races) legacyRaces.push({ ringNo: pigeon.ringNo, ...race });
  }
  for (const race of legacyRaces) {
    const seq = next.seq++;
    const entrant = ownerAt(next, race.ringNo, race.date);
    next.entries.push({
      id: `E-${String(seq).padStart(4, "0")}`,
      ringNo: race.ringNo,
      event: race.event,
      distance: Number(race.distance || 0),
      raceDate: race.date,
      entrant,
      status: "ranked",
      rank: Number(race.rank || 0),
      returnTime: race.returnTime || "",
      rankOwner: entrant,
      rankedAt: `${race.date}T00:00:00.000Z`,
      createdAt: `${race.date}T00:00:00.000Z`,
      seq
    });
  }
  return next;
}

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await saveDb(structuredClone(seed));
  }
  return migrate(JSON.parse(await readFile(dbPath, "utf8")));
}

export async function saveDb(db) {
  const tmp = `${dbPath}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath); // 原子替换，避免半截文件
}

// 写操作串行化：读库 → 内存变更 → 落库为一个临界区；
// 变更函数抛错（如 409 区间重叠）时不落库，整笔不留痕。
let queue = Promise.resolve();
export function transact(fn) {
  const run = queue.then(async () => {
    const db = await loadDb();
    const result = await fn(db);
    await saveDb(db);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}
