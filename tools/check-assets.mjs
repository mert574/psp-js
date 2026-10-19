import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "assets.json"), "utf8"));
const allowed = new Map();
const errors = [];
for (const asset of manifest.assets) {
  if (allowed.has(asset.path)) errors.push(`Duplicate asset record: ${asset.path}`);
  if (!asset.source || !asset.license || !asset.notice || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    errors.push(`Incomplete source/license record: ${asset.path}`);
  }
  const target = path.resolve(root, asset.path);
  if (!target.startsWith(root) || !existsSync(target)) errors.push(`Missing/invalid asset: ${asset.path}`);
  const notice = path.resolve(root, asset.notice || "");
  if (!notice.startsWith(root) || !existsSync(notice)) errors.push(`Missing notice: ${asset.path}`);
  allowed.set(asset.path, asset);
}

const binaryExtensions = new Set([
  ".iso", ".cso", ".pbp", ".prx", ".bin", ".elf", ".pgf", ".pspstate",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".at3", ".pmf",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".ttf", ".otf", ".woff", ".woff2", ".zip", ".7z",
]);
function walk(relative) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute)) {
    const assetPath = `${relative}/${entry}`;
    const file = path.join(root, assetPath);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      errors.push(`Asset symlinks are not allowed: ${assetPath}`);
    } else if (stat.isDirectory()) {
      walk(assetPath);
    } else if (binaryExtensions.has(path.extname(entry).toLowerCase())
        || ![".txt", ".md"].includes(path.extname(entry).toLowerCase())) {
      const record = allowed.get(assetPath);
      if (!record) {
        errors.push(`Unreviewed distributed asset: ${assetPath}`);
      } else {
        const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
        if (hash !== record.sha256) errors.push(`Asset changed since review: ${assetPath}`);
      }
    }
  }
}
for (const directory of ["public", "docs/public", "src/frontend/fonts"]) walk(directory);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Asset records and hashes verified (${allowed.size} inventoried assets).`);
}
