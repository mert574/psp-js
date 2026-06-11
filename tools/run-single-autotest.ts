/** Run one pspautotest and print the full actual vs expected output side by side.
 *  Usage: npx tsx tools/run-single-autotest.ts gpu/ge/break */
import { runAutotest } from "../test/pspautotests/run-autotest.js";

const name = process.argv[2];
if (!name) {
  console.error("usage: npx tsx tools/run-single-autotest.ts <test/path>");
  process.exit(1);
}

const base = `ppsspp-reference/pspautotests/tests/${name}`;
const result = await runAutotest(`${base}.prx`, `${base}.expected`);

const actualLines = result.actual.split("\n");
const expectedLines = result.expected.split("\n");
const maxLen = Math.max(actualLines.length, expectedLines.length);
for (let i = 0; i < maxLen; i++) {
  const a = actualLines[i] ?? "<missing>";
  const e = expectedLines[i] ?? "<missing>";
  const mark = a === e ? " " : "✘";
  console.log(`${mark} ${String(i + 1).padStart(3)} | ${e.padEnd(60)} | ${a}`);
}
console.log(`\npassed: ${result.passed} (${result.frames} frames)`);
