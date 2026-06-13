import { runAutotest } from "../test/pspautotests/run-autotest.js";
const base = "ppsspp-reference/pspautotests/tests/sysmem/sysmem";
const r = await runAutotest(base + ".prx", base + ".expected");
console.log("PASSED:", r.passed);
console.log("--- ACTUAL ---\n" + r.actual);
