// 权益判定模块：转让生命周期、生效区间、归属推导与报名资格重算。
// 只做内存计算，不做 IO；持久化见 src/store/repository.js，HTTP 入口见 src/http/router.js。

export const DEFAULT_WITHDRAWAL_DAYS = 7;

export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (code, message) => new DomainError(400, code, message);
const notFound = (code, message) => new DomainError(404, code, message);
const conflict = (code, message) => new DomainError(409, code, message);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function todayStr(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validDate(dateStr) {
  if (!DATE_RE.test(dateStr || "")) return false;
  return !Number.isNaN(new Date(`${dateStr}T00:00:00.000Z`).getTime());
}

export function findPigeon(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) throw notFound("pigeon_not_found", `足环号 ${ringNo} 未登记`);
  return pigeon;
}

function findTransfer(db, transferId) {
  const transfer = db.transfers.find(item => item.id === transferId);
  if (!transfer) throw notFound("transfer_not_found", `转让单 ${transferId} 不存在`);
  return transfer;
}

export function isFullyConfirmed(transfer) {
  return Boolean(transfer.confirmations.from && transfer.confirmations.to);
}

// 生效日 = max(交接日 + 停药期, 双方确认完成日)，双方确认且过停药期才生效
export function computeEffectiveDate(transfer) {
  if (!isFullyConfirmed(transfer)) return null;
  const secondConfirm = [transfer.confirmations.from, transfer.confirmations.to].sort().at(-1).slice(0, 10);
  const withdrawalEnd = addDays(transfer.handoverDate, transfer.withdrawalDays);
  return secondConfirm > withdrawalEnd ? secondConfirm : withdrawalEnd;
}

// 未生效的转让用「交接日 + 停药期」作为预计生效起点参与区间判定
export function projectedStart(transfer) {
  return transfer.effectiveDate || addDays(transfer.handoverDate, transfer.withdrawalDays);
}

export function transferStatus(transfer, today = todayStr()) {
  if (transfer.cancelledAt) return "cancelled";
  if (!isFullyConfirmed(transfer)) return "pending";
  return today < transfer.effectiveDate ? "confirmed" : "effective";
}

function activeTransfers(db, ringNo) {
  return db.transfers
    .filter(item => item.ringNo === ringNo && !item.cancelledAt)
    .sort((a, b) => projectedStart(a).localeCompare(projectedStart(b)) || a.seq - b.seq);
}

// 归属区间：仅双方确认的转让参与切分，按生效日排序；区间形如 [from, to)
export function ownershipIntervals(db, ringNo) {
  const pigeon = findPigeon(db, ringNo);
  const confirmed = activeTransfers(db, ringNo).filter(item => item.effectiveDate);
  const intervals = [];
  let owner = pigeon.owner;
  let from = null;
  for (const transfer of confirmed) {
    intervals.push({ owner, from, to: transfer.effectiveDate, transferId: transfer.id });
    owner = transfer.to;
    from = transfer.effectiveDate;
  }
  intervals.push({ owner, from, to: null, transferId: null });
  return intervals;
}

export function ownerAt(db, ringNo, date) {
  const hit = ownershipIntervals(db, ringNo).find(
    item => (item.from === null || item.from <= date) && (item.to === null || date < item.to)
  );
  return hit.owner;
}

// 链式归属：新转让的原鸽主必须是在案最后一笔转让的受让人（无在案转让则为档案鸽主）
function chainHeadOwner(db, ringNo) {
  const active = activeTransfers(db, ringNo);
  return active.length ? active.at(-1).to : findPigeon(db, ringNo).owner;
}

// 同一羽鸽的生效区间不得重叠：新起点必须晚于所有在案起点，且生效日不得撞车。
// 校验先于落库，抛错即整笔不落库。
export function assertNoOverlap(db, ringNo, candidate) {
  const start = projectedStart(candidate);
  for (const other of activeTransfers(db, ringNo)) {
    if (other.id === candidate.id) continue;
    if (projectedStart(other) >= start) {
      throw conflict(
        "transfer_interval_overlap",
        `生效区间与转让单 ${other.id}（${projectedStart(other)} 起）重叠，整笔未落库`
      );
    }
    if (candidate.effectiveDate && other.effectiveDate === candidate.effectiveDate) {
      throw conflict(
        "transfer_interval_overlap",
        `生效日 ${candidate.effectiveDate} 与转让单 ${other.id} 重叠，整笔未落库`
      );
    }
  }
}

function nextSeq(db, prefix) {
  const seq = db.seq;
  db.seq += 1;
  return { seq, id: `${prefix}-${String(seq).padStart(4, "0")}` };
}

function snapshotOf(transfer) {
  return {
    handoverDate: transfer.handoverDate,
    voucherNo: transfer.voucherNo,
    withdrawalDays: transfer.withdrawalDays,
    effectiveDate: transfer.effectiveDate,
    confirmations: { ...transfer.confirmations }
  };
}

// 按时间顺序重算报名资格：已产生名次的历史不再变动；
// 未完成的报名按比赛日归属判定，报名人不是当日鸽主即冻结，恢复归属即解冻。
export function recalculateEntries(db, ringNo) {
  const entries = db.entries
    .filter(item => item.ringNo === ringNo)
    .sort((a, b) => a.raceDate.localeCompare(b.raceDate) || a.seq - b.seq);
  for (const entry of entries) {
    if (entry.status === "ranked") continue;
    entry.status = entry.entrant === ownerAt(db, ringNo, entry.raceDate) ? "entered" : "frozen";
  }
  return entries;
}

export function createPigeon(db, input) {
  const ringNo = String(input.ringNo || "").trim();
  if (!ringNo) throw badRequest("ring_no_required", "足环号不能为空");
  if (db.pigeons.some(item => item.ringNo === ringNo)) {
    throw conflict("ring_exists", `足环号 ${ringNo} 已登记`);
  }
  const pigeon = {
    ringNo,
    owner: String(input.owner || "").trim(),
    fatherRing: String(input.fatherRing || "").trim(),
    motherRing: String(input.motherRing || "").trim(),
    color: String(input.color || "").trim(),
    loft: String(input.loft || "").trim(),
    vaccines: []
  };
  if (!pigeon.owner) throw badRequest("owner_required", "鸽主不能为空");
  db.pigeons.unshift(pigeon);
  return pigeon;
}

export function pedigree(db, ringNo) {
  const pigeon = findPigeon(db, ringNo);
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon, father, mother, children };
}

export function addVaccine(db, ringNo, input, now = new Date()) {
  const pigeon = findPigeon(db, ringNo);
  const name = String(input.name || "").trim();
  if (!name) throw badRequest("vaccine_name_required", "疫苗名称不能为空");
  const record = { date: validDate(input.date) ? input.date : todayStr(now), name };
  pigeon.vaccines.push(record);
  return record;
}

export function createTransfer(db, ringNo, input, now = new Date()) {
  findPigeon(db, ringNo);
  const to = String(input.to || "").trim();
  if (!to) throw badRequest("transfer_to_required", "受让人不能为空");
  if (!validDate(input.handoverDate)) throw badRequest("handover_date_invalid", "交接日格式应为 YYYY-MM-DD");
  const voucherNo = String(input.voucherNo || "").trim();
  if (!voucherNo) throw badRequest("voucher_no_required", "凭证号不能为空");
  const withdrawalDays = input.withdrawalDays === undefined ? DEFAULT_WITHDRAWAL_DAYS : Number(input.withdrawalDays);
  if (!Number.isInteger(withdrawalDays) || withdrawalDays < 0 || withdrawalDays > 365) {
    throw badRequest("withdrawal_days_invalid", "停药期应为 0-365 的整数天数");
  }
  const from = chainHeadOwner(db, ringNo);
  if (to === from) throw badRequest("transfer_to_same_owner", "受让人与当前归属人相同");
  if (db.transfers.some(item => item.ringNo === ringNo && !item.cancelledAt && item.voucherNo === voucherNo)) {
    throw conflict("voucher_no_exists", `凭证号 ${voucherNo} 在该鸽名下已存在`);
  }
  const draft = {
    id: null, ringNo, from, to,
    handoverDate: input.handoverDate, voucherNo, withdrawalDays,
    effectiveDate: null, cancelledAt: null
  };
  assertNoOverlap(db, ringNo, draft);
  const { seq, id } = nextSeq(db, "T");
  const transfer = {
    ...draft, id,
    confirmations: { from: null, to: null },
    revisions: [],
    createdAt: now.toISOString(),
    seq
  };
  db.transfers.push(transfer);
  recalculateEntries(db, ringNo);
  return transfer;
}

export function confirmTransfer(db, transferId, role, now = new Date()) {
  const transfer = findTransfer(db, transferId);
  if (transfer.cancelledAt) throw conflict("transfer_cancelled", "转让单已撤销，不能确认");
  if (role !== "from" && role !== "to") {
    throw badRequest("confirm_role_invalid", "确认方必须是 from（原鸽主）或 to（受让人）");
  }
  if (transfer.confirmations[role]) return transfer; // 重复确认幂等
  const confirmations = { ...transfer.confirmations, [role]: now.toISOString() };
  let effectiveDate = null;
  if (confirmations.from && confirmations.to) {
    effectiveDate = computeEffectiveDate({ ...transfer, confirmations });
    for (const other of activeTransfers(db, transfer.ringNo)) {
      if (other.id !== transfer.id && other.effectiveDate === effectiveDate) {
        throw conflict("transfer_interval_overlap", `生效日 ${effectiveDate} 与转让单 ${other.id} 重叠，整笔未落库`);
      }
    }
  }
  transfer.confirmations = confirmations;
  transfer.effectiveDate = effectiveDate;
  recalculateEntries(db, transfer.ringNo);
  return transfer;
}

// 更正交接日/凭证号/停药期：旧版本留档后按时间顺序重算后续报名资格
export function correctTransfer(db, transferId, patch = {}, now = new Date()) {
  const transfer = findTransfer(db, transferId);
  if (transfer.cancelledAt) throw conflict("transfer_cancelled", "转让单已撤销，不能更正");
  const next = { ...transfer, confirmations: { ...transfer.confirmations } };
  let touched = false;
  if (patch.handoverDate !== undefined) {
    if (!validDate(patch.handoverDate)) throw badRequest("handover_date_invalid", "交接日格式应为 YYYY-MM-DD");
    next.handoverDate = patch.handoverDate;
    touched = true;
  }
  if (patch.voucherNo !== undefined) {
    const voucherNo = String(patch.voucherNo || "").trim();
    if (!voucherNo) throw badRequest("voucher_no_required", "凭证号不能为空");
    const duplicated = db.transfers.some(item =>
      item.ringNo === transfer.ringNo && !item.cancelledAt && item.id !== transfer.id && item.voucherNo === voucherNo
    );
    if (duplicated) throw conflict("voucher_no_exists", `凭证号 ${voucherNo} 在该鸽名下已存在`);
    next.voucherNo = voucherNo;
    touched = true;
  }
  if (patch.withdrawalDays !== undefined) {
    const days = Number(patch.withdrawalDays);
    if (!Number.isInteger(days) || days < 0 || days > 365) {
      throw badRequest("withdrawal_days_invalid", "停药期应为 0-365 的整数天数");
    }
    next.withdrawalDays = days;
    touched = true;
  }
  if (!touched) throw badRequest("nothing_to_correct", "没有需要更正的字段");
  next.effectiveDate = computeEffectiveDate(next);
  assertNoOverlap(db, transfer.ringNo, next);
  transfer.revisions.push({
    changedAt: now.toISOString(),
    reason: String(patch.reason || "更正交接日"),
    snapshot: snapshotOf(transfer)
  });
  transfer.handoverDate = next.handoverDate;
  transfer.voucherNo = next.voucherNo;
  transfer.withdrawalDays = next.withdrawalDays;
  transfer.effectiveDate = next.effectiveDate;
  recalculateEntries(db, transfer.ringNo);
  return transfer;
}

// 撤销转让：留档后该单不再参与归属切分，后续报名资格按时间顺序重算
export function cancelTransfer(db, transferId, now = new Date()) {
  const transfer = findTransfer(db, transferId);
  if (transfer.cancelledAt) throw conflict("transfer_cancelled", "转让单已撤销");
  transfer.revisions.push({
    changedAt: now.toISOString(),
    reason: "撤销转让",
    snapshot: snapshotOf(transfer)
  });
  transfer.cancelledAt = now.toISOString();
  recalculateEntries(db, transfer.ringNo);
  return transfer;
}

export function createEntry(db, ringNo, input, now = new Date()) {
  findPigeon(db, ringNo);
  const event = String(input.event || "").trim();
  if (!event) throw badRequest("event_required", "赛事名称不能为空");
  if (input.raceDate !== undefined && !validDate(input.raceDate)) {
    throw badRequest("race_date_invalid", "比赛日格式应为 YYYY-MM-DD");
  }
  const raceDate = input.raceDate || todayStr(now);
  const { seq, id } = nextSeq(db, "E");
  const entry = {
    id, ringNo, event,
    distance: Number(input.distance || 0),
    raceDate,
    entrant: ownerAt(db, ringNo, todayStr(now)),
    status: "entered",
    rank: null,
    returnTime: "",
    rankOwner: null,
    rankedAt: null,
    createdAt: now.toISOString(),
    seq
  };
  // 报名资格按比赛日归属判定：转让生效后旧鸽主的未完成报名即冻结
  entry.status = entry.entrant === ownerAt(db, ringNo, raceDate) ? "entered" : "frozen";
  db.entries.push(entry);
  return entry;
}

export function recordResult(db, entryId, input, now = new Date()) {
  const entry = db.entries.find(item => item.id === entryId);
  if (!entry) throw notFound("entry_not_found", `报名记录 ${entryId} 不存在`);
  if (entry.status === "frozen") throw conflict("entry_frozen", "报名已冻结（归属变更），不能录入名次");
  if (entry.status === "ranked") throw conflict("entry_already_ranked", "名次已录入，不能重复登记");
  const rank = Number(input.rank);
  if (!Number.isInteger(rank) || rank < 1) throw badRequest("rank_invalid", "名次应为正整数");
  entry.rank = rank;
  entry.returnTime = String(input.returnTime || "");
  entry.status = "ranked";
  entry.rankOwner = entry.entrant; // 名次归报名时的鸽主，后续转让不影响已产生名次
  entry.rankedAt = now.toISOString();
  return entry;
}

// 权益台履历：归属区间 + 转让单（含留档版本）+ 报名记录，列表与履历同源
export function ledger(db, ringNo, now = new Date()) {
  const today = todayStr(now);
  const pigeon = findPigeon(db, ringNo);
  const transfers = db.transfers
    .filter(item => item.ringNo === ringNo)
    .sort((a, b) => projectedStart(a).localeCompare(projectedStart(b)) || a.seq - b.seq)
    .map(item => ({ ...item, status: transferStatus(item, today), projectedStart: projectedStart(item) }));
  const entries = db.entries
    .filter(item => item.ringNo === ringNo)
    .sort((a, b) => a.raceDate.localeCompare(b.raceDate) || a.seq - b.seq);
  return {
    pigeon,
    today,
    currentOwner: ownerAt(db, ringNo, today),
    intervals: ownershipIntervals(db, ringNo),
    transfers,
    entries
  };
}

export function summarize(db, now = new Date()) {
  const today = todayStr(now);
  return db.pigeons.map(pigeon => {
    const active = db.transfers.filter(item => item.ringNo === pigeon.ringNo && !item.cancelledAt);
    const entries = db.entries.filter(item => item.ringNo === pigeon.ringNo);
    return {
      ...pigeon,
      currentOwner: ownerAt(db, pigeon.ringNo, today),
      pendingTransfers: active
        .filter(item => transferStatus(item, today) !== "effective")
        .map(item => ({ id: item.id, to: item.to, status: transferStatus(item, today), effectiveDate: item.effectiveDate })),
      entryStats: {
        entered: entries.filter(item => item.status === "entered").length,
        frozen: entries.filter(item => item.status === "frozen").length,
        ranked: entries.filter(item => item.status === "ranked").length
      }
    };
  });
}
