// New: "Manage Users" CRUD, admin-only. Mirrors the leads/providers
// create/update/delete pattern in routes/data.js, but never returns password
// hashes/salts to the client, and hashes any submitted plaintext password
// before storing it.
import { readJson, writeJson, appendAudit } from "../kvClient.js";
import { requireAdmin, hashPassword, isAdminLike, requireSession } from "../auth.js";

// Accounts may only be created for (or moved to) the company's own domain.
const COMPANY_DOMAIN = "@advancedpsychiatryassociates.com";
function isCompanyEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@advancedpsychiatryassociates\.com$/.test(e);
}
const DOMAIN_ERROR = "Only " + COMPANY_DOMAIN + " email addresses can be used for accounts.";
// New or changed passwords: at least 10 characters with letters and numbers.
function weakPassword(p) {
  const s = String(p || "");
  if (s.length < 10 || !/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return "Password must be at least 10 characters and include letters and numbers.";
  return "";
}

function publicView(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, deleted: !!u.deleted };
}

async function handleGetUsers(req, env) {
  await requireAdmin(req, env);
  const users = await readJson(env, "users");
  return new Response(JSON.stringify(users.filter((u) => !u.deleted).map(publicView)), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

// Team list for any signed-in user (who tasks can be assigned to) -- names and roles only.
async function handleTeam(req, env) {
  await requireSession(req, env);
  const users = await readJson(env, "users");
  return new Response(JSON.stringify(users.filter((u) => !u.deleted).map((u) => ({ name: u.name, role: u.role }))), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

function resolveRole(requestedRole, actingIsSuperAdmin) {
  if (requestedRole === "superadmin") return actingIsSuperAdmin ? "superadmin" : "admin";
  return requestedRole === "admin" ? "admin" : "user";
}

async function handlePostUsers(req, env) {
  const session = await requireAdmin(req, env);
  const actingIsSuperAdmin = session.role === "superadmin";
  const body = await req.json().catch(() => ({}));
  const record = body.record;
  const action = body.action; // 'create' | 'update' | 'delete'
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
      name: record.name, email: emailKey, role: resolveRole(record.role, actingIsSuperAdmin),
      passwordHash: hash, salt, deleted: false,
    };
    users.push(newUser);
    await writeJson(env, "users", users);
    await appendAudit(env, { entity: "user", entityId: newUser.id, action: "create", user: session.name,
      summary: "Account created for " + newUser.name + " (" + newUser.email + "), role " + newUser.role });
    return new Response(JSON.stringify({ ok: true, id: newUser.id }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (idx === -1) return new Response(JSON.stringify({ error: "User not found" }), { status: 404 });

  // A super admin's own account is untouchable by a plain admin -- not the
  // name, email, password, role, or the account itself. Only another super
  // admin (or the super admin acting on themselves, which is the same
  // condition since only a super admin session has actingIsSuperAdmin true)
  // can change or delete it.
  if (users[idx].role === "superadmin" && !actingIsSuperAdmin) {
    return new Response(JSON.stringify({ error: "Only a super admin can change or delete a super admin's account." }), { status: 403 });
  }

  if (action === "update") {
    const target = users[idx];
    const isSelf = String(target.id) === String(session.uid);
    // Only a super admin can change the password of another admin.
    // Anyone (any role) can always change their own password.
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
      updated.passwordHash = hash; updated.salt = salt;
    }
    const ch = [];
    ["name", "email", "role"].forEach((k) => { if (String(target[k] || "") !== String(updated[k] || "")) ch.push(k + ": \"" + (target[k] || "") + "\" -> \"" + updated[k] + "\""); });
    if (record.password) ch.push("password changed");
    if (!ch.length) return new Response(JSON.stringify({ ok: true, id: updated.id, unchanged: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    users[idx] = updated;
    await writeJson(env, "users", users);
    await appendAudit(env, { entity: "user", entityId: updated.id, action: "update", user: session.name,
      summary: "Account " + target.name + " (" + target.email + "): " + ch.join("; ") });
    return new Response(JSON.stringify({ ok: true, id: updated.id }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (action === "delete") {
    users[idx].deleted = true; // soft delete, consistent with leads/providers -- self-delete is allowed
    await writeJson(env, "users", users);
    await appendAudit(env, { entity: "user", entityId: users[idx].id, action: "delete", user: session.name,
      summary: "Account removed: " + users[idx].name + " (" + users[idx].email + ")" });
    return new Response(JSON.stringify({ ok: true, id: users[idx].id }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "action must be create/update/delete" }), { status: 400 });
}

export { handleGetUsers, handlePostUsers, handleTeam };
