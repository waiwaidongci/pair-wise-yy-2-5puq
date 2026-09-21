// 模块三：记录持久化
// 负责 JSON 文件读写、历史数据迁移、写入串行化与原子替换。
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const defaultDbPath = join(__dirname, "..", "data", "pigeons.json");

// 旧登记站的转让记录没有凭证号/双方确认，迁移为已生效的历史转让。
function migrate(raw) {
  let changed = false;
  for (const p of raw.pigeons || []) {
    if (!p.initialOwner) {
      p.initialOwner = (p.transfers && p.transfers[0] && p.transfers[0].from) || p.owner || "";
      changed = true;
    }
    if (p.transfers) {
      p.transfers.forEach((t, i) => {
        if (!t.id) {
          t.id = `${p.ringNo}-T${i + 1}`;
          changed = true;
        }
        if (!("voucherNo" in t)) {
          t.voucherNo = `LEGACY-${t.id}`;
          changed = true;
        }
        if (!("fromConfirmed" in t)) {
          t.fromConfirmed = true;
          t.toConfirmed = true;
          t.confirmedAt = `${t.date}T00:00:00.000Z`;
          changed = true;
        }
        if (!t.revisions) { t.revisions = []; changed = true; }
        if (t.revoked) changed = true;
      });
    } else {
      p.transfers = [];
      changed = true;
    }
    for (const key of ["entries", "revisionLog"]) {
      if (!p[key]) { p[key] = []; changed = true; }
    }
    for (const key of ["entries", "revisionLog", "vaccines", "races"]) {
      if (!p[key]) { p[key] = []; changed = true; }
    }
    for (const v of p.vaccines) {
      if (v.withdrawalDays === undefined) {
        // 老数据未录停药期，按新城疫常规 21 天补默认值。
        v.withdrawalDays = 21;
        changed = true;
      }
    }
    p.races.forEach((r, i) => {
      if (!r.id) { r.id = `${p.ringNo}-R${i + 1}`; changed = true; }
      // 旧赛绩归属不预填：由权益模块按比赛日权益人在视图层判定，
      // 避免把当前 owner 错锁为名次归属。
    });
  }
  return { db: raw, changed };
}

export class JsonStore {
  constructor(filePath = defaultDbPath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async load() {
    if (!existsSync(this.filePath)) {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(emptyDb(), null, 2));
      return emptyDb();
    }
    const raw = JSON.parse(await readFile(this.filePath, "utf8"));
    const { db, changed } = migrate(raw);
    if (changed) await this.persist(db);
    return db;
  }

  // 所有写操作经同一队列串行化；mutate 抛错则整笔不落库（含 409）。
  async mutate(mutator) {
    const run = this.queue.then(async () => {
      const db = await this.load();
      const draft = structuredClone(db);
      const result = await mutator(draft);
      await this.persist(draft);
      return result === undefined ? draft : result;
    });
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  async persist(db) {
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, this.filePath);
  }
}

export function emptyDb() {
  return { pigeons: [], seq: 0 };
}

export function nextId(db, prefix) {
  db.seq = (db.seq || 0) + 1;
  return `${prefix}${String(db.seq).padStart(4, "0")}`;
}
