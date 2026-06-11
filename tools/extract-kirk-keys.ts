/**
 * Extract KIRK key vault from PPSSPP's kirk_engine.c and output as TypeScript.
 * Usage: npx tsx tools/extract-kirk-keys.ts > src/crypto/kirk-keys.ts
 */

import { readFileSync } from "fs";

const src = readFileSync("ppsspp-reference/ext/libkirk/kirk_engine.c", "utf8");

// Extract keyvault[0x80][0x10]
const vaultMatch = src.match(/keyvault\[0x80\]\[0x10\]\s*=\s*\{([\s\S]*?)\};/);
if (!vaultMatch) throw new Error("keyvault not found");

const vaultBody = vaultMatch[1]!;
// Match each row: {0x2C, 0x92, ...}
const rowRegex = /\{([^}]+)\}/g;
const rows: number[][] = [];
let m;
while ((m = rowRegex.exec(vaultBody)) !== null) {
  const bytes = m[1]!.split(",").map((s) => parseInt(s.trim(), 16));
  rows.push(bytes);
}

if (rows.length !== 0x80) {
  console.error(`WARNING: Expected 128 rows, got ${rows.length}`);
}

const lines: string[] = [];
lines.push("/**");
lines.push(" * KIRK key vault — auto-generated from PPSSPP ext/libkirk/kirk_engine.c");
lines.push(" * Do not edit by hand. Regenerate with: npx tsx tools/extract-kirk-keys.ts");
lines.push(" */");
lines.push("");
lines.push("export const keyvault: Uint8Array[] = [");
for (const row of rows) {
  const hex = row.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(", ");
  lines.push(`  new Uint8Array([${hex}]),`);
}
lines.push("];");
lines.push("");

process.stdout.write(lines.join("\n"));
