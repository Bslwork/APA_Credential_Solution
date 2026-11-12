// Ported from api/upload/index.js. Stores file bytes as a KV key instead of
// an Azure blob (see kvClient.uploadFile) -- everything stays on Workers KV
// so the whole stack remains free with no card on file (R2 deliberately
// avoided).
//
// The browser sends the raw file as the request body (name in ?name=), so the
// Worker only copies bytes into KV. The old JSON/base64 body is still accepted,
// but decoding base64 byte-by-byte could blow the free plan's 10ms CPU budget
// on a large PDF.
import { uploadFile, appendAudit } from "../kvClient.js";
import { requireSession } from "../auth.js";

const MAX_BYTES = 20 * 1024 * 1024;   // KV values cap at 25 MiB

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
    name, url, uploadedAt: new Date().toISOString(), uploadedBy: user.name,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

export { handleUpload };
