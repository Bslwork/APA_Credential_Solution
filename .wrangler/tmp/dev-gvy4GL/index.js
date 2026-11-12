var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/kvClient.js
var ALLOWED_ENTITIES = /* @__PURE__ */ new Set([
  "leads",
  "providers",
  "notifications",
  "audit",
  "accepted-insurances",
  "training",
  "users",
  "hiring",
  "tasks",
  "insdir"
]);
function assertEntity(entity) {
  if (!ALLOWED_ENTITIES.has(entity)) {
    const err = new Error("Unknown data entity: " + entity);
    err.status = 400;
    throw err;
  }
}
__name(assertEntity, "assertEntity");
async function readJson(env, entity) {
  assertEntity(entity);
  const raw = await env.APA_KV.get(entity);
  return raw ? JSON.parse(raw) : [];
}
__name(readJson, "readJson");
async function writeJson(env, entity, data) {
  assertEntity(entity);
  await env.APA_KV.put(entity, JSON.stringify(data));
}
__name(writeJson, "writeJson");
var LEADS_DYNAMIC_FIELDS = /* @__PURE__ */ new Set([
  "st",
  "sd",
  "sa",
  "sh",
  "grp",
  "attachments",
  "notesLog",
  "insurance",
  "deleted"
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
__name(splitLeadRecord, "splitLeadRecord");
function mergeLeads(staticList, dynamicList) {
  const dynByI = new Map(dynamicList.map((d) => [String(d.i), d]));
  return staticList.map((s) => Object.assign({}, s, dynByI.get(String(s.i)) || {}));
}
__name(mergeLeads, "mergeLeads");
async function readLeadsRaw(env) {
  return Promise.all([env.APA_KV.get("leads_static"), env.APA_KV.get("leads_dynamic")]);
}
__name(readLeadsRaw, "readLeadsRaw");
async function readLeads(env) {
  const [staticRaw, dynamicRaw] = await Promise.all([
    env.APA_KV.get("leads_static"),
    env.APA_KV.get("leads_dynamic")
  ]);
  const staticList = staticRaw ? JSON.parse(staticRaw) : [];
  const dynamicList = dynamicRaw ? JSON.parse(dynamicRaw) : [];
  return mergeLeads(staticList, dynamicList);
}
__name(readLeads, "readLeads");
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
    env.APA_KV.put("leads_dynamic", JSON.stringify(dynamicList))
  ]);
}
__name(writeLeadsSplit, "writeLeadsSplit");
async function writeLeadsDynamicPatch(env, id, patch, beforeWrite) {
  const raw = await env.APA_KV.get("leads_dynamic");
  const dynamicList = raw ? JSON.parse(raw) : [];
  let idx = dynamicList.findIndex((d) => String(d.i) === String(id));
  if (idx === -1) {
    const s = await env.APA_KV.get("leads_static") || "";
    const num = /^\d+$/.test(String(id)) && s.indexOf('{"i":' + id + ",") !== -1;
    if (!num && s.indexOf('{"i":' + JSON.stringify(String(id)) + ",") === -1) return false;
    dynamicList.push({ i: num ? Number(id) : String(id) });
    idx = dynamicList.length - 1;
  }
  if (beforeWrite) beforeWrite(dynamicList[idx]);
  dynamicList[idx] = Object.assign({}, dynamicList[idx], patch, { i: id });
  await env.APA_KV.put("leads_dynamic", JSON.stringify(dynamicList));
  return true;
}
__name(writeLeadsDynamicPatch, "writeLeadsDynamicPatch");
async function appendSignoffAudit(env, date, agent, entry) {
  const key = "audit-so:" + date + ":" + encodeURIComponent(agent);
  const raw = await env.APA_KV.get(key);
  const list = raw ? JSON.parse(raw) : [];
  list.push(Object.assign({ id: cryptoRandomId() }, entry, { timestamp: entry.timestamp || (/* @__PURE__ */ new Date()).toISOString() }));
  await env.APA_KV.put(key, JSON.stringify(list));
}
__name(appendSignoffAudit, "appendSignoffAudit");
async function readAuditAll(env) {
  const main = await readJson(env, "audit");
  let keys = [];
  for (const prefix of ["audit-d:", "audit-so:"]) {
    let cursor;
    do {
      const page = await env.APA_KV.list({ prefix, cursor });
      keys = keys.concat(page.keys.map((k) => k.name));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }
  const parts = await Promise.all(keys.map((k) => env.APA_KV.get(k)));
  return main.concat(...parts.map((r) => r ? JSON.parse(r) : []));
}
__name(readAuditAll, "readAuditAll");
async function appendAudit(env, entry) {
  const key = "audit-d:" + (/* @__PURE__ */ new Date()).toISOString().slice(0, 10) + ":" + encodeURIComponent(entry.user || "system");
  const raw = await env.APA_KV.get(key);
  const list = raw ? JSON.parse(raw) : [];
  list.push(Object.assign({ id: cryptoRandomId() }, entry, { timestamp: (/* @__PURE__ */ new Date()).toISOString() }));
  await env.APA_KV.put(key, JSON.stringify(list));
}
__name(appendAudit, "appendAudit");
function cryptoRandomId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
__name(cryptoRandomId, "cryptoRandomId");
async function uploadFile(env, leadId, filename, arrayBuffer) {
  const key = "attachments:" + leadId + ":" + filename;
  await env.APA_KV.put(key, arrayBuffer);
  return "/attachments/" + leadId + "/" + filename;
}
__name(uploadFile, "uploadFile");
async function readFile(env, leadId, filename) {
  const key = "attachments:" + leadId + ":" + filename;
  return env.APA_KV.get(key, "arrayBuffer");
}
__name(readFile, "readFile");

// src/auth.js
var SESSION_COOKIE = "apa_session";
var SESSION_TTL_SECONDS = 24 * 60 * 60;
function b64urlEncode(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(b64urlEncode, "b64urlEncode");
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
__name(b64urlDecode, "b64urlDecode");
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
__name(hmacKey, "hmacKey");
async function signSession(payload, secret) {
  const json4 = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(new TextEncoder().encode(json4));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return payloadB64 + "." + b64urlEncode(sig);
}
__name(signSession, "signSession");
async function verifySession(token, secret) {
  if (!token || token.indexOf(".") === -1) return null;
  const [payloadB64, sigB64] = token.split(".");
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlDecode(sigB64),
    new TextEncoder().encode(payloadB64)
  );
  if (!valid) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
  } catch (e) {
    return null;
  }
  if (!payload.exp || Date.now() / 1e3 > payload.exp) return null;
  return payload;
}
__name(verifySession, "verifySession");
function parseCookies(req) {
  const header = req.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
__name(parseCookies, "parseCookies");
function sessionCookieHeader(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}
__name(sessionCookieHeader, "sessionCookieHeader");
function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}
__name(clearSessionCookieHeader, "clearSessionCookieHeader");
async function getSession(req, env) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return verifySession(token, env.SESSION_SECRET);
}
__name(getSession, "getSession");
async function requireSession(req, env) {
  const session = await getSession(req, env);
  if (!session) {
    const err = new Error("Not signed in.");
    err.status = 401;
    throw err;
  }
  return session;
}
__name(requireSession, "requireSession");
function isAdminLike(role) {
  return role === "admin" || role === "superadmin";
}
__name(isAdminLike, "isAdminLike");
async function requireAdmin(req, env) {
  const session = await requireSession(req, env);
  if (!isAdminLike(session.role)) {
    const err = new Error("Admin access required.");
    err.status = 403;
    throw err;
  }
  return session;
}
__name(requireAdmin, "requireAdmin");
function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(bytesToHex, "bytesToHex");
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}
__name(hexToBytes, "hexToBytes");
async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { hash: bytesToHex(bits), salt: bytesToHex(salt) };
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, hashHex, saltHex) {
  const { hash } = await hashPassword(password, saltHex);
  if (hash.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}
__name(verifyPassword, "verifyPassword");

// src/routes/data.js
var ID_FIELD = { leads: "i", providers: "id", notifications: "id", training: "id", hiring: "id", tasks: "id", insdir: "id" };
async function handleGet(req, env, entity) {
  if (entity === "audit") {
    await requireAdmin(req, env);
  } else {
    await requireSession(req, env);
  }
  if (entity === "leads") {
    const [s, d] = await readLeadsRaw(env);
    return new Response('{"split":1,"s":' + (s || "[]") + ',"d":' + (d || "[]") + "}", {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  const data = entity === "audit" ? await readAuditAll(env) : await readJson(env, entity);
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}
__name(handleGet, "handleGet");
async function handlePost(req, env, entity) {
  if (entity === "audit") {
    return new Response(JSON.stringify({ error: "audit is append-only via other actions" }), { status: 400 });
  }
  const user = await requireSession(req, env);
  const idField = ID_FIELD[entity];
  if (!idField) return new Response(JSON.stringify({ error: "Unknown entity: " + entity }), { status: 400 });
  const body = await req.json().catch(() => ({}));
  const record = body.record;
  const action = body.action;
  if (!record || !action) return new Response(JSON.stringify({ error: "record and action are required" }), { status: 400 });
  if (action !== "create" && action !== "update" && action !== "delete") {
    return new Response(JSON.stringify({ error: "action must be create/update/delete" }), { status: 400 });
  }
  if (entity === "leads" && action === "create") {
    if (!record.em || !record.ph || !record.w) {
      return new Response(JSON.stringify({ error: "Email, phone, and website are all required." }), { status: 422 });
    }
  }
  let summary = null, logIt = true;
  if (entity === "leads") {
    const leadName = record._n, leadBefore = record._before || {};
    delete record._n;
    delete record._before;
    delete record.sh;
    const patch = action === "delete" ? { deleted: true } : record;
    if (action !== "create") {
      const found = await writeLeadsDynamicPatch(env, record[idField], patch, (prev) => {
        const name = leadName || prev.n || "Lead #" + record[idField];
        if (action !== "delete" && patch.st) {
          const was = Object.assign({}, leadBefore, prev);
          if (patch.st !== (was.st || "new")) {
            const day = (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
            const hist = Array.isArray(prev.sh) ? prev.sh.slice() : was.st && was.st !== "new" && was.sd ? [{ s: was.st, d: String(was.sd).slice(0, 10), by: was.sa || "" }] : [];
            hist.push({ s: patch.st, d: day, by: user.name || "" });
            patch.sh = hist.slice(-40);
            patch.sd = day;
          }
        }
        if (action === "delete") {
          summary = name + ": hidden from the list";
          return;
        }
        const changes = describeChanges(Object.assign({}, leadBefore, prev), patch);
        if (!changes.length) {
          logIt = false;
          return;
        }
        summary = name + ": " + changes.join("; ");
        if (summary.length > 900) summary = summary.slice(0, 897) + "...";
      });
      if (!found) return new Response(JSON.stringify({ error: "Record not found" }), { status: 404 });
    } else {
      const list = await readLeads(env);
      const idx = list.findIndex((x) => String(x[idField]) === String(record[idField]));
      if (action === "create") {
        if (record[idField] == null || record[idField] === "") {
          record[idField] = entity + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        }
        list.push(record);
      } else {
        if (idx === -1) return new Response(JSON.stringify({ error: "Record not found" }), { status: 404 });
        list[idx] = Object.assign({}, list[idx], patch);
      }
      await writeLeadsSplit(env, list);
      summary = 'New lead "' + (record.n || "") + '" added (email ' + (record.em || "-") + ", phone " + (record.ph || "-") + ", website " + (record.w || "-") + ")";
    }
  } else {
    summary = null;
    const list = await readJson(env, entity);
    const idx = list.findIndex((x) => String(x[idField]) === String(record[idField]));
    const before = idx === -1 ? null : Object.assign({}, list[idx]);
    let rec = record;
    if (entity === "tasks" && user.role !== "admin" && user.role !== "superadmin") {
      if (action !== "update") return new Response(JSON.stringify({ error: "Only team leaders can add or delete tasks." }), { status: 403 });
      if (idx === -1) return new Response(JSON.stringify({ error: "Record not found" }), { status: 404 });
      if (String(list[idx].assignee || "") !== String(user.name || "")) {
        return new Response(JSON.stringify({ error: "You can only update tasks assigned to you." }), { status: 403 });
      }
      rec = { [idField]: record[idField] };
      ["completed", "completedAt", "agentNote"].forEach((k) => {
        if (k in record) rec[k] = record[k];
      });
    }
    if (entity === "insdir" && user.role !== "admin" && user.role !== "superadmin") {
      if (action !== "update") return new Response(JSON.stringify({ error: "Only team leaders can add or delete directory rows." }), { status: 403 });
      if (idx === -1) return new Response(JSON.stringify({ error: "Record not found" }), { status: 404 });
      if (String(list[idx].agent || "") !== String(user.name || "")) {
        return new Response(JSON.stringify({ error: "You can only update organizations assigned to you." }), { status: 403 });
      }
      rec = { [idField]: record[idField] };
      ["status", "upd", "notes"].forEach((k) => {
        if (k in record) rec[k] = record[k];
      });
    }
    if (action === "create") {
      if (record[idField] == null || record[idField] === "") {
        record[idField] = entity + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      }
      list.push(record);
      summary = recordLabel(entity, record) + " created" + (entity === "tasks" ? (record.deadline ? ", deadline " + record.deadline : "") + (record.priority ? ", priority " + record.priority : "") : "");
    } else if (action === "update") {
      if (idx === -1) return new Response(JSON.stringify({ error: "Record not found" }), { status: 404 });
      const changes = describeChanges(before, rec);
      if (!changes.length) return new Response(JSON.stringify({ ok: true, id: record[idField], unchanged: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      summary = (recordLabel(entity, before) || String(record[idField])) + ": " + changes.join("; ");
      if (summary.length > 900) summary = summary.slice(0, 897) + "...";
      list[idx] = Object.assign({}, list[idx], rec);
    } else if (action === "delete") {
      if (idx === -1) return new Response(JSON.stringify({ error: "Record not found" }), { status: 404 });
      list[idx].deleted = true;
      summary = (recordLabel(entity, before) || String(record[idField])) + " deleted";
    }
    await writeJson(env, entity, list);
  }
  if (!logIt) return new Response(JSON.stringify({ ok: true, id: record[idField], unchanged: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  await appendAudit(env, {
    entity: entity.replace(/s$/, ""),
    entityId: record[idField],
    action,
    user: user.name,
    summary
  });
  return new Response(JSON.stringify({ ok: true, id: record[idField] }), { status: 200, headers: { "Content-Type": "application/json" } });
}
__name(handlePost, "handlePost");
var STEP_NAMES = [
  "Receive Candidate CVs",
  "Review CVs",
  "Verify License + DEA",
  "Clinical Review",
  "Schedule Interview",
  "Send Zoom Invite",
  "Coordinate Schedule",
  "Post-Interview Decision",
  "Send Offer Letter",
  "Onboarding & Credentialing",
  "Website Information & Software Setup",
  "Schedule Training",
  "Microsoft Teams Setup",
  "Send Training Invites",
  "Send PECOS/NPPES Surrogacy Request",
  "Finalize Start Date & IT Access",
  "Announce Hire"
];
var FIELD_LABELS = {
  task: "task",
  tlNote: "TL note",
  agentNote: "agent note",
  assignee: "assigned to",
  priority: "priority",
  date: "task date",
  deadline: "deadline",
  completedAt: "completed on",
  cvDate: "CV received",
  expectedStart: "expected start",
  nextDue: "next action due",
  hold: "stage override",
  start: "start time",
  note: "booking note"
};
var STATUS_LABELS = {
  new: "Not started",
  contacted: "Emailed",
  applied: "Applied",
  talking: "In progress",
  contracted: "Contracted",
  covered: "Already covered",
  declined: "Declined",
  invalid: "Invalid"
};
Object.assign(FIELD_LABELS, {
  n: "name",
  t: "type",
  em: "email",
  ph: "phone",
  fx: "fax",
  w: "website",
  ad: "address",
  grp: "group",
  ch: "contact channel",
  chan: "source",
  insurance: "insurance",
  providerName: "provider",
  trainingTitle: "training",
  trainer: "trainer",
  location: "location",
  time: "time",
  notes: "notes",
  bio: "provider's bio",
  lobs: "lines of business",
  effectiveDate: "effective date"
});
function listDiff(label, a, b, keyOf) {
  const was = (Array.isArray(a) ? a : []).map(keyOf).map(String), now = (Array.isArray(b) ? b : []).map(keyOf).map(String);
  const added = now.filter((x) => !was.includes(x)), removed = was.filter((x) => !now.includes(x)), out = [];
  if (added.length) out.push(label + " added: " + added.map((x) => '"' + short(x) + '"').join(", "));
  if (removed.length) out.push(label + " removed: " + removed.map((x) => '"' + short(x) + '"').join(", "));
  return out;
}
__name(listDiff, "listDiff");
var norm = /* @__PURE__ */ __name((v) => v == null || v === "" || v === false ? "" : JSON.stringify(v), "norm");
var short = /* @__PURE__ */ __name((v) => {
  const s = v == null || v === "" ? "(empty)" : Array.isArray(v) ? v.length ? v.join(", ") : "(empty)" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}, "short");
function recordLabel(entity, r) {
  if (!r) return "";
  if (entity === "tasks") return 'Task "' + short(r.task) + '"' + (r.assignee ? " (" + r.assignee + ")" : "");
  if (entity === "insdir") return "Directory #" + (r.no || r.id) + (r.org ? " " + r.org : "");
  if (entity === "training") return (r.providerName || "") + " - " + (r.trainingTitle || "") + " training";
  if (entity === "hiring" && r.kind && r.kind !== "candidate") return (r.name || "") + " - " + r.kind + " booking";
  return r.n || r.name || "";
}
__name(recordLabel, "recordLabel");
function describeChanges(before, after) {
  const out = [];
  for (const k of Object.keys(after)) {
    if (k === "id" || k === "i" || k === "kind" || k === "sh") continue;
    if (k === "deleted") {
      if (norm(before && before[k]) !== norm(after[k])) out.push(after[k] ? "hidden" : "restored to the list");
      continue;
    }
    const a = before ? before[k] : void 0, b = after[k];
    if (k === "steps" && Array.isArray(b)) {
      const was = Array.isArray(a) ? a : [], on = [], off = [];
      b.forEach((v, i) => {
        if (!!v !== !!was[i]) (v ? on : off).push(i + 1 + ". " + (STEP_NAMES[i] || "step"));
      });
      if (on.length) out.push("checked " + on.join(", "));
      if (off.length) out.push("unchecked " + off.join(", "));
      continue;
    }
    if (k === "sd" || k === "sa" || norm(a) === norm(b)) continue;
    if (k === "st") {
      out.push('status: "' + (STATUS_LABELS[a] || short(a)) + '" -> "' + (STATUS_LABELS[b] || short(b)) + '"');
      continue;
    }
    if (k === "notesLog") {
      out.push(...listDiff("note", a, b, (x) => x && x.text));
      continue;
    }
    if (k === "attachments") {
      out.push(...listDiff("attachment", a, b, (x) => x && x.name));
      continue;
    }
    if (k === "people") {
      out.push(...listDiff("contact", a, b, (x) => x && [x.name, x.title, x.email].filter(Boolean).join(", ")));
      continue;
    }
    if (k === "photo") {
      out.push(b ? "photo changed" : "photo removed");
      continue;
    }
    if (b && typeof b === "object" && !Array.isArray(b)) {
      const was = a && typeof a === "object" ? a : {};
      for (const f of /* @__PURE__ */ new Set([...Object.keys(was), ...Object.keys(b)])) {
        if (norm(was[f]) !== norm(b[f])) out.push((FIELD_LABELS[k] || k) + " " + (FIELD_LABELS[f] || f) + ': "' + short(was[f]) + '" -> "' + short(b[f]) + '"');
      }
      continue;
    }
    if (k === "completed") {
      out.push(b ? "marked the task done" : "reopened the task");
      continue;
    }
    if (k === "completedAt" && "completed" in after) continue;
    out.push((FIELD_LABELS[k] || k) + ': "' + short(a) + '" -> "' + short(b) + '"');
  }
  return out;
}
__name(describeChanges, "describeChanges");

// src/routes/upload.js
var MAX_BYTES = 20 * 1024 * 1024;
async function handleUpload(req, env, leadId) {
  const user = await requireSession(req, env);
  let name, bytes;
  if ((req.headers.get("Content-Type") || "").includes("json")) {
    const body = await req.json().catch(() => ({}));
    name = body.name;
    if (!name || !body.base64) return new Response(JSON.stringify({ error: "name and base64 are required" }), { status: 400 });
    const binary = atob(body.base64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    bytes = arr.buffer;
  } else {
    name = new URL(req.url).searchParams.get("name") || "file";
    bytes = await req.arrayBuffer();
  }
  if (!bytes.byteLength) return new Response(JSON.stringify({ error: "empty file" }), { status: 400 });
  if (bytes.byteLength > MAX_BYTES) return new Response(JSON.stringify({ error: "File too large (20MB max)" }), { status: 413 });
  const safeName = String(name).replace(/[^A-Za-z0-9._-]/g, "_");
  const fname = Date.now() + "-" + safeName;
  const url = await uploadFile(env, leadId, fname, bytes);
  return new Response(JSON.stringify({
    name,
    url,
    uploadedAt: (/* @__PURE__ */ new Date()).toISOString(),
    uploadedBy: user.name
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
__name(handleUpload, "handleUpload");

// src/routes/audit-export.js
function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
__name(csvEscape, "csvEscape");
async function handleAuditExport(req, env) {
  await requireAdmin(req, env);
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ? new Date(url.searchParams.get("from")) : null;
  const to = url.searchParams.get("to") ? new Date(url.searchParams.get("to")) : null;
  const who = url.searchParams.get("user") || "";
  const log = await readAuditAll(env);
  const rows = log.filter((r) => {
    const t = new Date(r.timestamp);
    if (from && t < from) return false;
    if (to && t > to) return false;
    if (who && r.user !== who) return false;
    return true;
  });
  const headers = ["timestamp", "user", "entity", "entityId", "action", "summary"];
  const lines = [headers.join(",")].concat(rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")));
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=audit-export.csv" }
  });
}
__name(handleAuditExport, "handleAuditExport");

// src/routes/auth-routes.js
var LOCK_MINUTES = 15;
var MAX_PER_ACCOUNT = 5;
var MAX_PER_IP = 10;
async function readCounter(env, key) {
  return await env.APA_KV.get(key, "json") || { n: 0 };
}
__name(readCounter, "readCounter");
async function bump(env, key, c) {
  await env.APA_KV.put(key, JSON.stringify({ n: c.n + 1 }), { expirationTtl: LOCK_MINUTES * 60 });
}
__name(bump, "bump");
function locked() {
  return new Response(
    JSON.stringify({ error: "Too many failed sign-in attempts. Try again in " + LOCK_MINUTES + " minutes." }),
    { status: 429, headers: { "Retry-After": String(LOCK_MINUTES * 60) } }
  );
}
__name(locked, "locked");
async function handleLogin(req, env) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) {
    return new Response(JSON.stringify({ error: "Email and password are required." }), { status: 400 });
  }
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = "lockout:ip:" + ip, acctKey = "lockout:acct:" + email;
  const [ipC, acctC] = await Promise.all([readCounter(env, ipKey), readCounter(env, acctKey)]);
  if (ipC.n >= MAX_PER_IP || acctC.n >= MAX_PER_ACCOUNT) return locked();
  const users = await readJson(env, "users");
  const user = users.find((u) => !u.deleted && String(u.email || "").toLowerCase() === email);
  if (!user || !await verifyPassword(password, user.passwordHash, user.salt)) {
    const writes = [bump(env, ipKey, ipC)];
    if (user) writes.push(bump(env, acctKey, acctC));
    await Promise.all(writes);
    return new Response(JSON.stringify({ error: "Incorrect email or password." }), { status: 401 });
  }
  if (acctC.n > 0) await env.APA_KV.delete(acctKey);
  const exp = Math.floor(Date.now() / 1e3) + SESSION_TTL_SECONDS;
  const token = await signSession({ uid: user.id, name: user.name, role: user.role, exp }, env.SESSION_SECRET);
  return new Response(JSON.stringify({ ok: true, name: user.name, role: user.role, uid: user.id }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(token, SESSION_TTL_SECONDS) }
  });
}
__name(handleLogin, "handleLogin");
async function handleLogout(req, env) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookieHeader() }
  });
}
__name(handleLogout, "handleLogout");
async function handleMe(req, env) {
  const session = await getSession(req, env);
  if (!session) return new Response(JSON.stringify({ signedIn: false }), { status: 200 });
  return new Response(JSON.stringify({ signedIn: true, name: session.name, role: session.role, uid: session.uid }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
__name(handleMe, "handleMe");

// src/routes/users.js
var COMPANY_DOMAIN = "@advancedpsychiatryassociates.com";
function isCompanyEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@advancedpsychiatryassociates\.com$/.test(e);
}
__name(isCompanyEmail, "isCompanyEmail");
var DOMAIN_ERROR = "Only " + COMPANY_DOMAIN + " email addresses can be used for accounts.";
function weakPassword(p) {
  const s = String(p || "");
  if (s.length < 10 || !/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return "Password must be at least 10 characters and include letters and numbers.";
  return "";
}
__name(weakPassword, "weakPassword");
function publicView(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, deleted: !!u.deleted };
}
__name(publicView, "publicView");
async function handleGetUsers(req, env) {
  await requireAdmin(req, env);
  const users = await readJson(env, "users");
  return new Response(JSON.stringify(users.filter((u) => !u.deleted).map(publicView)), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
__name(handleGetUsers, "handleGetUsers");
async function handleTeam(req, env) {
  await requireSession(req, env);
  const users = await readJson(env, "users");
  return new Response(JSON.stringify(users.filter((u) => !u.deleted).map((u) => ({ name: u.name, role: u.role }))), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
__name(handleTeam, "handleTeam");
function resolveRole(requestedRole, actingIsSuperAdmin) {
  if (requestedRole === "superadmin") return actingIsSuperAdmin ? "superadmin" : "admin";
  return requestedRole === "admin" ? "admin" : "user";
}
__name(resolveRole, "resolveRole");
async function handlePostUsers(req, env) {
  const session = await requireAdmin(req, env);
  const actingIsSuperAdmin = session.role === "superadmin";
  const body = await req.json().catch(() => ({}));
  const record = body.record;
  const action = body.action;
  if (!record || !action) return new Response(JSON.stringify({ error: "record and action are required" }), { status: 400 });
  const users = await readJson(env, "users");
  const idx = users.findIndex((u) => String(u.id) === String(record.id));
  if (action === "create") {
    if (!record.name || !record.email || !record.password) {
      return new Response(JSON.stringify({ error: "Name, email, and password are all required." }), { status: 422 });
    }
    if (!isCompanyEmail(record.email)) {
      return new Response(JSON.stringify({ error: DOMAIN_ERROR }), { status: 422 });
    }
    const emailKey = String(record.email).trim().toLowerCase();
    if (users.some((u) => !u.deleted && String(u.email || "").toLowerCase() === emailKey)) {
      return new Response(JSON.stringify({ error: "A user with that email already exists." }), { status: 409 });
    }
    const weak = weakPassword(record.password);
    if (weak) return new Response(JSON.stringify({ error: weak }), { status: 422 });
    const { hash, salt } = await hashPassword(record.password);
    const newUser = {
      id: "user-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: record.name,
      email: emailKey,
      role: resolveRole(record.role, actingIsSuperAdmin),
      passwordHash: hash,
      salt,
      deleted: false
    };
    users.push(newUser);
    await writeJson(env, "users", users);
    await appendAudit(env, {
      entity: "user",
      entityId: newUser.id,
      action: "create",
      user: session.name,
      summary: "Account created for " + newUser.name + " (" + newUser.email + "), role " + newUser.role
    });
    return new Response(JSON.stringify({ ok: true, id: newUser.id }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (idx === -1) return new Response(JSON.stringify({ error: "User not found" }), { status: 404 });
  if (users[idx].role === "superadmin" && !actingIsSuperAdmin) {
    return new Response(JSON.stringify({ error: "Only a super admin can change or delete a super admin's account." }), { status: 403 });
  }
  if (action === "update") {
    const target = users[idx];
    const isSelf = String(target.id) === String(session.uid);
    if (record.password && !isSelf && isAdminLike(target.role) && !actingIsSuperAdmin) {
      return new Response(JSON.stringify({ error: "Only a super admin can change another admin's password." }), { status: 403 });
    }
    if (record.password && weakPassword(record.password)) {
      return new Response(JSON.stringify({ error: weakPassword(record.password) }), { status: 422 });
    }
    if (record.email && String(record.email).trim().toLowerCase() !== String(target.email || "").toLowerCase()) {
      if (!isCompanyEmail(record.email)) {
        return new Response(JSON.stringify({ error: DOMAIN_ERROR }), { status: 422 });
      }
      const k = String(record.email).trim().toLowerCase();
      if (users.some((u, j) => j !== idx && !u.deleted && String(u.email || "").toLowerCase() === k)) {
        return new Response(JSON.stringify({ error: "A user with that email already exists." }), { status: 409 });
      }
    }
    const updated = Object.assign({}, target);
    if (record.name) updated.name = record.name;
    if (record.email) updated.email = String(record.email).trim().toLowerCase();
    if (record.role) updated.role = resolveRole(record.role, actingIsSuperAdmin);
    if (record.password) {
      const { hash, salt } = await hashPassword(record.password);
      updated.passwordHash = hash;
      updated.salt = salt;
    }
    const ch = [];
    ["name", "email", "role"].forEach((k) => {
      if (String(target[k] || "") !== String(updated[k] || "")) ch.push(k + ': "' + (target[k] || "") + '" -> "' + updated[k] + '"');
    });
    if (record.password) ch.push("password changed");
    if (!ch.length) return new Response(JSON.stringify({ ok: true, id: updated.id, unchanged: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    users[idx] = updated;
    await writeJson(env, "users", users);
    await appendAudit(env, {
      entity: "user",
      entityId: updated.id,
      action: "update",
      user: session.name,
      summary: "Account " + target.name + " (" + target.email + "): " + ch.join("; ")
    });
    return new Response(JSON.stringify({ ok: true, id: updated.id }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (action === "delete") {
    users[idx].deleted = true;
    await writeJson(env, "users", users);
    await appendAudit(env, {
      entity: "user",
      entityId: users[idx].id,
      action: "delete",
      user: session.name,
      summary: "Account removed: " + users[idx].name + " (" + users[idx].email + ")"
    });
    return new Response(JSON.stringify({ ok: true, id: users[idx].id }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "action must be create/update/delete" }), { status: 400 });
}
__name(handlePostUsers, "handlePostUsers");

// src/routes/signoffs.js
var SIGNOFF_TASKS = [
  "roster",
  "pave",
  "directory",
  "caqh",
  "filing",
  "pecos",
  "tracking",
  "em-candidate",
  "em-application",
  "em-existing",
  "em-contracted",
  "leads",
  "auth",
  "em-noncontracted"
];
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var MONTH_RE = /^\d{4}-\d{2}$/;
var isLeader = /* @__PURE__ */ __name((role) => role === "admin" || role === "superadmin", "isLeader");
var todayPacific = /* @__PURE__ */ __name(() => (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }), "todayPacific");
var json = /* @__PURE__ */ __name((status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }), "json");
var dayKey = /* @__PURE__ */ __name((date, agent) => "signoffs:" + date + ":" + encodeURIComponent(agent), "dayKey");
var TASK_NAMES = {
  roster: "Provider Roster",
  pave: "Provider Enrollment (PAVE)",
  directory: "Provider Directory",
  caqh: "Data Management (CAQH Update)",
  filing: "New & Existing Insurance Filing",
  pecos: "Medicare Enrollment (PECOS)",
  tracking: "Insurance Tracking Sheet Follow-Up",
  "em-candidate": "Email Inquiries (New Candidate)",
  "em-application": "Email Inquiries (New Applications)",
  "em-existing": "Email Inquiries (Existing Providers)",
  "em-contracted": "Email Inquiries (Contracted Insurance)",
  leads: "Contact New Leads",
  auth: "Authorization (Surrogacy Auth Requests)",
  "em-noncontracted": "Email Inquiries (Non-Contracted Insurance)"
};
var clip = /* @__PURE__ */ __name((t, n) => t.length > n ? t.slice(0, n - 3) + "..." : t, "clip");
var CUSTOM_KEY = "signoff-tasks";
async function readCustom(env) {
  const raw = await env.APA_KV.get(CUSTOM_KEY);
  return raw ? JSON.parse(raw) : [];
}
__name(readCustom, "readCustom");
async function readAgentDay(env, date, agent) {
  const raw = await env.APA_KV.get(dayKey(date, agent));
  return raw ? JSON.parse(raw) : {};
}
__name(readAgentDay, "readAgentDay");
async function teamNames(env, agentsOnly) {
  const users = await readJson(env, "users");
  return users.filter((u) => !u.deleted && (!agentsOnly || u.role === "user")).map((u) => u.name);
}
__name(teamNames, "teamNames");
async function handleGetSignoffs(req, env, url) {
  const me = await requireSession(req, env);
  const date = url.searchParams.get("date") || todayPacific();
  if (!DATE_RE.test(date)) return json(400, { error: "Bad date." });
  const names = isLeader(me.role) ? await teamNames(env, false) : [me.name];
  const days = await Promise.all(names.map((n) => readAgentDay(env, date, n)));
  const entries = [];
  days.forEach((d) => Object.values(d).forEach((e) => entries.push(e)));
  return json(200, { date, today: todayPacific(), entries, custom: await readCustom(env) });
}
__name(handleGetSignoffs, "handleGetSignoffs");
async function handleSignoffStats(req, env, url) {
  const me = await requireSession(req, env);
  if (!isLeader(me.role)) return json(403, { error: "Only team leaders can see the dashboard." });
  const today = todayPacific(), month = url.searchParams.get("month") || today.slice(0, 7);
  if (!MONTH_RE.test(month)) return json(400, { error: "Bad month." });
  const [y, mo] = month.split("-").map(Number), last = new Date(Date.UTC(y, mo, 0)).getUTCDate(), dates = [];
  for (let d = 1; d <= last; d++) {
    const s = month + "-" + String(d).padStart(2, "0");
    if (s <= today) dates.push(s);
  }
  const names = await teamNames(env, true), days = {};
  await Promise.all(dates.flatMap((date) => names.map(async (name) => {
    const d = await readAgentDay(env, date, name);
    Object.values(d).forEach((e) => {
      if (e.count == null) return;
      days[date] = days[date] || {};
      days[date][name] = days[date][name] || {};
      days[date][name][e.task] = e.count;
    });
  })));
  return json(200, { month, today, days });
}
__name(handleSignoffStats, "handleSignoffStats");
async function handlePostSignoffTasks(req, env) {
  const me = await requireSession(req, env);
  if (!isLeader(me.role)) return json(403, { error: "Only team leaders can change task types." });
  const body = await req.json().catch(() => ({}));
  const list = await readCustom(env);
  if (body.action === "add") {
    const label = String(body.label || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const q = String(body.q || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (label.length < 3) return json(400, { error: "Give the task type a name (at least 3 characters)." });
    if (list.some((c) => !c.deleted && c.label.toLowerCase() === label.toLowerCase())) return json(409, { error: "That task type already exists." });
    list.push({ k: "c-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), label, ...q ? { q } : {}, by: me.name, at: (/* @__PURE__ */ new Date()).toISOString() });
  } else if (body.action === "remove") {
    const c = list.find((x) => x.k === body.k);
    if (!c) return json(404, { error: "Task type not found." });
    c.deleted = true;
  } else return json(400, { error: "Unknown action." });
  await env.APA_KV.put(CUSTOM_KEY, JSON.stringify(list));
  const changed = body.action === "add" ? list[list.length - 1] : list.find((x) => x.k === body.k);
  await appendSignoffAudit(env, todayPacific(), me.name, {
    entity: "Daily Sign-off task types",
    entityId: changed.k,
    action: body.action === "add" ? "create" : "delete",
    user: me.name,
    summary: body.action === "add" ? 'task type added: "' + changed.label + '"' + (changed.q ? ' (question: "' + changed.q + '")' : "") : 'task type removed: "' + changed.label + '"'
  });
  return json(200, { ok: true, custom: list });
}
__name(handlePostSignoffTasks, "handlePostSignoffTasks");
async function handlePostSignoff(req, env) {
  const me = await requireSession(req, env);
  const body = await req.json().catch(() => ({}));
  const task = String(body.task || "");
  const custom = SIGNOFF_TASKS.includes(task) ? null : (await readCustom(env)).find((c) => c.k === task && !c.deleted);
  if (!SIGNOFF_TASKS.includes(task) && !custom) return json(400, { error: "Unknown task type." });
  const lead = isLeader(me.role), today = todayPacific();
  const agent = lead && body.agent ? String(body.agent).trim().slice(0, 80) : me.name;
  const date = lead && body.date ? String(body.date) : today;
  if (!DATE_RE.test(date) || date > today) return json(400, { error: "Bad date." });
  if (!lead && body.date && body.date !== today) return json(403, { error: "Notes can only be written for today (" + today + "). Past days are read-only." });
  const day = await readAgentDay(env, date, agent);
  const e = day[task] || { agent, task, notes: [], count: null };
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const text = String(body.text == null ? "" : body.text).replace(/\r/g, "").trim().slice(0, 4e3);
  const op = body.op;
  let what = "", act = "update";
  if (op === "add") {
    if (!text) return json(400, { error: "Write the note first." });
    if (e.notes.length >= 60) return json(400, { error: "That is the maximum number of notes for one task in a day." });
    e.notes.push({ id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text, at: now, by: me.name });
    what = 'note added: "' + clip(text, 1500) + '"';
    act = "create";
  } else if (op === "edit" || op === "del") {
    const n = e.notes.find((x) => x.id === body.id);
    if (!n) return json(404, { error: "Note not found. Refresh the page." });
    if (!lead && (n.by || agent) !== me.name) return json(403, { error: "You can only change notes you wrote." });
    if (op === "del") {
      e.notes = e.notes.filter((x) => x !== n);
      what = 'note deleted: "' + clip(n.text, 1500) + '"';
      act = "delete";
    } else {
      if (!text) return json(400, { error: "A note cannot be empty. Delete it instead." });
      what = 'note changed: "' + clip(n.text, 700) + '" -> "' + clip(text, 700) + '"';
      n.text = text;
      n.edited = now;
    }
  } else if (op === "count") {
    const was = e.count;
    if (body.count === null || body.count === "" || body.count === void 0) e.count = null;
    else {
      const c = Number(body.count);
      if (!Number.isInteger(c) || c < 0 || c > 1e5) return json(400, { error: "Enter a whole number (0 or more)." });
      e.count = c;
    }
    if (was === e.count) what = "";
    else what = e.count == null ? "number cleared (was " + was + ")" : "number set to " + e.count + (was == null ? "" : " (was " + was + ")");
  } else return json(400, { error: "Please refresh the page to get the latest version." });
  e.at = now;
  e.agent = agent;
  if (!e.notes.length && e.count == null) delete day[task];
  else day[task] = e;
  const key = dayKey(date, agent);
  if (Object.keys(day).length) await env.APA_KV.put(key, JSON.stringify(day));
  else await env.APA_KV.delete(key);
  if (what) {
    const name = custom && custom.label || TASK_NAMES[task] || task;
    await appendSignoffAudit(env, date, agent, {
      entity: name + " (sign-off)",
      entityId: date + ":" + agent + ":" + task,
      action: act,
      user: me.name,
      summary: agent + " \xB7 " + date + (me.name !== agent ? " (written by " + me.name + ")" : "") + ": " + what
    });
  }
  return json(200, { ok: true, date, entry: day[task] || null });
}
__name(handlePostSignoff, "handlePostSignoff");

// src/routes/pnotes.js
var OWNER = "user-munzua45u9e6";
var KEY = "pn:" + OWNER;
var js = /* @__PURE__ */ __name((body) => new Response(body, { status: 200, headers: { "Content-Type": "application/javascript; charset=utf-8" } }), "js");
var json2 = /* @__PURE__ */ __name((status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }), "json");
var notFound = /* @__PURE__ */ __name(() => json2(404, { error: "not found" }), "notFound");
async function owner(req, env) {
  try {
    const s = await requireSession(req, env);
    return s && s.uid === OWNER ? s : null;
  } catch (e) {
    return null;
  }
}
__name(owner, "owner");
async function handleExtras(req, env) {
  return js(await owner(req, env) ? UI : "");
}
__name(handleExtras, "handleExtras");
async function handlePn(req, env) {
  if (!await owner(req, env)) return notFound();
  const read = /* @__PURE__ */ __name(async () => JSON.parse(await env.APA_KV.get(KEY) || "[]"), "read");
  if (req.method === "GET") return json2(200, { notes: await read() });
  if (req.method !== "POST") return notFound();
  const b = await req.json().catch(() => ({}));
  const notes = await read(), now = (/* @__PURE__ */ new Date()).toISOString();
  const title = String(b.title || "").trim().slice(0, 160), body = String(b.body || "").replace(/\r/g, "").slice(0, 2e4);
  const n = notes.find((x) => x.id === b.id);
  if (b.op === "add") {
    if (!title && !body.trim()) return json2(400, { error: "Write a header or some text first." });
    notes.push({ id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title, body, pinned: false, at: now, upd: now });
  } else if (b.op === "edit" && n) {
    n.title = title;
    n.body = body;
    n.upd = now;
  } else if (b.op === "pin" && n) {
    n.pinned = !!b.pinned;
  } else if (b.op === "del" && n) {
    notes.splice(notes.indexOf(n), 1);
  } else return json2(400, { error: "Please refresh the page." });
  await env.APA_KV.put(KEY, JSON.stringify(notes));
  return json2(200, { notes });
}
__name(handlePn, "handlePn");
var UI = String.raw`(function(){
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

// src/index.js
var ATT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv"
};
var PUBLIC_ASSETS = /* @__PURE__ */ new Set([
  "/apa_app_shell",
  "/apa_app_shell.html",
  "/logo2.jpg",
  "/logo1.png",
  "/Logo.png",
  "/Logo-transparent.png",
  "/logo2-transparent.png"
]);
var CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");
function secure(resp, isApi) {
  const r = new Response(resp.body, resp);
  const h = r.headers;
  h.set("Content-Security-Policy", CSP);
  h.set("X-Frame-Options", "DENY");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  if (isApi) h.set("Cache-Control", "no-store");
  return r;
}
__name(secure, "secure");
function json3(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
__name(json3, "json");
function errorResponse(e) {
  return json3(e.status || 500, { error: e.message || "Server error" });
}
__name(errorResponse, "errorResponse");
async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  if ((path.startsWith("/api/") || path.startsWith("/attachments/")) && method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json3(403, { error: "Cross-site request blocked." });
  }
  if (path === "/api/login" && method === "POST") return handleLogin(request, env);
  if (path === "/api/logout" && method === "POST") return handleLogout(request, env);
  if (path === "/api/me" && method === "GET") return handleMe(request, env);
  if (path === "/api/team" && method === "GET") return handleTeam(request, env);
  if (path === "/api/signoffs" && method === "GET") return handleGetSignoffs(request, env, url);
  if (path === "/api/signoffs/stats" && method === "GET") return handleSignoffStats(request, env, url);
  if (path === "/api/signoffs" && method === "POST") return handlePostSignoff(request, env);
  if (path === "/api/signoff-tasks" && method === "POST") return handlePostSignoffTasks(request, env);
  if (path === "/api/extras.js" && method === "GET") return handleExtras(request, env);
  if (path === "/api/pn") return handlePn(request, env);
  let m = path.match(/^\/api\/data\/([\w-]+)$/);
  if (m && m[1] === "users" && method === "GET") return handleGetUsers(request, env);
  if (m && m[1] === "users" && method === "POST") return handlePostUsers(request, env);
  if (m && method === "GET") return handleGet(request, env, m[1]);
  if (m && method === "POST") return handlePost(request, env, m[1]);
  m = path.match(/^\/api\/upload\/([\w.-]+)$/);
  if (m && method === "POST") return handleUpload(request, env, m[1]);
  if (path === "/api/audit/export" && method === "GET") return handleAuditExport(request, env);
  if (path.startsWith("/api/")) return json3(404, { error: "not found" });
  m = path.match(/^\/attachments\/([\w.-]+)\/([\w.-]+)$/);
  if (m && method === "GET") {
    await requireSession(request, env);
    const bytes = await readFile(env, m[1], m[2]);
    if (!bytes) return json3(404, { error: "not found" });
    const ext = (m[2].match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
    return new Response(bytes, { status: 200, headers: {
      "Content-Type": ATT_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "private, max-age=86400"
    } });
  }
  if (path === "/" || path === "/index.html") {
    const shellUrl = new URL(request.url);
    shellUrl.pathname = "/apa_app_shell";
    const resp = await env.ASSETS.fetch(new Request(shellUrl, request));
    return new Response(resp.body, {
      status: resp.status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }
    });
  }
  if ((method === "GET" || method === "HEAD") && PUBLIC_ASSETS.has(path)) return env.ASSETS.fetch(request);
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}
__name(route, "route");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/attachments/");
    let resp;
    try {
      resp = await route(request, env, url);
    } catch (e) {
      resp = errorResponse(e);
    }
    return secure(resp, isApi);
  }
};

// ../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-B6k1Fo/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-B6k1Fo/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
