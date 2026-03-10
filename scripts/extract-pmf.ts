/**
 * Extract ICON1.PMF from a PSP ISO and save it as a test fixture.
 * Usage: npx tsx scripts/extract-pmf.ts <path-to-iso> [output-name]
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseIso, readFile } from "../src/iso/iso9660.js";

const isoPath = process.argv[2];
const outputName = process.argv[3] ?? "icon1.pmf";

if (!isoPath) {
  console.error("Usage: npx tsx scripts/extract-pmf.ts <path-to-iso> [output-name]");
  process.exit(1);
}

const buffer = readFileSync(isoPath).buffer;
const volume = parseIso(buffer);

const pspGame = volume.root.children?.find(
  (f) => f.isDirectory && f.name.toUpperCase() === "PSP_GAME"
);
if (!pspGame) { console.error("No PSP_GAME directory"); process.exit(1); }

const pmfEntry = pspGame.children?.find(
  (f) => !f.isDirectory && f.name.toUpperCase() === "ICON1.PMF"
);
if (!pmfEntry) { console.error("No ICON1.PMF found"); process.exit(1); }

const pmfData = readFile(buffer, pmfEntry).slice();
const outPath = join(__dirname, "../test/fixtures", outputName);
writeFileSync(outPath, pmfData);
console.log(`Extracted ${pmfData.byteLength} bytes to ${outPath}`);
