// Thin wrapper around Workers KV -- the only "backend" this app has, mirroring
// the interface of the old api/shared/blobClient.js (Azure Blob Storage)
// almost exactly, so the route logic ported from Azure Functions barely
// changes. Every JSON entity (leads / providers / notifications / audit /
// accepted-insurances / training / users) is one KV key holding the whole
// array as its value. No database, no ORM.

const ALLOWED_ENTITIES = new Set([
  "leads", "providers", "notifications", "audit", "accepted-insurances", "training", "users", "hiring", "tasks", "insdir",
]);

function assertEntity(entity) {
  if (!ALLOWED_ENTITIES.has(entity)) {
    const err = new Error("Unknown data entity: " + entity);
    err.status = 400;
    throw err;
  }
}

async function readJson(env, entity) {
  assertEntity(entity);
  const raw = await env.APA_KV.get(entity);
  return raw ? JSON.parse(raw) : [];
}

async function writeJson(env, entity, data) {
  assertEntity(entity);
  await env.APA_KV.put(entity, JSON.stringify(data));
}

// "leads" is split into two KV keys instead of one, since almost every save
// is a note/status/attachment/insurance edit -- not a name/contact-info
// change -- and rewriting the whole ~900KB record set for a one-line note
// was the actual cause of slow saves. Rarely-edited fields stay in
// "leads_static"; frequently-edited fields live in the much smaller
// "leads_dynamic", which is the only thing a normal edit rewrites.
const LEADS_DYNAMIC_FIELDS = new Set([
  "st", "sd", "sa", "sh", "grp", "attachments", "notesLog", "insurance", "deleted",
]);

function splitLeadRecord(record) {
  const dynamic = { i: record.i };
  const staticPart = { i: record.i };
  for (const k of Object.keys(record)) {
    if (k === "i") continue;
    if (LEADS_DYNAMIC_FIELDS.has(k)) dynamic[k] = record[k];
    else staticPart[k] = record[k];
  }
  return { staticPart, dynamic };
}

function mergeLeads(staticList, dynamicList) {
  const dynByI = new Map(dynamicList.map((d) => [String(d.i), d]));
  return staticList.map((s) => Object.assign({}, s, dynByI.get(String(s.i)) || {}));
}

// Raw blobs for GET /api/data/leads: passed straight through (the browser
// merges them), so the Worker never parses/re-serialises ~1.5 MB of JSON --
// keeps the read comfortably inside the free plan's per-request CPU budget.
async function readLeadsRaw(env) {
  return Promise.all([env.APA_KV.get("leads_static"), env.APA_KV.get("leads_dynamic")]);
}

async function readLeads(env) {
  const [staticRaw, dynamicRaw] = await Promise.all([
    env.APA_KV.get("leads_static"),
    env.APA_KV.get("leads_dynamic"),
  ]);
  const staticList = staticRaw ? JSON.parse(staticRaw) : [];
  const dynamicList = dynamicRaw ? JSON.parse(dynamicRaw) : [];
  return mergeLeads(staticList, dynamicList);
}

// Full rewrite of both blobs -- used for create/delete and any update that
// touches a static (rarely-edited) field. Rare enough that the double write
// doesn't matter.
async function writeLeadsSplit(env, mergedList) {
  const staticList = [];
  const dynamicList = [];
  for (const record of mergedList) {
    const { staticPart, dynamic } = splitLeadRecord(record);
    staticList.push(staticPart);
    dynamicList.push(dynamic);
  }
  await Promise.all([
    env.APA_KV.put("leads_static", JSON.stringify(staticList)),
    env.APA_KV.put("leads_dynamic", JSON.stringify(dynamicList)),
  ]);
}

// Fast path for the common case: a patch made up only of dynamic fields
// (status, notes, attachments, insurance, soft-delete) rewrites only the
// small "leads_dynamic" blob -- the static blob is never read or touched.
function isLeadsDynamicOnlyPatch(patch) {
  return Object.keys(patch).every((k) => k === "i" || LEADS_DYNAMIC_FIELDS.has(k));
}

async function writeLeadsDynamicPatch(env, id, patch, beforeWrite) {
  const raw = await env.APA_KV.get("leads_dynamic");
  const dynamicList = raw ? JSON.parse(raw) : [];
  let idx = dynamicList.findIndex((d) => String(d.i) === String(id));
  if (idx === -1) {
    // leads added straight to leads_static (bulk imports) get their overlay entry on first edit
    const s = (await env.APA_KV.get("leads_static")) || "";
    const num = /^\d+$/.test(String(id)) && s.indexOf('{"i":' + id + ",") !== -1;
    if (!num && s.indexOf('{"i":' + JSON.stringify(String(id)) + ",") === -1) return false;
    dynamicList.push({ i: num ? Number(id) : String(id) }); idx = dynamicList.length - 1;
  }
  if (beforeWrite) beforeWrite(dynamicList[idx]);   // sees the stored values before they change (audit wording)
  dynamicList[idx] = Object.assign({}, dynamicList[idx], patch, { i: id });
  await env.APA_KV.put("leads_dynamic", JSON.stringify(dynamicList));
  return true;
}

// Sign-off audit entries: one small key per agent per day ("audit-so:<date>:<agent>"), the same layout as the sign-offs
// themselves, so a busy main audit list (read-modify-write) can never drop them.
async function appendSignoffAudit(env, date, agent, entry) {
  const key = "audit-so:" + date + ":" + encodeURIComponent(agent);
  const raw = await env.APA_KV.get(key);
  const list = raw ? JSON.parse(raw) : [];
  list.push(Object.assign({ id: cryptoRandomId() }, entry, { timestamp: entry.timestamp || new Date().toISOString() }));
  await env.APA_KV.put(key, JSON.stringify(list));
}
// The full audit trail: the main list plus every sign-off audit key.
async function readAuditAll(env) {
  const main = await readJson(env, "audit");
  let keys = [];
  for (const prefix of ["audit-d:", "audit-so:"]) {
    let cursor;
    do {
      const page = await env.APA_KV.list({ prefix, cursor });
      keys = keys.concat(page.keys.map((k) => k.name)); cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }
  const parts = await Promise.all(keys.map((k) => env.APA_KV.get(k)));
  return main.concat(...parts.map((r) => (r ? JSON.parse(r) : [])));
}

// Every audit entry is stored in a small per-person-per-day key ("audit-d:<date>:<user>"). The old single "audit" list was
// rewritten on every save, and with KV's up-to-60s replication two saves in the same minute could silently drop entries.
// The old list is kept read-only as history.
async function appendAudit(env, entry) {
  const key = "audit-d:" + new Date().toISOString().slice(0, 10) + ":" + encodeURIComponent(entry.user || "system");
  const raw = await env.APA_KV.get(key);
  const list = raw ? JSON.parse(raw) : [];
  list.push(Object.assign({ id: cryptoRandomId() }, entry, { timestamp: new Date().toISOString() }));
  await env.APA_KV.put(key, JSON.stringify(list));
}

function cryptoRandomId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

// File bytes for lead attachments, keyed as "attachments:{leadId}:{filename}".
// Kept in the same KV namespace (no R2) so the whole stack stays on services
// confirmed free with no card on file.
async function uploadFile(env, leadId, filename, arrayBuffer) {
  const key = "attachments:" + leadId + ":" + filename;
  await env.APA_KV.put(key, arrayBuffer);
  return "/attachments/" + leadId + "/" + filename;
}

async function readFile(env, leadId, filename) {
  const key = "attachments:" + leadId + ":" + filename;
  return env.APA_KV.get(key, "arrayBuffer");
}

export {
  readJson, writeJson, appendAudit, appendSignoffAudit, readAuditAll, uploadFile, readFile, cryptoRandomId, ALLOWED_ENTITIES,
  readLeads, readLeadsRaw, writeLeadsSplit, isLeadsDynamicOnlyPatch, writeLeadsDynamicPatch,
};
