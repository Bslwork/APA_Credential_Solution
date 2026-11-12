const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve("backup");
const persistence = path.resolve(".wrangler", "local-data");
const wrangler = process.env.APPDATA + "\\npm\\wrangler.cmd";

const groups = ["json", "audit", "attachments"];

let success = 0;
const failed = [];

for (const group of groups) {
  const dir = path.join(root, group);
  const manifestPath = path.join(dir, "manifest.json");

  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, "")
  );

  for (const item of manifest) {
    const file = path.join(dir, item.filename);

    if (!fs.existsSync(file)) {
      failed.push(`${group}: missing ${item.filename}`);
      console.log(`FAILED: Missing ${item.filename}`);
      continue;
    }

    const result = spawnSync(
      "cmd.exe",
      [
        "/d", "/c", wrangler,
        "kv", "key", "put", item.key,
        "--path", file,
        "--binding", "APA_KV",
        "--local",
        "--persist-to", persistence
      ],
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
      }
    );

    if (result.status !== 0) {
      failed.push({
        group,
        key: item.key,
        error: result.stderr || result.stdout || "Unknown error"
      });

      console.log(`FAILED: ${group}/${item.filename}`);
    } else {
      success++;
      console.log(`[${success}/288] Restored ${group}/${item.filename}`);
    }
  }
}

fs.writeFileSync(
  path.join(root, "restore-failures.json"),
  JSON.stringify(failed, null, 2)
);

console.log("\n========== RESTORE SUMMARY ==========");
console.log(`Successful: ${success}`);
console.log(`Failed: ${failed.length}`);
console.log(`Total expected: 288`);
console.log("=====================================");
