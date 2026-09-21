export const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>赛鸽转让生效与权益台</title>
<style>
:root{--bg:#eef1f5;--panel:#fff;--ink:#1f2833;--muted:#68768a;--line:#d3dce4;--accent:#2f5d7f;--green:#2e7d4f;--amber:#a9761f;--red:#9b3f35;--violet:#5c4a86;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Arial,"PingFang SC",sans-serif}
header{padding:20px 26px;background:#fff;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:16px}
h1{margin:0;font-size:24px}h2{margin:0 0 10px;font-size:17px}h3{margin:0;font-size:16px}
main{display:grid;grid-template-columns:400px 1fr;gap:20px;padding:20px 26px}
form,.panel,.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:15px}
label{display:block;margin:9px 0 4px;color:var(--muted);font-size:12px}
input,select{width:100%;border:1px solid var(--line);border-radius:6px;padding:8px;font:inherit}
button{border:0;border-radius:6px;background:var(--accent);color:#fff;padding:8px 11px;font-weight:700;cursor:pointer;font-size:13px}
button.ghost{background:#eef2f6;color:var(--accent)}button.danger{background:var(--red)}button.warn{background:var(--amber)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.toolbar{display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}
.card{display:grid;gap:7px;align-content:start}.meta{color:var(--muted);font-size:12px}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:12px;margin:2px 4px 2px 0}
.pill.effective{background:#e7f4ec;border-color:#bcdcc8;color:var(--green)}
.pill.pending,.pill.waiting{background:#fbf3df;border-color:#e6d2a0;color:var(--amber)}
.pill.revoked,.pill.frozen{background:#f7e8e6;border-color:#dfb6b0;color:var(--red)}
.pill.qualified,.pill.completed{background:#e7f0f6;border-color:#b3cddd;color:var(--accent)}
.tline{border-left:2px solid var(--line);margin-left:6px;padding-left:14px;display:grid;gap:8px}
.titem{position:relative}.titem:before{content:"";position:absolute;left:-20px;top:4px;width:8px;height:8px;border-radius:50%;background:var(--accent)}
.titem.revision:before{background:var(--violet)}.titem.race:before{background:var(--green)}.titem.entry:before{background:var(--amber)}
.titem.vaccine:before{background:#8a94a3}
.actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}.err{color:var(--red);font-size:13px;margin:8px 0}
.section{margin-top:13px}
@media(max-width:960px){header{display:block;padding:16px}main{grid-template-columns:1fr;padding:14px}.row,.row3{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><div><h1>赛鸽转让生效与权益台</h1><div class="meta">登记原鸽主 · 受让人 · 交接日 · 凭证号 ｜ 双方确认且过停药期才生效</div></div><button id="reload">刷新</button></header>
<main>
<form id="form">
  <h2>创建鸽只档案</h2>
  <label>足环号</label><input name="ringNo" required>
  <label>鸽主</label><input name="owner" required>
  <div class="row"><div><label>父鸽足环号</label><input name="fatherRing"></div><div><label>母鸽足环号</label><input name="motherRing"></div></div>
  <div class="row"><div><label>羽色</label><input name="color" required></div><div><label>出生棚号</label><input name="loft" required></div></div>
  <button>保存档案</button>
</form>
<section>
  <div id="error" class="err" style="display:none"></div>
  <div class="toolbar"><input id="search" placeholder="输入足环号查询"><div><button id="searchBtn">查询档案</button> <button class="ghost" id="historyBtn">查履历</button></div></div>
  <div class="panel" id="detail" style="margin-bottom:14px"></div>
  <div class="grid" id="cards"></div>
</section>
</main>
<script>
const $ = s => document.querySelector(s);
const cards = $("#cards"), detail = $("#detail"), search = $("#search"), errorBox = $("#error");
let pigeons = [];
function showError(e){ errorBox.textContent = e.message || e; errorBox.style.display="block"; setTimeout(()=>errorBox.style.display="none",5000); }
async function api(path, options){
  const opt = options && options.body ? {...options,headers:{"Content-Type":"application/json"}} : options;
  const res = await fetch(path,opt); const data = await res.json();
  if(!res.ok) throw Object.assign(new Error(data.message||data.error||"请求失败"),{code:data.error});
  return data;
}
const reasonText={pending_confirm:"待双方确认",withdrawal_hold:"停药期未满",scheduled:"交接日未到",effective:"已生效",revoked:"已撤销"};
const entryText={qualified:"报名有效",frozen:"旧鸽主冻结",completed:"已完赛",pending:"待定"};
function esc(s){const m={"&":"&amp;","<":"&lt;",">":"&gt;"};return String(s??"").replace(/[&<>"]/g,c=>c==='"'?"&quot;":m[c]);}
function transferPill(t){return '<span class="pill '+t.status+'">'+esc(t.from)+' → '+esc(t.to)+'｜'+t.date+'｜'+reasonText[t.reason]+(t.effectiveDate?'（生效 '+t.effectiveDate+'）':'')+'</span>';}
function entryPill(e){return '<span class="pill '+e.status+'">'+esc(e.event)+' '+e.raceDate+'｜'+esc(e.registeredBy)+'：'+entryText[e.status]+'</span>';}

function renderCards(){
  cards.innerHTML = pigeons.map(p => \`
  <article class="card" data-ring="\${esc(p.ringNo)}">
    <h3>\${esc(p.ringNo)} <span class="pill effective">现鸽主：\${esc(p.owner)}</span></h3>
    <div class="meta">\${esc(p.color)} · \${esc(p.loft)} ｜ 初主：\${esc(p.initialOwner)} ｜ 停药解除：\${p.withdrawalClear||"无用药"}</div>
    <div><b>转让</b><br>\${p.transfers.length?p.transfers.map(transferPill).join(""):'<span class="meta">暂无</span>'}\${p.revokedTransferCount?\`<span class="pill revoked">已撤销 \${p.revokedTransferCount}</span>\`:""}</div>
    <div><b>报名</b><br>\${p.entries.length?p.entries.map(entryPill).join(""):'<span class="meta">暂无</span>'}</div>
    <div><b>成绩</b><br>\${p.races.length?p.races.map(r=>\`<span class="pill completed">\${r.date} \${esc(r.event)} 第\${r.rank}名（归\${esc(r.attributedOwner)}）</span>\`).join(""):'<span class="meta">暂无</span>'}</div>
    <div class="row"><input data-tto="\${esc(p.ringNo)}" placeholder="受让人"></div>
    <div class="row3"><input data-tdate="\${esc(p.ringNo)}" type="date"><input data-tvoucher="\${esc(p.ringNo)}" placeholder="凭证号"></div>
    <div class="actions"><button data-newtransfer="\${esc(p.ringNo)}">登记转让</button><button class="ghost" data-history="\${esc(p.ringNo)}">履历</button></div>
    <div class="row"><input data-event="\${esc(p.ringNo)}" placeholder="赛事名"></div>
    <div class="row3"><input data-rdate="\${esc(p.ringNo)}" type="date"><input data-rby="\${esc(p.ringNo)}" placeholder="报名人"></div>
    <div class="actions"><button class="ghost" data-entry="\${esc(p.ringNo)}">提交报名</button></div>
    <div class="row3"><input data-rank="\${esc(p.ringNo)}" placeholder="名次" type="number"><input data-distance="\${esc(p.ringNo)}" placeholder="公里" type="number"></div>
    <div class="actions"><button class="ghost" data-score="\${esc(p.ringNo)}">录成绩</button></div>
    <div class="row3"><input data-vdate="\${esc(p.ringNo)}" type="date"><input data-vname="\${esc(p.ringNo)}" placeholder="药品/疫苗"><input data-vdays="\${esc(p.ringNo)}" type="number" placeholder="停药天" value="21"></div>
    <div class="actions"><button class="ghost" data-vaccine="\${esc(p.ringNo)}">录用药</button></div>
    \${p.transfers.filter(t=>t.status!=="revoked").map(t=>\`
      <div class="small"><b>\${esc(t.voucherNo)}</b> <span class="meta">\${t.date}</span>
      <div class="actions">
        \${!t.fromConfirmed?'<button data-confirm="'+p.ringNo+'" data-tid="'+t.id+'" data-side="from">旧鸽主确认</button>':""}
        \${!t.toConfirmed?'<button data-confirm="'+p.ringNo+'" data-tid="'+t.id+'" data-side="to">受让人确认</button>':""}
        <input data-fix="\${esc(p.ringNo)}" data-tid="\${t.id}" type="date"><button class="warn" data-fixbtn="\${esc(p.ringNo)}" data-tid="\${t.id}">更正交接日</button>
        <button class="danger" data-revoke="\${esc(p.ringNo)}" data-tid="\${t.id}">撤销</button>
      </div></div>\`).join("")}
  </article>\`).join("");

  const ringOf = el => el.dataset.newtransfer||el.dataset.history||el.dataset.entry||el.dataset.score||el.dataset.vaccine||el.dataset.confirm?.split&&el.closest(".card").dataset.ring;
  document.querySelectorAll("[data-newtransfer]").forEach(btn=>btn.onclick=async()=>{
    const ring=btn.dataset.newtransfer;
    try{
      await api('/api/pigeons/'+encodeURIComponent(ring)+'/transfers',{method:'POST',body:JSON.stringify({
        to:$('[data-tto="'+ring+'"]').value, date:$('[data-tdate="'+ring+'"]').value||undefined,
        voucherNo:$('[data-tvoucher="'+ring+'"]').value
      })}); await load();
    }catch(e){showError(e);}
  });
  document.querySelectorAll("[data-entry]").forEach(btn=>btn.onclick=async()=>{
    const ring=btn.dataset.entry;
    try{
      await api('/api/pigeons/'+encodeURIComponent(ring)+'/entries',{method:'POST',body:JSON.stringify({
        event:$('[data-event="'+ring+'"]').value, raceDate:$('[data-rdate="'+ring+'"]').value,
        registeredBy:$('[data-rby="'+ring+'"]').value
      })}); await load();
    }catch(e){showError(e);}
  });
  document.querySelectorAll("[data-score]").forEach(btn=>btn.onclick=async()=>{
    const ring=btn.dataset.score;
    try{
      await api('/api/pigeons/'+encodeURIComponent(ring)+'/races',{method:'POST',body:JSON.stringify({
        event:$('[data-event="'+ring+'"]').value||"未命名赛事", date:$('[data-rdate="'+ring+'"]').value||undefined,
        rank:$('[data-rank="'+ring+'"]').value, distance:$('[data-distance="'+ring+'"]').value
      })}); await load();
    }catch(e){showError(e);}
  });
  document.querySelectorAll("[data-vaccine]").forEach(btn=>btn.onclick=async()=>{
    const ring=btn.dataset.vaccine;
    try{
      await api('/api/pigeons/'+encodeURIComponent(ring)+'/vaccines',{method:'POST',body:JSON.stringify({
        name:$('[data-vname="'+ring+'"]').value, date:$('[data-vdate="'+ring+'"]').value||undefined,
        withdrawalDays:$('[data-vdays="'+ring+'"]').value
      })}); await load();
    }catch(e){showError(e);}
  });
  document.querySelectorAll("[data-confirm]").forEach(btn=>btn.onclick=async()=>{
    const ring=btn.closest(".card").dataset.ring;
    try{ await api('/api/pigeons/'+encodeURIComponent(ring)+'/transfers/'+encodeURIComponent(btn.dataset.tid)+'/confirm',{method:'POST',body:JSON.stringify({side:btn.dataset.side})}); await load(); }catch(e){showError(e);}
  });
  document.querySelectorAll("[data-revoke]").forEach(btn=>btn.onclick=async()=>{
    const ring=btn.closest(".card").dataset.ring;
    if(!confirm("撤销后旧版本留档并按时间顺序重算报名资格，确认？"))return;
    try{ const r=await api('/api/pigeons/'+encodeURIComponent(ring)+'/transfers/'+encodeURIComponent(btn.dataset.tid),{method:'DELETE',body:'{}'}); reportChanges(r.entryChanges); await load(); }catch(e){showError(e);}
  });
  document.querySelectorAll("[data-fixbtn]").forEach(btn=>btn.onclick=async()=>{
    const ring=btn.closest(".card").dataset.ring;
    const v=$('[data-fix="'+ring+'"][data-tid="'+btn.dataset.tid+'"]').value;
    try{ const r=await api('/api/pigeons/'+encodeURIComponent(ring)+'/transfers/'+encodeURIComponent(btn.dataset.tid),{method:'PATCH',body:JSON.stringify({date:v})}); reportChanges(r.entryChanges); await load(); }catch(e){showError(e);}
  });
  document.querySelectorAll("[data-history]").forEach(btn=>btn.onclick=()=>showHistory(btn.dataset.history));
}
function reportChanges(changes){ if(changes&&changes.length) alert("报名资格重算："+changes.map(c=>c.event+" "+c.from+"→"+c.to).join("；")); }

function renderRelation(data){
  if(!data){detail.innerHTML='<h2>档案与权益</h2><p class="meta">输入足环号查询血统、生效区间与报名资格；点卡片“履历”查看旧版本留档。</p>';return;}
  const p=data.pigeon;
  detail.innerHTML='<h2>'+esc(p.ringNo)+' 权益档案</h2>'+
  '<div class="row3"><div class="small">父鸽：'+esc(data.father?.ringNo||p.fatherRing||"未登记")+'</div><div class="small">本鸽：'+esc(p.owner)+'（初主 '+esc(p.initialOwner)+'）</div><div class="small">母鸽：'+esc(data.mother?.ringNo||p.motherRing||"未登记")+'</div></div>'+
  '<div class="meta" style="margin-top:6px">羽色 '+esc(p.color)+' · '+esc(p.loft)+' · 停药解除日 '+(p.withdrawalClear||"无")+'</div>'+
  '<div class="section"><b>子代</b> '+esc((data.children||[]).map(c=>c.ringNo).join("、")||"暂无")+'</div>'+
  '<div class="section"><b>生效区间</b><br>'+(p.transfers.length?p.transfers.map(transferPill).join(""):'<span class="meta">暂无转让</span>')+'</div>'+
  '<div class="section"><b>报名资格</b><br>'+(p.entries.length?p.entries.map(entryPill).join(""):'<span class="meta">暂无报名</span>')+'</div>'+
  '<div class="section"><b>名次归属（归旧鸽主）</b><br>'+(p.races.length?p.races.map(r=>esc(r.date+" "+r.event+" 第"+r.rank+"名 → "+r.attributedOwner)).join("<br>"):'<span class="meta">暂无成绩</span>')+'</div>';
}
async function showHistory(ring){
  try{
    const h=await api('/api/pigeons/'+encodeURIComponent(ring)+'/history');
    detail.innerHTML='<h2>'+esc(ring)+' 履历（按时间顺序）</h2><div class="tline">'+h.items.map(i=>
      '<div class="titem '+i.kind+'"><b>'+i.date+'</b> '+esc(i.title)+
      (i.voucherNo?' <span class="meta">凭证 '+esc(i.voucherNo)+'</span>':'')+
      (i.snapshot?' <span class="pill revoked">旧版留档：'+esc(i.snapshot.date)+' '+esc(i.snapshot.from)+'→'+esc(i.snapshot.to)+'</span>':'')+
      (i.entryChanges&&i.entryChanges.length?' <span class="pill frozen">重算 '+i.entryChanges.map(c=>esc(c.event)+" "+c.from+"→"+c.to).join("，")+'</span>':'')+
      '</div>').join("")+'</div>';
  }catch(e){showError(e);}
}
async function load(){
  pigeons=await api("/api/pigeons"); renderCards();
  const q=search.value.trim();
  if(q){try{renderRelation(await api('/api/pigeons/'+encodeURIComponent(q)+'/relation'));}catch(e){renderRelation(null);showError(e);}}
  else renderRelation(null);
}
$("#searchBtn").onclick=async()=>{try{renderRelation(await api('/api/pigeons/'+encodeURIComponent(search.value.trim())+'/relation'));}catch(e){showError(e);}};
$("#historyBtn").onclick=()=>showHistory(search.value.trim());
$("#reload").onclick=load;
$("#form").onsubmit=async ev=>{ev.preventDefault();try{await api("/api/pigeons",{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData($("#form")).entries()))});$("#form").reset();await load();}catch(e){showError(e);}};
load();
</script>
</body>
</html>`;
