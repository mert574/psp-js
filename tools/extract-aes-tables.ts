/**
 * Extract AES lookup tables from PPSSPP's AES.c and output as TypeScript Uint32Arrays.
 * Usage: npx tsx tools/extract-aes-tables.ts > src/crypto/aes-tables.ts
 */

import { readFileSync } from "fs";

const src = readFileSync("ppsspp-reference/ext/libkirk/AES.c", "utf8");

function extractTable(name: string): number[] {
  // Match: static const u32 Name[256] = { ... };
  const re = new RegExp(`static\\s+const\\s+u32\\s+${name}\\[\\d*\\]\\s*=\\s*\\{([^}]+)\\}`, "s");
  const m = src.match(re);
  if (!m) throw new Error(`Table ${name} not found`);
  const vals = m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      // Handle "0xc66363a5U" format
      s = s.replace(/U$/i, "").trim();
      return parseInt(s, 16);
    });
  return vals;
}

function extractRcon(): number[] {
  const re = /static\s+const\s+u32\s+rcon\[\]\s*=\s*\{([^}]+)\}/s;
  const m = src.match(re);
  if (!m) throw new Error("rcon not found");
  return m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseInt(s.replace(/U$/i, ""), 16));
}

function formatU32Array(name: string, vals: number[]): string {
  const lines: string[] = [];
  lines.push(`export const ${name} = new Uint32Array([`);
  for (let i = 0; i < vals.length; i += 8) {
    const chunk = vals.slice(i, i + 8);
    lines.push("  " + chunk.map((v) => "0x" + v.toString(16).padStart(8, "0")).join(", ") + ",");
  }
  lines.push("]);");
  return lines.join("\n");
}

const tables = ["Te0", "Te1", "Te2", "Te3", "Te4", "Td0", "Td1", "Td2", "Td3", "Td4"];
const output: string[] = [];
output.push("/**");
output.push(" * AES (Rijndael) lookup tables — auto-generated from PPSSPP ext/libkirk/AES.c");
output.push(" * Do not edit by hand. Regenerate with: npx tsx tools/extract-aes-tables.ts");
output.push(" */");
output.push("");

for (const t of tables) {
  output.push(formatU32Array(t, extractTable(t)));
  output.push("");
}

output.push(formatU32Array("rcon", extractRcon()));
output.push("");

process.stdout.write(output.join("\n"));
