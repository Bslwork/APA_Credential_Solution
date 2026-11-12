// New: replaces Azure Static Web Apps' built-in /.auth/me + x-ms-client-
// principal with a custom email+password login, since Cloudflare Access
// would require a card on file.
import { readJson } from "../kvClient.js";
import {
  getSession, signSession, verifyPassword,
  sessionCookieHeader, clearSessionCookieHeader, SESSION_TTL_SECONDS,
} from "../auth.js";

// Brute-force protection: 5 wrong passwords for an account, or 10 failed attempts from
// one IP, lock sign-in for 15 minutes. Counters live in KV with a 15-minute expiry and
// stop being written once locked, so an attacker can't burn the free KV write quota.
const LOCK_MINUTES = 15;
const MAX_PER_ACCOUNT = 5;
const MAX_PER_IP = 10;

async function readCounter(env, key) {
  return (await env.APA_KV.get(key, "json")) || { n: 0 };
}
async function bump(env, key, c) {
  await env.APA_KV.put(key, JSON.stringify({ n: c.n + 1 }), { expirationTtl: LOCK_MINUTES * 60 });
}
function locked() {
  return new Response(JSON.stringify({ error: "Too many failed sign-in attempts. Try again in " + LOCK_MINUTES + " minutes." }),
    { status: 429, headers: { "Retry-After": String(LOCK_MINUTES * 60) } });
}

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
  if (!user || !(await verifyPassword(password, user.passwordHash, user.salt))) {
    const writes = [bump(env, ipKey, ipC)];
    if (user) writes.push(bump(env, acctKey, acctC));   // only real accounts get a counter
    await Promise.all(writes);
    return new Response(JSON.stringify({ error: "Incorrect email or password." }), { status: 401 });
  }
  if (acctC.n > 0) await env.APA_KV.delete(acctKey);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await signSession({ uid: user.id, name: user.name, role: user.role, exp }, env.SESSION_SECRET);
  return new Response(JSON.stringify({ ok: true, name: user.name, role: user.role, uid: user.id }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(token, SESSION_TTL_SECONDS) },
  });
}

async function handleLogout(req, env) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookieHeader() },
  });
}

async function handleMe(req, env) {
  const session = await getSession(req, env);
  if (!session) return new Response(JSON.stringify({ signedIn: false }), { status: 200 });
  return new Response(JSON.stringify({ signedIn: true, name: session.name, role: session.role, uid: session.uid }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

export { handleLogin, handleLogout, handleMe };
