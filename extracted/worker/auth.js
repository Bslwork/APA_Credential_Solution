// Custom auth: replaces Azure Static Web Apps' built-in identity (x-ms-client-
// principal) since Cloudflare Access/Zero Trust would require a card on file.
// Session tokens are stateless, HMAC-signed cookies -- no session store, no
// database, matching the rest of the app's "no real backend" philosophy.
// Password hashing uses PBKDF2 via the Workers runtime's native Web Crypto
// (SubtleCrypto) -- no external dependency.

const SESSION_COOKIE = "apa_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours, matches the plan

function b64urlEncode(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

async function signSession(payload, secret) {
  const json = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(new TextEncoder().encode(json));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return payloadB64 + "." + b64urlEncode(sig);
}

async function verifySession(token, secret) {
  if (!token || token.indexOf(".") === -1) return null;
  const [payloadB64, sigB64] = token.split(".");
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC", key, b64urlDecode(sigB64), new TextEncoder().encode(payloadB64)
  );
  if (!valid) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
  } catch (e) {
    return null;
  }
  if (!payload.exp || Date.now() / 1000 > payload.exp) return null;
  return payload; // {uid, name, role, exp}
}

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

function sessionCookieHeader(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}
function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

async function getSession(req, env) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return verifySession(token, env.SESSION_SECRET);
}

async function requireSession(req, env) {
  const session = await getSession(req, env);
  if (!session) {
    const err = new Error("Not signed in.");
    err.status = 401;
    throw err;
  }
  return session; // {uid, name, role}
}

function isAdminLike(role) {
  return role === "admin" || role === "superadmin";
}

async function requireAdmin(req, env) {
  const session = await requireSession(req, env);
  if (!isAdminLike(session.role)) {
    const err = new Error("Admin access required.");
    err.status = 403;
    throw err;
  }
  return session;
}

// PBKDF2 password hashing -- per-user random salt, 100k iterations, SHA-256.
// Encoded as hex (not base64url) specifically so stored hash/salt values are
// interoperable with seed_users.py and local_dev_server.py, which both use
// Python's straightforward hashlib.pbkdf2_hmac(...).hex() -- the actual
// algorithm (PBKDF2-HMAC-SHA256, 100k iterations, 256-bit output) is
// identical either way, only the string encoding needs to match.
function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256
  );
  return { hash: bytesToHex(bits), salt: bytesToHex(salt) };
}

async function verifyPassword(password, hashHex, saltHex) {
  const { hash } = await hashPassword(password, saltHex);
  // constant-time-ish compare
  if (hash.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

export {
  signSession, verifySession, getSession, requireSession, requireAdmin, isAdminLike,
  sessionCookieHeader, clearSessionCookieHeader, hashPassword, verifyPassword,
  SESSION_TTL_SECONDS,
};
