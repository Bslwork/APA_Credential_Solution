const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const [namespaceId] = process.argv.slice(2);

if (!namespaceId) throw new Error("Namespace ID is required.");

const wrangler = process.env.APPDATA + "\\npm\\wrangler.cmd";
const keysFile = path.resolve("kv-keys.json");
const root = path.resolve("backup");

const keys = JSON.parse(
  fs.readFileSync(keysFile, "utf8").replace(/^\uFEFF/, "")
);

const records = keys.filter(x => !x.name.startsWith("attachments:"));

const manifests = { json: [], audit: [] };
const failures = [];

for (let i = 0; i < records.length; i++) {
  const key = records[i].name;
  const isAudit = key.startsWith("audit-") || key.startsWith("audit:");
  const category = isAudit ? "audit" : "json";
  const folder = path.join(root, category);

  fs.mkdirSync(folder, { recursive: true });

  const filename = `${String(i + 1).padStart(3, "0")}.json`;
  const output = path.join(folder, filename);

  try {
    const data = execFileSync(
      "cmd.exe",
      [
        "/d", "/c", wrangler,
        "kv", "key", "get", key,
        `--namespace-id=${namespaceId}`,
        "--remote"
      ],
      { encoding: "buffer", maxBuffer: 100 * 1024 * 1024 }
    );

    if (!data || data.length === 0) {
      throw new Error("Empty response");
    }

    // Validate UTF-8 JSON without modifying the original bytes.
    const value = data.toString("utf8").replace(/^\uFEFF/, "");
    JSON.parse(value);

    fs.writeFileSync(output, data);

    manifests[category].push({
      key,
      filename,
      bytes: data.length
    });

    console.log(`[${i + 1}/${records.length}] Saved ${category}/${filename}`);
  } catch (error) {
    failures.push({ key, error: error.message });
    console.log(`[${i + 1}/${records.length}] FAILED: ${key}`);
  }
}

for (const category of ["json", "audit"]) {
  fs.writeFileSync(
    path.join(root, category, "manifest.json"),
    JSON.stringify(manifests[category], null, 2)
  );
}

fs.writeFileSync(
  path.join(root, "export-failures.json"),
  JSON.stringify(failures, null, 2)
);

console.log("\n--- Export summary ---");
console.log(`JSON: ${manifests.json.length}`);
console.log(`Audit: ${manifests.audit.length}`);
console.log(`Failed: ${failures.length}`);
console.log(
  `Total bytes: ${
    [...manifests.json, ...manifests.audit].reduce((s, x) => s + x.bytes, 0)
  }`
);
