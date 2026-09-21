// 模块一：请求入口
// HTTP 路由、入参校验、状态码；业务规则只调用模块二，落库只经模块三。
import { JsonStore, nextId } from "./store.js";
import {
  buildView, buildHistory, annotateTransfer, hasDateOverlap, recomputeEntries,
  ownerOn, todayStr, DEFAULT_WITHDRAWAL_DAYS
} from "./rights.js";

export class HttpError extends Error {
  constructor(status, error, message) {
    super(message || error);
    this.status = status;
    this.error = error;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function requireDate(value, field) {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new HttpError(400, "invalid_date", `${field}需为 YYYY-MM-DD`);
  }
  return value;
}
function requireStr(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "missing_field", `缺少${field}`);
  }
  return value.trim();
}
function str(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function nowIso() { return new Date().toISOString(); }
export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

function diffEntries(before, after) {
  return after.filter(a => {
    const b = before.find(x => x.id === a.id);
    return b && b.status !== a.status;
  }).map(a => ({ id: a.id, event: a.event, raceDate: a.raceDate, from: "", to: a.status }));
}

export function createApi(store = new JsonStore()) {
  const findPigeon = async ringNo => {
    const db = await store.load();
    const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
    if (!pigeon) throw new HttpError(404, "pigeon_not_found", `未找到鸽只 ${ringNo}`);
    return pigeon;
  };

  const routes = [];
  const add = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---------- 档案 ----------
  add("GET", /^\/api\/pigeons$/, async () => {
    const db = await store.load();
    const today = todayStr();
    return { status: 200, body: db.pigeons.map(p => buildView(p, today)) };
  });

  add("POST", /^\/api\/pigeons$/, async (_, input) => {
    const ringNo = requireStr(input.ringNo, "足环号");
    const owner = requireStr(input.owner, "鸽主");
    const pigeon = await store.mutate(db => {
      if (db.pigeons.some(p => p.ringNo === ringNo)) {
        throw new HttpError(409, "ring_exists", "足环号已登记");
      }
      const p = {
        ringNo,
        initialOwner: owner,
        owner,
        fatherRing: str(input.fatherRing),
        motherRing: str(input.motherRing),
        color: requireStr(input.color, "羽色"),
        loft: requireStr(input.loft, "出生棚号"),
        vaccines: [], transfers: [], entries: [], races: [], revisionLog: []
      };
      db.pigeons.unshift(p);
      return p;
    });
    return { status: 201, body: buildView(pigeon) };
  });

  add("GET", /^\/api\/pigeons\/(.+)\/relation$/, async ({ ring }) => {
    const db = await store.load();
    const today = todayStr();
    const pigeon = db.pigeons.find(p => p.ringNo === ring);
    if (!pigeon) throw new HttpError(404, "pigeon_not_found");
    const father = db.pigeons.find(p => p.ringNo === pigeon.fatherRing) || null;
    const mother = db.pigeons.find(p => p.ringNo === pigeon.motherRing) || null;
    const children = db.pigeons.filter(p => p.fatherRing === ring || p.motherRing === ring);
    return {
      status: 200,
      body: {
        pigeon: buildView(pigeon, today),
        father: father && buildView(father, today),
        mother: mother && buildView(mother, today),
        children: children.map(p => buildView(p, today))
      }
    };
  });

  // ---------- 转让登记 ----------
  add("POST", /^\/api\/pigeons\/(.+)\/transfers$/, async ({ ring }, input) => {
    const pigeon = await findPigeon(ring);
    const date = requireDate(input.date || todayStr(), "交接日");
    const to = requireStr(input.to, "受让人");
    const voucherNo = requireStr(input.voucherNo, "凭证号");
    const from = str(input.from) || ownerOn(pigeon, date);
    if (!from) throw new HttpError(400, "missing_field", "缺少原鸽主");

    // 409 在任何写入前判定，整笔不落库。
    if (hasDateOverlap(pigeon, date)) {
      throw new HttpError(409, "transfer_overlap", `该羽鸽在 ${date} 已有未撤销转让，生效区间重叠`);
    }
    const today = todayStr();
    const saved = await store.mutate(db => {
      const p = db.pigeons.find(x => x.ringNo === ring);
      if (hasDateOverlap(p, date)) {
        throw new HttpError(409, "transfer_overlap", "该羽鸽同日已有未撤销转让");
      }
      if (p.transfers.some(t => !t.revoked && t.voucherNo === voucherNo)) {
        throw new HttpError(409, "voucher_duplicate", "凭证号已用于该羽鸽的未撤销转让");
      }
      const transfer = {
        id: nextId(db, `${ring}-T-`),
        date, from, to, voucherNo,
        fromConfirmed: Boolean(input.fromConfirmed),
        toConfirmed: Boolean(input.toConfirmed),
        confirmedAt: input.fromConfirmed && input.toConfirmed ? nowIso() : "",
        createdAt: nowIso(),
        revoked: false,
        revisions: []
      };
      p.transfers.push(transfer);
      return transfer;
    });
    const db2 = await store.load();
    const p2 = db2.pigeons.find(x => x.ringNo === ring);
    return { status: 201, body: annotateTransfer(saved, p2, today) };
  });

  // 双方确认（旧鸽主/受让人分别确认；两边齐了才可能生效，且仍受停药期约束）
  add("POST", /^\/api\/pigeons\/(.+)\/transfers\/(.+)\/confirm$/, async ({ ring, tid }, input) => {
    const side = input.side === "from" || input.side === "to" ? input.side : null;
    if (!side) throw new HttpError(400, "missing_field", "side 需为 from 或 to");
    const today = todayStr();
    await store.mutate(db => {
      const p = db.pigeons.find(x => x.ringNo === ring);
      if (!p) throw new HttpError(404, "pigeon_not_found");
      const t = p.transfers.find(x => x.id === tid);
      if (!t) throw new HttpError(404, "transfer_not_found");
      if (t.revoked) throw new HttpError(409, "transfer_revoked", "转让已撤销");
      const key = side === "from" ? "fromConfirmed" : "toConfirmed";
      if (!t[key]) {
        t[key] = true;
        if (t.fromConfirmed && t.toConfirmed && !t.confirmedAt) t.confirmedAt = nowIso();
      }
    });
    const db2 = await store.load();
    const p2 = db2.pigeons.find(x => x.ringNo === ring);
    const t2 = p2.transfers.find(x => x.id === tid);
    return { status: 200, body: annotateTransfer(t2, p2, today) };
  });

  // 更正交接日：旧版本留档，按时间顺序重算后续报名资格
  add("PATCH", /^\/api\/pigeons\/(.+)\/transfers\/(.+)$/, async ({ ring, tid }, input) => {
    const newDate = requireDate(input.date, "新交接日");
    const today = todayStr();
    const result = await store.mutate(db => {
      const p = db.pigeons.find(x => x.ringNo === ring);
      if (!p) throw new HttpError(404, "pigeon_not_found");
      const t = p.transfers.find(x => x.id === tid);
      if (!t) throw new HttpError(404, "transfer_not_found");
      if (t.revoked) throw new HttpError(409, "transfer_revoked", "已撤销转让不能更正");
      if (hasDateOverlap(p, newDate, tid)) {
        throw new HttpError(409, "transfer_overlap", `更正后与该羽鸽 ${newDate} 的转让区间重叠`);
      }
      const beforeEntries = recomputeEntries(p, today);
      const beforeSnapshot = { date: t.date, from: t.from, to: t.to, voucherNo: t.voucherNo,
        fromConfirmed: t.fromConfirmed, toConfirmed: t.toConfirmed, confirmedAt: t.confirmedAt };
      t.date = newDate;
      const afterEntries = recomputeEntries(p, today);
      const entryChanges = diffEntries(beforeEntries, afterEntries)
        .map(c => ({ ...c, from: beforeEntries.find(x => x.id === c.id).status }));
      t.revisions.push({ at: nowIso(), action: "correct_date", by: str(input.by), before: beforeSnapshot, after: { date: newDate }, entryChanges });
      p.revisionLog.push({ at: nowIso(), action: "correct_date", transferId: tid, from: beforeSnapshot.date, to: newDate });
      return { transfer: t, entryChanges };
    });
    const db2 = await store.load();
    const p2 = db2.pigeons.find(x => x.ringNo === ring);
    return { status: 200, body: { transfer: annotateTransfer(result.transfer, p2, today), entryChanges: result.entryChanges, pigeon: buildView(p2, today) } };
  });

  // 撤销转让：旧版本留档，重算后续报名资格
  add("DELETE", /^\/api\/pigeons\/(.+)\/transfers\/(.+)$/, async ({ ring, tid }, input) => {
    const today = todayStr();
    const result = await store.mutate(db => {
      const p = db.pigeons.find(x => x.ringNo === ring);
      if (!p) throw new HttpError(404, "pigeon_not_found");
      const t = p.transfers.find(x => x.id === tid);
      if (!t) throw new HttpError(404, "transfer_not_found");
      if (t.revoked) throw new HttpError(409, "transfer_revoked", "转让已处于撤销状态");
      const beforeEntries = recomputeEntries(p, today);
      const snapshot = { date: t.date, from: t.from, to: t.to, voucherNo: t.voucherNo,
        fromConfirmed: t.fromConfirmed, toConfirmed: t.toConfirmed, confirmedAt: t.confirmedAt };
      t.revoked = true;
      t.revokedAt = nowIso();
      const afterEntries = recomputeEntries(p, today);
      const entryChanges = diffEntries(beforeEntries, afterEntries)
        .map(c => ({ ...c, from: beforeEntries.find(x => x.id === c.id).status }));
      t.revisions.push({ at: t.revokedAt, action: "revoke", by: str(input.by), before: snapshot, after: { revoked: true }, entryChanges });
      p.revisionLog.push({ at: t.revokedAt, action: "revoke", transferId: tid });
      return { transfer: t, entryChanges };
    });
    const db2 = await store.load();
    const p2 = db2.pigeons.find(x => x.ringNo === ring);
    return { status: 200, body: { transfer: annotateTransfer(result.transfer, p2, today), entryChanges: result.entryChanges, pigeon: buildView(p2, today) } };
  });

  // ---------- 报名 ----------
  add("POST", /^\/api\/pigeons\/(.+)\/entries$/, async ({ ring }, input) => {
    const raceDate = requireDate(input.raceDate, "比赛日");
    const event = requireStr(input.event, "赛事名称");
    const registeredBy = requireStr(input.registeredBy, "报名人");
    const today = todayStr();
    const saved = await store.mutate(db => {
      const p = db.pigeons.find(x => x.ringNo === ring);
      if (!p) throw new HttpError(404, "pigeon_not_found");
      const entry = {
        id: nextId(db, `${ring}-E-`),
        raceDate, event, registeredBy,
        createdAt: nowIso(),
        status: "pending"
      };
      p.entries.push(entry);
      return entry;
    });
    const db2 = await store.load();
    const p2 = db2.pigeons.find(x => x.ringNo === ring);
    const view = recomputeEntries(p2, today).find(e => e.id === saved.id);
    return { status: 201, body: view };
  });

  // ---------- 归巢成绩：已产生名次归旧鸽主 ----------
  add("POST", /^\/api\/pigeons\/(.+)\/races$/, async ({ ring }, input) => {
    const raceDate = requireDate(input.date || todayStr(), "比赛日");
    const event = requireStr(input.event, "赛事");
    const today = todayStr();
    const saved = await store.mutate(db => {
      const p = db.pigeons.find(x => x.ringNo === ring);
      if (!p) throw new HttpError(404, "pigeon_not_found");
      // 落库瞬间把名次归属冻结到该比赛日的权益鸽主，日后转让不改变归属。
      const race = {
        id: nextId(db, `${ring}-R-`),
        date: raceDate, event,
        distance: num(input.distance),
        returnTime: str(input.returnTime),
        rank: num(input.rank),
        attributedOwner: ownerOn(p, raceDate, raceDate)
      };
      p.races.push(race);
      // 对应报名转为 completed，名次归旧鸽主。
      for (const e of p.entries) {
        if (e.raceDate === raceDate && e.event === event && e.status !== "completed") {
          e.status = "completed";
          e.attributedOwner = race.attributedOwner;
        }
      }
      return race;
    });
    return { status: 201, body: saved };
  });

  // ---------- 用药（决定停药期） ----------
  add("POST", /^\/api\/pigeons\/(.+)\/vaccines$/, async ({ ring }, input) => {
    const date = requireDate(input.date || todayStr(), "用药日");
    const name = requireStr(input.name, "药品名称");
    const withdrawalDays = input.withdrawalDays === undefined
      ? DEFAULT_WITHDRAWAL_DAYS
      : Number(input.withdrawalDays);
    if (!Number.isInteger(withdrawalDays) || withdrawalDays < 0) {
      throw new HttpError(400, "invalid_field", "停药天数需为非负整数");
    }
    const saved = await store.mutate(db => {
      const p = db.pigeons.find(x => x.ringNo === ring);
      if (!p) throw new HttpError(404, "pigeon_not_found");
      const vaccine = { date, name, withdrawalDays };
      p.vaccines.push(vaccine);
      return vaccine;
    });
    return { status: 201, body: saved };
  });

  // ---------- 履历（含旧版本留档） ----------
  add("GET", /^\/api\/pigeons\/(.+)\/history$/, async ({ ring }) => {
    const pigeon = await findPigeon(ring);
    return { status: 200, body: { ringNo: ring, items: buildHistory(pigeon, todayStr()) } };
  });

  async function handle(req, url) {
    const path = url.pathname;
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = route.pattern.exec(path);
      if (!m) continue;
      const params = {};
      const groups = m.slice(1).filter(g => g !== undefined);
      params.ring = decodeURIComponent(groups[0] || "");
      if (groups.length >= 2) params.tid = decodeURIComponent(groups[1]);
      const input = ["POST", "PATCH", "DELETE"].includes(req.method) ? await readBody(req) : {};
      return route.handler(params, input, req, url);
    }
    throw new HttpError(404, "not_found");
  }

  return { handle };
}
