// Ported from api/data-get/index.js + api/data-save/index.js (Azure Functions).
// Business logic, validation, and audit-summary text are unchanged -- only
// the storage calls now go through kvClient (Workers KV) instead of
// blobClient (Azure Blob Storage), and admin-only gating is added for the
// "audit" entity (new -- Azure version had no role tiers).
import {
  readJson, writeJson, appendAudit, readAuditAll,
  readLeads, readLeadsRaw, writeLeadsSplit, writeLeadsDynamicPatch,
} from "../kvClient.js";
import { requireSession, requireAdmin } from "../auth.js";

const ID_FIELD = { leads: "i", providers: "id", notifications: "id", training: "id", hiring: "id", tasks: "id", insdir: "id" };

async function handleGet(req, env, entity) {
  if (entity === "audit") {
    await requireAdmin(req, env);
  } else {
    await requireSession(req, env);
  }
  if (entity === "leads") {
    // Both KV blobs are stitched together as strings (no JSON.parse/stringify);
    // the browser merges static + dynamic by id.
    const [s, d] = await readLeadsRaw(env);
    return new Response('{"split":1,"s":' + (s || "[]") + ',"d":' + (d || "[]") + "}", {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  const data = entity === "audit" ? await readAuditAll(env) : await readJson(env, entity);
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function handlePost(req, env, entity) {
  if (entity === "audit") {
    return new Response(JSON.stringify({ error: "audit is append-only via other actions" }), { status: 400 });
  }
  const user = await requireSession(req, env);
  const idField = ID_FIELD[entity];
  if (!idField) return new Response(JSON.stringify({ error: "Unknown entity: " + entity }), { status: 400 });

  const body = await req.json().catch(() => ({}));
  const record = body.record;
  const action = body.action; // 'create' | 'update' | 'delete'
  if (!record || !action) return new Response(JSON.stringify({ error: "record and action are required" }), { status: 400 });
  if (action !== "create" && action !== "update" && action !== "delete") {
    return new Response(JSON.stringify({ error: "action must be create/update/delete" }), { status: 400 });
  }

  // required-field rule for brand-new leads only: email + phone + website.
  // Does NOT apply to "update" -- that covers partial patches (a note, a
  // status change, an attachment, insurance details) which legitimately
  // don't carry contact fields; full-edit validation already happens
  // client-side in the Edit-lead modal before it calls this endpoint.
  if (entity === "leads" && action === "create") {
    if (!record.em || !record.ph || !record.w) {
      return new Response(JSON.stringify({ error: "Email, phone, and website are all required." }), { status: 422 });
    }
  }

  let summary = null, logIt = true;
  if (entity === "leads") {
    // Split storage: every update/delete is written as an overlay into the
    // small "leads_dynamic" blob (merged over leads_static on read), so edits
    // never parse or rewrite the ~1.5 MB static blob. Only "create" does a
    // full read+rewrite -- which also folds any overlays back into static.
    const leadName = record._n, leadBefore = record._before || {};
    delete record._n; delete record._before; delete record.sh;   // status history is written here only
    const patch = action === "delete" ? { deleted: true } : record;
    if (action !== "create") {
      const found = await writeLeadsDynamicPatch(env, record[idField], patch, (prev) => {
        const name = leadName || prev.n || "Lead #" + record[idField];
        if (action !== "delete" && patch.st) {   // one entry per status change, dated in California time (contacted-per-day report)
          const was = Object.assign({}, leadBefore, prev);
          if (patch.st !== (was.st || "new")) {
            const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
            const hist = Array.isArray(prev.sh) ? prev.sh.slice()
              : was.st && was.st !== "new" && was.sd ? [{ s: was.st, d: String(was.sd).slice(0, 10), by: was.sa || "" }] : [];
            hist.push({ s: patch.st, d: day, by: user.name || "" });
            patch.sh = hist.slice(-40); patch.sd = day;
          }
        }
        if (action === "delete") { summary = name + ": hidden from the list"; return; }
        const changes = describeChanges(Object.assign({}, leadBefore, prev), patch);
        // Lead saves are always stored (never risk losing one); only real changes are logged.
        if (!changes.length) { logIt = false; return; }
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
      summary = "New lead \"" + (record.n || "") + "\" added (email " + (record.em || "-") + ", phone " + (record.ph || "-") + ", website " + (record.w || "-") + ")";
    }
  } else {
    summary = null;
    const list = await readJson(env, entity);
    const idx = list.findIndex((x) => String(x[idField]) === String(record[idField]));
    const before = idx === -1 ? null : Object.assign({}, list[idx]);

    // Tasks: team leaders (admin / super admin) add, assign, edit and delete. Agents may
    // only close their own tasks and write the agent note -- enforced here, not just in the UI.
    let rec = record;
    if (entity === "tasks" && user.role !== "admin" && user.role !== "superadmin") {
      if (action !== "update") return new Response(JSON.stringify({ error: "Only team leaders can add or delete tasks." }), { status: 403 });
      if (idx === -1) return new Response(JSON.stringify({ error: "Record not found" }), { status: 404 });
      if (String(list[idx].assignee || "") !== String(user.name || "")) {
        return new Response(JSON.stringify({ error: "You can only update tasks assigned to you." }), { status: 403 });
      }
      rec = { [idField]: record[idField] };
      ["completed", "completedAt", "agentNote"].forEach((k) => { if (k in record) rec[k] = record[k]; });
    }
    // Insurance directory: leaders edit everything; agents only the status, latest update and notes of their own rows.
    if (entity === "insdir" && user.role !== "admin" && user.role !== "superadmin") {
      if (action !== "update") return new Response(JSON.stringify({ error: "Only team leaders can add or delete directory rows." }), { status: 403 });
      if (idx === -1) return new Response(JSON.stringify({ error: "Record not found" }), { status: 404 });
      if (String(list[idx].agent || "") !== String(user.name || "")) {
        return new Response(JSON.stringify({ error: "You can only update organizations assigned to you." }), { status: 403 });
      }
      rec = { [idField]: record[idField] };
      ["status", "upd", "notes"].forEach((k) => { if (k in record) rec[k] = record[k]; });
    }

    if (action === "create") {
      if (record[idField] == null || record[idField] === "") {
        record[idField] = entity + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      }
      list.push(record);
      summary = recordLabel(entity, record) + " created" +
        (entity === "tasks" ? (record.deadline ? ", deadline " + record.deadline : "") + (record.priority ? ", priority " + record.priority : "") : "");
    } else if (action === "update") {
      if (idx === -1) return new Response(JSON.stringify({ error: "Record not found" }), { status: 404 });
      const changes = describeChanges(before, rec);
      // A repeated click or an unchanged form: nothing to store, nothing to log.
      if (!changes.length) return new Response(JSON.stringify({ ok: true, id: record[idField], unchanged: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      summary = (recordLabel(entity, before) || String(record[idField])) + ": " + changes.join("; ");
      if (summary.length > 900) summary = summary.slice(0, 897) + "...";
      list[idx] = Object.assign({}, list[idx], rec);
    } else if (action === "delete") {
      if (idx === -1) return new Response(JSON.stringify({ error: "Record not found" }), { status: 404 });
      list[idx].deleted = true; // soft delete -- audit trail keeps history
      summary = (recordLabel(entity, before) || String(record[idField])) + " deleted";
    }
    await writeJson(env, entity, list);
  }

  if (!logIt) return new Response(JSON.stringify({ ok: true, id: record[idField], unchanged: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  await appendAudit(env, {
    entity: entity.replace(/s$/, ""), entityId: record[idField], action,
    user: user.name, summary,
  });

  return new Response(JSON.stringify({ ok: true, id: record[idField] }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ---- Audit wording: name the record and list exactly which fields changed (old -> new).
const STEP_NAMES = ["Receive Candidate CVs", "Review CVs", "Verify License + DEA", "Clinical Review", "Schedule Interview",
  "Send Zoom Invite", "Coordinate Schedule", "Post-Interview Decision", "Send Offer Letter", "Onboarding & Credentialing",
  "Website Information & Software Setup", "Schedule Training", "Microsoft Teams Setup", "Send Training Invites",
  "Send PECOS/NPPES Surrogacy Request", "Finalize Start Date & IT Access", "Announce Hire"];
const FIELD_LABELS = { task: "task", tlNote: "TL note", agentNote: "agent note", assignee: "assigned to", priority: "priority",
  date: "task date", deadline: "deadline", completedAt: "completed on", cvDate: "CV received", expectedStart: "expected start",
  nextDue: "next action due", hold: "stage override", start: "start time", note: "booking note" };
const STATUS_LABELS = { new: "Not started", contacted: "Emailed", applied: "Applied", talking: "In progress",
  contracted: "Contracted", covered: "Already covered", declined: "Declined", invalid: "Invalid" };
Object.assign(FIELD_LABELS, { n: "name", t: "type", em: "email", ph: "phone", fx: "fax", w: "website", ad: "address",
  grp: "group", ch: "contact channel", chan: "source", insurance: "insurance", providerName: "provider",
  trainingTitle: "training", trainer: "trainer", location: "location", time: "time", notes: "notes", bio: "provider's bio",
  lobs: "lines of business", effectiveDate: "effective date" });
function listDiff(label, a, b, keyOf) {
  const was = (Array.isArray(a) ? a : []).map(keyOf).map(String), now = (Array.isArray(b) ? b : []).map(keyOf).map(String);
  const added = now.filter((x) => !was.includes(x)), removed = was.filter((x) => !now.includes(x)), out = [];
  if (added.length) out.push(label + " added: " + added.map((x) => "\"" + short(x) + "\"").join(", "));
  if (removed.length) out.push(label + " removed: " + removed.map((x) => "\"" + short(x) + "\"").join(", "));
  return out;
}
const norm = (v) => (v == null || v === "" || v === false ? "" : JSON.stringify(v));
const short = (v) => { const s = v == null || v === "" ? "(empty)" : Array.isArray(v) ? (v.length ? v.join(", ") : "(empty)") : typeof v === "object" ? JSON.stringify(v) : String(v); return s.length > 80 ? s.slice(0, 77) + "..." : s; };

function recordLabel(entity, r) {
  if (!r) return "";
  if (entity === "tasks") return "Task \"" + short(r.task) + "\"" + (r.assignee ? " (" + r.assignee + ")" : "");
  if (entity === "insdir") return "Directory #" + (r.no || r.id) + (r.org ? " " + r.org : "");
  if (entity === "training") return (r.providerName || "") + " - " + (r.trainingTitle || "") + " training";
  if (entity === "hiring" && r.kind && r.kind !== "candidate") return (r.name || "") + " - " + r.kind + " booking";
  return r.n || r.name || "";
}

function describeChanges(before, after) {
  const out = [];
  for (const k of Object.keys(after)) {
    if (k === "id" || k === "i" || k === "kind" || k === "sh") continue;
    if (k === "deleted") { if (norm(before && before[k]) !== norm(after[k])) out.push(after[k] ? "hidden" : "restored to the list"); continue; }
    const a = before ? before[k] : undefined, b = after[k];
    if (k === "steps" && Array.isArray(b)) {
      const was = Array.isArray(a) ? a : [], on = [], off = [];
      b.forEach((v, i) => { if (!!v !== !!was[i]) (v ? on : off).push((i + 1) + ". " + (STEP_NAMES[i] || "step")); });
      if (on.length) out.push("checked " + on.join(", "));
      if (off.length) out.push("unchecked " + off.join(", "));
      continue;
    }
    if (k === "sd" || k === "sa" || norm(a) === norm(b)) continue;
    if (k === "st") { out.push("status: \"" + (STATUS_LABELS[a] || short(a)) + "\" -> \"" + (STATUS_LABELS[b] || short(b)) + "\""); continue; }
    if (k === "notesLog") { out.push(...listDiff("note", a, b, (x) => x && x.text)); continue; }
    if (k === "attachments") { out.push(...listDiff("attachment", a, b, (x) => x && x.name)); continue; }
    if (k === "people") { out.push(...listDiff("contact", a, b, (x) => x && [x.name, x.title, x.email].filter(Boolean).join(", "))); continue; }
    if (k === "photo") { out.push(b ? "photo changed" : "photo removed"); continue; }
    if (b && typeof b === "object" && !Array.isArray(b)) {
      const was = a && typeof a === "object" ? a : {};
      for (const f of new Set([...Object.keys(was), ...Object.keys(b)])) {
        if (norm(was[f]) !== norm(b[f])) out.push((FIELD_LABELS[k] || k) + " " + (FIELD_LABELS[f] || f) + ": \"" + short(was[f]) + "\" -> \"" + short(b[f]) + "\"");
      }
      continue;
    }
    if (k === "completed") { out.push(b ? "marked the task done" : "reopened the task"); continue; }
    if (k === "completedAt" && "completed" in after) continue;
    out.push((FIELD_LABELS[k] || k) + ": \"" + short(a) + "\" -> \"" + short(b) + "\"");
  }
  return out;
}

export { handleGet, handlePost };
