// Single Cloudflare Worker entrypoint: serves the static app shell and every
// /api/* route. Replaces the old api/ folder (Azure Functions) entirely.
//
// Security layers (2026-09-30):
//  1. Only the app page and its logos are public (PUBLIC_ASSETS below; .assetsignore
//     also keeps everything else out of the upload). Data exports, docs, scripts,
//     logs and server code in the repo are never served.
//  2. Every response gets browser security headers (CSP, no framing, no sniffing,
//     HTTPS-only, no referrer leaks); API responses are never cached.
//  3. State-changing API calls must come from this site (Origin check) -- on top of
//     the SameSite=Strict session cookie.
//  4. Logins lock out after repeated failures (routes/auth-routes.js).
import { handleGet, handlePost } from "./routes/data.js";
import { handleUpload } from "./routes/upload.js";
import { handleAuditExport } from "./routes/audit-export.js";
import { handleLogin, handleLogout, handleMe } from "./routes/auth-routes.js";
import { handleGetUsers, handlePostUsers, handleTeam } from "./routes/users.js";
import { handleGetSignoffs, handlePostSignoff, handlePostSignoffTasks, handleSignoffStats } from "./routes/signoffs.js";
import { handleExtras, handlePn } from "./routes/pnotes.js";
import { readFile } from "./kvClient.js";
import { requireSession } from "./auth.js";

// Photos and PDFs open in the browser instead of downloading as raw bytes.
const ATT_TYPES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv",
};

const PUBLIC_ASSETS = new Set([
  "/apa_app_shell", "/apa_app_shell.html",
  "/logo2.jpg", "/logo1.png", "/Logo.png", "/Logo-transparent.png", "/logo2-transparent.png",
]);

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
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

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function errorResponse(e) {
  return json(e.status || 500, { error: e.message || "Server error" });
}

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // Writes must come from this site (blocks cross-site form/fetch attacks).
  if ((path.startsWith("/api/") || path.startsWith("/attachments/")) && method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json(403, { error: "Cross-site request blocked." });
  }

  // --- auth ---
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

  // --- generic entity data (leads/providers/notifications/audit/accepted-insurances/training/hiring/tasks) ---
  // "users" is special-cased to the dedicated admin-only handlers (routes/users.js)
  // rather than the generic create/update/delete in routes/data.js, since it needs
  // password hashing and must never return password hashes to the client.
  let m = path.match(/^\/api\/data\/([\w-]+)$/);
  if (m && m[1] === "users" && method === "GET") return handleGetUsers(request, env);
  if (m && m[1] === "users" && method === "POST") return handlePostUsers(request, env);
  if (m && method === "GET") return handleGet(request, env, m[1]);
  if (m && method === "POST") return handlePost(request, env, m[1]);

  // --- attachments ---
  m = path.match(/^\/api\/upload\/([\w.-]+)$/);
  if (m && method === "POST") return handleUpload(request, env, m[1]);

  if (path === "/api/audit/export" && method === "GET") return handleAuditExport(request, env);
  if (path.startsWith("/api/")) return json(404, { error: "not found" });

  m = path.match(/^\/attachments\/([\w.-]+)\/([\w.-]+)$/);
  if (m && method === "GET") {
    await requireSession(request, env);   // LOAs and provider photos are for signed-in staff only
    const bytes = await readFile(env, m[1], m[2]);
    if (!bytes) return json(404, { error: "not found" });
    const ext = (m[2].match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
    return new Response(bytes, { status: 200, headers: {
      "Content-Type": ATT_TYPES[ext] || "application/octet-stream", "Cache-Control": "private, max-age=86400" } });
  }

  // apa_app_shell.html is the single source of truth for the frontend, served at "/".
  // Requested extension-less (the assets binding redirects "/apa_app_shell.html" there anyway).
  if (path === "/" || path === "/index.html") {
    const shellUrl = new URL(request.url);
    shellUrl.pathname = "/apa_app_shell";
    const resp = await env.ASSETS.fetch(new Request(shellUrl, request));
    return new Response(resp.body, {
      status: resp.status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }

  // --- everything else: only the allow-listed public files ---
  if ((method === "GET" || method === "HEAD") && PUBLIC_ASSETS.has(path)) return env.ASSETS.fetch(request);
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}

export default {
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
  },
};
