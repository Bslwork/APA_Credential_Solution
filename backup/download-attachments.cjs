const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const [namespaceId] = process.argv.slice(2);

if (!namespaceId) {
  throw new Error("Namespace ID is required.");
}

const wrangler = process.env.APPDATA + "\\npm\\wrangler.cmd";
const keysFile = path.resolve("kv-keys.json");
const outputDir = path.resolve("backup", "attachments");

fs.mkdirSync(outputDir, { recursive: true });

const allKeys = JSON.parse(fs.readFileSync(keysFile, "utf8").replace(/^\uFEFF/, ""));
const attachments = allKeys.filter(x => x.name.startsWith("attachments:"));

const manifest = [];
const failures = [];

console.log(`Found ${attachments.length} attachments.`);

for (let i = 0; i < attachments.length; i++) {
  const key = attachments[i].name;
  const originalName = key.split(":").pop();
  const ext = path.extname(originalName) || ".bin";
  const filename = `${String(i + 1).padStart(3, "0")}${ext}`;
  const output = path.join(outputDir, filename);

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

    fs.writeFileSync(output, data);

    manifest.push({
      key,
      filename,
      originalName,
      bytes: data.length
    });

    console.log(`[${i + 1}/${attachments.length}] Saved ${filename} (${data.length} bytes)`);
  } catch (error) {
    failures.push({ key, error: error.message });
    console.log(`[${i + 1}/${attachments.length}] FAILED: ${key}`);
  }
}

fs.writeFileSync(
  path.join(outputDir, "manifest.json"),
  JSON.stringify(manifest, null, 2)
);

fs.writeFileSync(
  path.join(outputDir, "failures.json"),
  JSON.stringify(failures, null, 2)
);

console.log("\n--- Export summary ---");
console.log(`Successful: ${manifest.length}`);
console.log(`Failed: ${failures.length}`);
console.log(`Total bytes: ${manifest.reduce((sum, x) => sum + x.bytes, 0)}`);

