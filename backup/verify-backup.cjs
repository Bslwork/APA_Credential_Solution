const fs = require("fs");
const path = require("path");

const root = path.resolve("backup");
const checks = [
  ["JSON", "json", 59],
  ["Audit", "audit", 183],
  ["Attachments", "attachments", 46]
];

let totalFiles = 0;
let totalBytes = 0;
let problems = [];

for (const [label, folder, expected] of checks) {
  const dir = path.join(root, folder);
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  let valid = 0;
  let bytes = 0;

  for (const item of manifest) {
    const file = path.join(dir, item.filename);

    if (!fs.existsSync(file)) {
      problems.push(`${label}: missing ${item.filename}`);
      continue;
    }

    const stat = fs.statSync(file);

    if (stat.size !== item.bytes) {
      problems.push(`${label}: size mismatch ${item.filename}`);
      continue;
    }

    if (folder !== "attachments") {
      try {
        JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      } catch {
        problems.push(`${label}: invalid JSON ${item.filename}`);
        continue;
      }
    }

    valid++;
    bytes += stat.size;
  }

  console.log(`${label}: ${valid}/${expected} valid | ${bytes} bytes`);

  if (manifest.length !== expected) {
    problems.push(`${label}: manifest count mismatch`);
  }

  totalFiles += valid;
  totalBytes += bytes;
}

console.log(`\nTotal valid files: ${totalFiles}/288`);
console.log(`Total bytes: ${totalBytes}`);
console.log(`Problems: ${problems.length}`);

if (problems.length) {
  console.log(problems.join("\n"));
}
