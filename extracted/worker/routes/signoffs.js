// Daily sign-off: each agent keeps, per task type and per day, any number of notes plus (for most
// task types) a number answering "how many did you do?". Team leaders see every agent, can write in
// any agent's sign-off (today or a past day), and get a day/month dashboard of the numbers.
// Storage: one small KV key per agent per day ("signoffs:YYYY-MM-DD:<agent>"), so agents saving at
// the same moment never overwrite each other, and past days are never rewritten by anyone else.
import { requireSession } from "../auth.js";
import { readJson, appendSignoffAudit } from "../kvClient.js";

export const SIGNOFF_TASKS = [
  "roster", "pave", "directory", "caqh", "filing", "pecos", "tracking",
  "em-candidate", "em-application", "em-existing", "em-contracted", "leads", "auth", "em-noncontracted",
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const isLeader = (role) => role === "admin" || role === "superadmin";
const todayPacific = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const dayKey = (date, agent) => "signoffs:" + date + ":" + encodeURIComponent(agent);

// Names used in the Audit log ("<task> (sign-off)"); they match the task names on the Daily Sign-off page.
const TASK_NAMES = {
  roster: "Provider Roster", pave: "Provider Enrollment (PAVE)", directory: "Provider Directory", caqh: "Data Management (CAQH Update)",
  filing: "New & Existing Insurance Filing", pecos: "Medicare Enrollment (PECOS)", tracking: "Insurance Tracking Sheet Follow-Up",
  "em-candidate": "Email Inquiries (New Candidate)", "em-application": "Email Inquiries (New Applications)", "em-existing": "Email Inquiries (Existing Providers)",
  "em-contracted": "Email Inquiries (Contracted Insurance)", leads: "Contact New Leads", auth: "Authorization (Surrogacy Auth Requests)",
  "em-noncontracted": "Email Inquiries (Non-Contracted Insurance)",
};
const clip = (t, n) => (t.length > n ? t.slice(0, n - 3) + "..." : t);
const CUSTOM_KEY = "signoff-tasks";   // [{k, label, q?, by, at, deleted?}] -- extra task types added by leaders
async function readCustom(env) {
  const raw = await env.APA_KV.get(CUSTOM_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function readAgentDay(env, date, agent) {   // {task: {agent, task, notes:[{id,text,at,by}], count, at}}
  const raw = await env.APA_KV.get(dayKey(date, agent));
  return raw ? JSON.parse(raw) : {};
}
async function teamNames(env, agentsOnly) {
  const users = await readJson(env, "users");
  return users.filter((u) => !u.deleted && (!agentsOnly || u.role === "user")).map((u) => u.name);
}

// GET /api/signoffs?date=YYYY-MM-DD -> { date, today, entries, custom }. Agents only ever receive their own.
export async function handleGetSignoffs(req, env, url) {
  const me = await requireSession(req, env);
  const date = url.searchParams.get("date") || todayPacific();
  if (!DATE_RE.test(date)) return json(400, { error: "Bad date." });
  const names = isLeader(me.role) ? await teamNames(env, false) : [me.name];
  const days = await Promise.all(names.map((n) => readAgentDay(env, date, n)));
  const entries = [];
  days.forEach((d) => Object.values(d).forEach((e) => entries.push(e)));
  return json(200, { date, today: todayPacific(), entries, custom: await readCustom(env) });
}

// GET /api/signoffs/stats?month=YYYY-MM -> { month, days: {date: {agent: {task: count}}} } -- leaders only.
export async function handleSignoffStats(req, env, url) {
  const me = await requireSession(req, env);
  if (!isLeader(me.role)) return json(403, { error: "Only team leaders can see the dashboard." });
  const today = todayPacific(), month = url.searchParams.get("month") || today.slice(0, 7);
  if (!MONTH_RE.test(month)) return json(400, { error: "Bad month." });
  const [y, mo] = month.split("-").map(Number), last = new Date(Date.UTC(y, mo, 0)).getUTCDate(), dates = [];
  for (let d = 1; d <= last; d++) { const s = month + "-" + String(d).padStart(2, "0"); if (s <= today) dates.push(s); }
  const names = await teamNames(env, true), days = {};
  await Promise.all(dates.flatMap((date) => names.map(async (name) => {
    const d = await readAgentDay(env, date, name);
    Object.values(d).forEach((e) => {
      if (e.count == null) return;
      days[date] = days[date] || {}; days[date][name] = days[date][name] || {}; days[date][name][e.task] = e.count;
    });
  })));
  return json(200, { month, today, days });
}

// POST /api/signoff-tasks {action:"add", label, q?} | {action:"remove", k} -- team leaders only.
// Removed types are only hidden: past days that have notes for them still show them.
export async function handlePostSignoffTasks(req, env) {
  const me = await requireSession(req, env);
  if (!isLeader(me.role)) return json(403, { error: "Only team leaders can change task types." });
  const body = await req.json().catch(() => ({}));
  const list = await readCustom(env);
  if (body.action === "add") {
    const label = String(body.label || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const q = String(body.q || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (label.length < 3) return json(400, { error: "Give the task type a name (at least 3 characters)." });
    if (list.some((c) => !c.deleted && c.label.toLowerCase() === label.toLowerCase())) return json(409, { error: "That task type already exists." });
    list.push({ k: "c-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), label, ...(q ? { q } : {}), by: me.name, at: new Date().toISOString() });
  } else if (body.action === "remove") {
    const c = list.find((x) => x.k === body.k);
    if (!c) return json(404, { error: "Task type not found." });
    c.deleted = true;
  } else return json(400, { error: "Unknown action." });
  await env.APA_KV.put(CUSTOM_KEY, JSON.stringify(list));
  const changed = body.action === "add" ? list[list.length - 1] : list.find((x) => x.k === body.k);
  await appendSignoffAudit(env, todayPacific(), me.name, { entity: "Daily Sign-off task types", entityId: changed.k, action: body.action === "add" ? "create" : "delete",
    user: me.name, summary: (body.action === "add" ? "task type added: \"" + changed.label + "\"" + (changed.q ? " (question: \"" + changed.q + "\")" : "") : "task type removed: \"" + changed.label + "\"") });
  return json(200, { ok: true, custom: list });
}

// POST /api/signoffs {task, op, agent?, date?, text?, id?, count?}
//   op "add" (new note) | "edit" / "del" (a note, by id) | "count" (the number; null clears it)
// Agents: their own sign-off, today only, and only notes they wrote. Leaders: any agent, any day up to today.
export async function handlePostSignoff(req, env) {
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
  const now = new Date().toISOString();
  const text = String(body.text == null ? "" : body.text).replace(/\r/g, "").trim().slice(0, 4000);
  const op = body.op;
  let what = "", act = "update";   // audit wording
  if (op === "add") {
    if (!text) return json(400, { error: "Write the note first." });
    if (e.notes.length >= 60) return json(400, { error: "That is the maximum number of notes for one task in a day." });
    e.notes.push({ id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text, at: now, by: me.name });
    what = "note added: \"" + clip(text, 1500) + "\""; act = "create";
  } else if (op === "edit" || op === "del") {
    const n = e.notes.find((x) => x.id === body.id);
    if (!n) return json(404, { error: "Note not found. Refresh the page." });
    if (!lead && (n.by || agent) !== me.name) return json(403, { error: "You can only change notes you wrote." });
    if (op === "del") { e.notes = e.notes.filter((x) => x !== n); what = "note deleted: \"" + clip(n.text, 1500) + "\""; act = "delete"; }
    else {
      if (!text) return json(400, { error: "A note cannot be empty. Delete it instead." });
      what = "note changed: \"" + clip(n.text, 700) + "\" -> \"" + clip(text, 700) + "\""; n.text = text; n.edited = now;
    }
  } else if (op === "count") {
    const was = e.count;
    if (body.count === null || body.count === "" || body.count === undefined) e.count = null;
    else {
      const c = Number(body.count);
      if (!Number.isInteger(c) || c < 0 || c > 100000) return json(400, { error: "Enter a whole number (0 or more)." });
      e.count = c;
    }
    if (was === e.count) what = "";
    else what = e.count == null ? "number cleared (was " + was + ")" : "number set to " + e.count + (was == null ? "" : " (was " + was + ")");
  } else return json(400, { error: "Please refresh the page to get the latest version." });

  e.at = now; e.agent = agent;
  if (!e.notes.length && e.count == null) delete day[task]; else day[task] = e;
  const key = dayKey(date, agent);
  if (Object.keys(day).length) await env.APA_KV.put(key, JSON.stringify(day));
  else await env.APA_KV.delete(key);
  if (what) {   // every sign-off change also goes to the Audit log, e.g. entity "Provider Roster (sign-off)"
    const name = (custom && custom.label) || TASK_NAMES[task] || task;
    await appendSignoffAudit(env, date, agent, { entity: name + " (sign-off)", entityId: date + ":" + agent + ":" + task, action: act, user: me.name,
      summary: agent + " · " + date + (me.name !== agent ? " (written by " + me.name + ")" : "") + ": " + what });
  }
  return json(200, { ok: true, date, entry: day[task] || null });
}
