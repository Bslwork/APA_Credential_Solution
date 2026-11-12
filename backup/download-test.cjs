const fs = require("fs");
const { execFileSync } = require("child_process");

const [namespaceId, key, output] = process.argv.slice(2);
const wrangler = process.env.APPDATA + "\\npm\\wrangler.cmd";

const result = execFileSync(
  "cmd.exe",
  [
    "/d",
    "/c",
    wrangler,
    "kv", "key", "get", key,
    `--namespace-id=${namespaceId}`,
    "--remote"
  ],
  { encoding: "buffer", maxBuffer: 100 * 1024 * 1024 }
);

if (!result || result.length === 0) {
  throw new Error("Empty response; no file was saved.");
}

fs.writeFileSync(output, result);
console.log(`Saved successfully: ${result.length} bytes`);
