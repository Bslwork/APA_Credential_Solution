// Ported from api/audit-export/index.js, unchanged logic. Admin-only (new --
// the Azure version had no role tiers; this app now does for Audit/Users).
import { readAuditAll } from "../kvClient.js";
import { requireAdmin } from "../auth.js";

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function handleAuditExport(req, env) {
  await requireAdmin(req, env);
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ? new Date(url.searchParams.get("from")) : null;
  const to = url.searchParams.get("to") ? new Date(url.searchParams.get("to")) : null;
  const who = url.searchParams.get("user") || "";   // optional: only this person's actions
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
    headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=audit-export.csv" },
  });
}

export { handleAuditExport };
