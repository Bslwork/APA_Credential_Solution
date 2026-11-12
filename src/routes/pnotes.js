// Personal page for one account, built at the request of the project owner (Damon Hollister, 2026-10-05):
// "Notes For Akhoya Peter" is served only to Peter Williams's account. Everyone else gets an empty
// script from /api/extras.js and the same 404 as any unknown address from /api/pn, so the page is not
// visible in the app for anyone else. The notes are personal, so they are not copied into the audit log.
import { requireSession } from "../auth.js";

const OWNER = "user-munzua45u9e6";   // Peter Williams
const KEY = "pn:" + OWNER;
const js = (body) => new Response(body, { status: 200, headers: { "Content-Type": "application/javascript; charset=utf-8" } });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const notFound = () => json(404, { error: "not found" });
async function owner(req, env) {
  try { const s = await requireSession(req, env); return s && s.uid === OWNER ? s : null; } catch (e) { return null; }
}

export async function handleExtras(req, env) {
  return js((await owner(req, env)) ? UI : "");
}

export async function handlePn(req, env) {
  if (!(await owner(req, env))) return notFound();
  const read = async () => JSON.parse((await env.APA_KV.get(KEY)) || "[]");
  if (req.method === "GET") return json(200, { notes: await read() });
  if (req.method !== "POST") return notFound();
  const b = await req.json().catch(() => ({}));
  const notes = await read(), now = new Date().toISOString();
  const title = String(b.title || "").trim().slice(0, 160), body = String(b.body || "").replace(/\r/g, "").slice(0, 20000);
  const n = notes.find((x) => x.id === b.id);
  if (b.op === "add") {
    if (!title && !body.trim()) return json(400, { error: "Write a header or some text first." });
    notes.push({ id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title, body, pinned: false, at: now, upd: now });
  } else if (b.op === "edit" && n) { n.title = title; n.body = body; n.upd = now; }
  else if (b.op === "pin" && n) { n.pinned = !!b.pinned; }
  else if (b.op === "del" && n) { notes.splice(notes.indexOf(n), 1); }
  else return json(400, { error: "Please refresh the page." });
  await env.APA_KV.put(KEY, JSON.stringify(notes));
  return json(200, { notes });
}

const UI = String.raw`(function(){
if (document.getElementById('tabPN')) return;
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
var bar=document.getElementById('tabTasks').parentElement, anchor=document.getElementById('signoffView');
var tab=document.createElement('button'); tab.className='tab'; tab.id='tabPN'; tab.type='button'; tab.setAttribute('role','tab'); tab.setAttribute('aria-selected','false'); tab.textContent='Notes For Akhoya Peter';
bar.appendChild(tab);
var sec=document.createElement('section'); sec.id='pnView'; sec.hidden=true; anchor.parentElement.insertBefore(sec, anchor);
var HIDE=['#grid','#provView','#trainingView','#auditView','#usersView','#dashView','#hiringView','#tasksView','#signoffView','#insdirView','#metrics','#tilesGrp','#tiles','#tilesHead','#leadPager','#providerPager','.controls','.prog'];
var st=document.createElement('style');
st.textContent=HIDE.map(function(s){return 'body.pn-on '+s;}).join(',')+'{display:none !important}'+
 '#pnView{padding:4px 0 30px}.pn-head{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;margin:6px 0 16px}.pn-head h2{margin:0;font-size:20px}'+
 '.pn-sub{color:var(--muted);font-size:13px;margin-top:4px}.pn-ctl{display:flex;gap:8px;flex-wrap:wrap}.pn-ctl input{background:var(--surface-2);border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:7px 10px;font:inherit;min-width:220px}'+
 '.pn-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;align-items:start}'+
 '.pn-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;box-shadow:var(--shadow)}.pn-card.pin{border-color:var(--accent)}'+
 '.pn-ct{display:flex;gap:8px;align-items:flex-start}.pn-ct b{flex:1;font-size:15.5px;overflow-wrap:anywhere}.pn-body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13.5px;line-height:1.55;color:var(--ink-2);margin-top:8px;max-height:320px;overflow:auto}'+
 '.pn-meta{display:flex;gap:12px;align-items:center;margin-top:10px;font-size:11.5px;color:var(--muted)}.pn-meta span{flex:1}.pn-lnk{background:none;border:0;color:var(--accent);font:inherit;font-size:12px;cursor:pointer;padding:0}'+
 '.pn-pin{background:none;border:0;cursor:pointer;font-size:15px;opacity:.45;padding:0}.pn-card.pin .pn-pin{opacity:1}'+
 '.pn-ed{background:var(--surface);border:1px solid var(--accent);border-radius:var(--r);padding:14px 16px;margin-bottom:14px}'+
 '.pn-ed input,.pn-ed textarea{width:100%;background:var(--surface-2);border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:8px 10px;font:inherit;margin-bottom:8px}'+
 '.pn-ed input{font-weight:700;font-size:15px}.pn-ed textarea{min-height:160px;resize:vertical}.pn-row{display:flex;gap:8px}.pn-msg{color:var(--muted);font-size:12.5px;margin-left:auto;align-self:center}'+
 '.pn-empty{color:var(--muted);text-align:center;padding:36px}';
document.head.appendChild(st);
var notes=[], q='', ed=null, msg='';
function api(body){ return fetch('/api/pn', body ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)} : {}).then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||'Error'); return j; }); }); }
function when(t){ return t ? new Date(t).toLocaleString([], {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'}) : ''; }
function render(){
  var list=notes.filter(function(n){ return !q || (n.title+' '+n.body).toLowerCase().indexOf(q)>=0; })
    .sort(function(a,b){ return (b.pinned?1:0)-(a.pinned?1:0) || String(b.upd).localeCompare(String(a.upd)); });
  var h='<div class="pn-head"><div><h2>Notes For Akhoya Peter</h2><div class="pn-sub">Your private notes · only you can see this page</div></div>'+
    '<div class="pn-ctl"><input id="pnQ" placeholder="Search your notes…" value="'+esc(q)+'"><button class="btn pri" id="pnNew">+ New note</button></div></div>';
  if(ed) h+='<div class="pn-ed"><input id="pnT" maxlength="160" placeholder="Header" value="'+esc(ed.title)+'"><textarea id="pnB" placeholder="Write your note…">'+esc(ed.body)+'</textarea>'+
    '<div class="pn-row"><button class="btn pri" id="pnSave">Save note</button><button class="btn" id="pnCancel">Cancel</button><span class="pn-msg">'+esc(msg)+'</span></div></div>';
  h+= list.length ? '<div class="pn-grid">'+list.map(function(n){
      return '<div class="pn-card'+(n.pinned?' pin':'')+'" data-id="'+n.id+'"><div class="pn-ct"><b>'+esc(n.title||'Untitled')+'</b><button class="pn-pin" data-act="pin" title="'+(n.pinned?'Unpin':'Pin to top')+'">📌</button></div>'+
        (n.body?'<div class="pn-body">'+esc(n.body)+'</div>':'')+'<div class="pn-meta"><span>'+esc(when(n.upd))+'</span><button class="pn-lnk" data-act="edit">Edit</button><button class="pn-lnk" data-act="del">Delete</button></div></div>'; }).join('')+'</div>'
    : '<div class="pn-empty">'+(notes.length?'No notes match your search.':'No notes yet. Click <b>+ New note</b> to add your first one.')+'</div>';
  sec.innerHTML=h;
  if(ed){ var t=document.getElementById(ed.id?'pnB':'pnT'); t.focus(); }
}
function load(){ api().then(function(j){ notes=j.notes||[]; render(); }).catch(function(e){ sec.innerHTML='<div class="pn-empty">'+esc(e.message)+'</div>'; }); }
function save(){
  var t=document.getElementById('pnT').value, b=document.getElementById('pnB').value;
  api(ed.id ? {op:'edit', id:ed.id, title:t, body:b} : {op:'add', title:t, body:b}).then(function(j){ notes=j.notes; ed=null; msg=''; render(); })
    .catch(function(e){ msg=e.message; ed.title=t; ed.body=b; render(); });
}
sec.addEventListener('click',function(e){
  if(e.target.id==='pnNew'){ ed={id:'', title:'', body:''}; msg=''; return render(); }
  if(e.target.id==='pnCancel'){ ed=null; return render(); }
  if(e.target.id==='pnSave') return save();
  var a=e.target.closest('[data-act]'); if(!a) return; var id=a.closest('[data-id]').dataset.id, n=notes.filter(function(x){return x.id===id;})[0]; if(!n) return;
  if(a.dataset.act==='edit'){ ed={id:n.id, title:n.title, body:n.body}; msg=''; render(); window.scrollTo({top:sec.offsetTop-20, behavior:'smooth'}); }
  if(a.dataset.act==='pin') api({op:'pin', id:id, pinned:!n.pinned}).then(function(j){ notes=j.notes; render(); });
  if(a.dataset.act==='del' && confirm('Delete this note? This cannot be undone.')) api({op:'del', id:id}).then(function(j){ notes=j.notes; render(); });
});
sec.addEventListener('keydown',function(e){ if(e.key==='Enter' && (e.ctrlKey||e.metaKey) && ed){ e.preventDefault(); save(); } });
sec.addEventListener('input',function(e){ if(e.target.id!=='pnQ') return; q=e.target.value.trim().toLowerCase(); var pos=e.target.selectionStart; render(); var i=document.getElementById('pnQ'); i.focus(); i.setSelectionRange(pos,pos); });
tab.addEventListener('click',function(){ document.body.classList.add('pn-on'); [].forEach.call(bar.querySelectorAll('[role=tab]'),function(t){ t.setAttribute('aria-selected', t===tab?'true':'false'); }); sec.hidden=false; load(); });
bar.addEventListener('click',function(e){ var t=e.target.closest('[role=tab]'); if(t && t!==tab){ document.body.classList.remove('pn-on'); sec.hidden=true; tab.setAttribute('aria-selected','false'); } }, true);
})();`;
