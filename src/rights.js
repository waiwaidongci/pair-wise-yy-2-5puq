// 模块二：权益判定（纯逻辑，不做 IO）
// 生效规则：双方确认 + 过停药期 + 到达交接日，三者满足之日起生效；
// 已产生名次永远归旧鸽主；未完成报名随当前归属重算资格。

export const DEFAULT_WITHDRAWAL_DAYS = 21;
export const TRANSFER_REASONS = {
  pending_confirm: "待双方确认",
  withdrawal_hold: "停药期未满",
  scheduled: "交接日未到",
  effective: "已生效",
  revoked: "已撤销"
};

export function todayStr(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
function asDate(s) { return new Date(`${s}T00:00:00.000Z`); }
export function addDays(s, n) {
  const d = asDate(s);
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}

// 最近一次用药的停药解除日：以各针次 date + withdrawalDays 的最大值为准。
export function withdrawalClearDate(pigeon, today = todayStr()) {
  let clear = "";
  for (const v of pigeon.vaccines || []) {
    const days = v.withdrawalDays === undefined ? DEFAULT_WITHDRAWAL_DAYS : Number(v.withdrawalDays);
    const end = addDays(v.date, days);
    if (end > clear) clear = end;
  }
  return clear || "";
}

function confirmedDatePart(transfer) {
  return (transfer.confirmedAt || "").slice(0, 10);
}

// 生效日 = max(交接日, 停药解除日, 双方确认完成日)
export function effectiveDate(transfer, pigeon) {
  if (transfer.revoked) return null;
  if (!transfer.fromConfirmed || !transfer.toConfirmed) return null;
  const clear = withdrawalClearDate(pigeon);
  const confirmed = confirmedDatePart(transfer);
  let d = transfer.date;
  for (const candidate of [clear, confirmed]) {
    if (candidate && candidate > d) d = candidate;
  }
  return d;
}

// 单条转让的当前状态
export function annotateTransfer(transfer, pigeon, today = todayStr()) {
  if (transfer.revoked) {
    return { ...transfer, status: "revoked", reason: "revoked", effectiveDate: null };
  }
  if (!transfer.fromConfirmed || !transfer.toConfirmed) {
    return { ...transfer, status: "pending", reason: "pending_confirm", effectiveDate: null };
  }
  const eff = effectiveDate(transfer, pigeon);
  if (eff > today) {
    // 今天仍卡在停药期（解除日晚于今天）优先提示停药，否则只是交接日未到。
    const clear = withdrawalClearDate(pigeon);
    const reason = clear > today ? "withdrawal_hold" : "scheduled";
    return { ...transfer, status: "waiting", reason, effectiveDate: eff };
  }
  return { ...transfer, status: "effective", reason: "effective", effectiveDate: eff };
}

export function activeTransfers(pigeon, today = todayStr()) {
  return (pigeon.transfers || [])
    .filter(t => !t.revoked)
    .map(t => annotateTransfer(t, pigeon, today));
}

// 生效区间重叠判定：同一羽鸽、同为未撤销记录，交接日相同即冲突。
// 创建与更正入口共用；冲突时调用方返回 409，整笔不落库。
export function hasDateOverlap(pigeon, handoverDate, excludeId = null) {
  return (pigeon.transfers || []).some(t =>
    !t.revoked && t.id !== excludeId && t.date === handoverDate
  );
}

// 指定日期（含）的权益鸽主：取生效日不晚于该日的最近一条转让的受让方。
// asOf 决定“未来交接/停药期未满”是否已成熟；报名与录赛绩按各自发生日判定。
export function ownerOn(pigeon, date, asOf = todayStr()) {
  const effs = (pigeon.transfers || [])
    .filter(t => !t.revoked && t.fromConfirmed && t.toConfirmed)
    .map(t => ({ t, eff: effectiveDate(t, pigeon) }))
    .filter(x => x.eff !== null && x.eff <= date && x.eff <= asOf)
    .sort((a, b) =>
      a.eff < b.eff ? 1
      : a.eff > b.eff ? -1
      : (b.t.createdAt || "").localeCompare(a.t.createdAt || "")
    );
  return effs.length ? effs[0].t.to : (pigeon.initialOwner || pigeon.owner || "");
}

export function currentOwner(pigeon, today = todayStr()) {
  return ownerOn(pigeon, today, today);
}

function raceKey(race) {
  return `${race.date}|${race.event}`;
}

// 报名资格重算（按时间顺序）：
// 已完赛 -> completed，名次归属冻结在旧鸽主；
// 未完赛 -> 报名人与该比赛日权益鸽主一致才 qualified，否则 frozen。
export function recomputeEntries(pigeon, today = todayStr()) {
  const raced = new Set((pigeon.races || []).map(raceKey));
  const entries = (pigeon.entries || []).map(e => {
    if (raced.has(`${e.raceDate}|${e.event}`) || e.status === "completed") {
      return { ...e, status: "completed", attributedOwner: e.attributedOwner || e.registeredBy };
    }
    const owner = ownerOn(pigeon, e.raceDate, e.raceDate);
    const status = e.registeredBy === owner ? "qualified" : "frozen";
    return { ...e, status, ownerOnRaceDate: owner };
  });
  return entries.sort((a, b) =>
    a.raceDate < b.raceDate ? -1 : a.raceDate > b.raceDate ? 1
    : (a.createdAt || "").localeCompare(b.createdAt || "")
  );
}

// 列表、详情、履历共用的唯一序列化口径，保证刷新后一致。
export function buildView(pigeon, today = todayStr()) {
  const transfers = activeTransfers(pigeon, today)
    .sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1
      : (b.createdAt || "").localeCompare(a.createdAt || "")
    );
  const revoked = (pigeon.transfers || []).filter(t => t.revoked).length;
  const races = (pigeon.races || []).map(r => ({
    ...r,
    // 已产生名次归旧鸽主：归属以赛绩落库时认定的鸽主为准，不随后续转让变。
    attributedOwner: r.attributedOwner || currentOwner(pigeon, r.date)
  })).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return {
    ringNo: pigeon.ringNo,
    initialOwner: pigeon.initialOwner || pigeon.owner || "",
    owner: currentOwner(pigeon, today),
    fatherRing: pigeon.fatherRing || "",
    motherRing: pigeon.motherRing || "",
    color: pigeon.color,
    loft: pigeon.loft,
    withdrawalClear: withdrawalClearDate(pigeon, today),
    vaccines: pigeon.vaccines || [],
    transfers,
    revokedTransferCount: revoked,
    entries: recomputeEntries(pigeon, today),
    races
  };
}

// 履历：按时间顺序合并转让（含旧版本留档）、报名、成绩、用药。
export function buildHistory(pigeon, today = todayStr()) {
  const items = [];
  for (const t of pigeon.transfers || []) {
    const state = annotateTransfer(t, pigeon, today);
    items.push({
      date: t.date,
      kind: "transfer",
      title: `转让 ${t.from} → ${t.to}`,
      voucherNo: t.voucherNo,
      status: state.status,
      reasonText: TRANSFER_REASONS[state.reason] || state.reason,
      effectiveDate: state.effectiveDate,
      id: t.id
    });
    for (const rev of t.revisions || []) {
      items.push({
        date: rev.at.slice(0, 10),
        at: rev.at,
        kind: "revision",
        title: rev.action === "revoke"
          ? `撤销转让 ${t.from} → ${t.to}`
          : `交接日更正 ${rev.before.date} → ${rev.after.date}`,
        voucherNo: t.voucherNo,
        transferId: t.id,
        snapshot: rev.before,
        entryChanges: rev.entryChanges || [],
        operator: rev.by || ""
      });
    }
  }
  for (const e of pigeon.entries || []) {
    const [view] = recomputeEntries(pigeon, today).filter(x => x.id === e.id);
    items.push({
      date: e.raceDate,
      kind: "entry",
      title: `报名 ${e.event}（${e.registeredBy}）`,
      status: view ? view.status : e.status,
      id: e.id
    });
  }
  for (const r of pigeon.races || []) {
    items.push({
      date: r.date,
      kind: "race",
      title: `${r.event} 第${r.rank}名，归${r.attributedOwner || ""}`,
      id: r.id
    });
  }
  for (const v of pigeon.vaccines || []) {
    items.push({
      date: v.date,
      kind: "vaccine",
      title: `用药 ${v.name}，停药期${v.withdrawalDays === undefined ? DEFAULT_WITHDRAWAL_DAYS : v.withdrawalDays}天`
    });
  }
  return items.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1
    : (a.at || "").localeCompare(b.at || "")
  );
}
