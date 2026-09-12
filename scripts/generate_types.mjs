// JSON Schema → TypeScript types（ADR-003 第二段）。
// 每個 wire schema 產生一個模組（避免共用 $defs 造成重複識別字），外加 index.ts。
// CI 用法：node scripts/generate_types.mjs --check
import { compile } from "json-schema-to-typescript";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(ROOT, "schemas");
const OUT_DIR = join(ROOT, "frontend", "src", "types");
const check = process.argv.includes("--check");
mkdirSync(OUT_DIR, { recursive: true });

const banner = `/* 由 schemas/*.schema.json 產生（ADR-003）。禁止手動編輯。
 * 重新產生：node scripts/generate_types.mjs
 */
`;
const outputs = {};
const names = [];
for (const f of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort()) {
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8"));
  const name = basename(f, ".schema.json");
  names.push(name);
  outputs[`${name}.ts`] = banner + (await compile(schema, name, {
    bannerComment: "",
    additionalProperties: false,
  }));
}
// index：SnapshotMessage 模組涵蓋所有共用子型別；其餘模組只輸出頂層型別
const primary = "SnapshotMessage";
let index = banner;
index += `export * from "./${primary}";\n`;
for (const n of names.filter((n) => n !== primary)) {
  index += `export type { ${n} } from "./${n}";\n`;
}
outputs["index.ts"] = index;
outputs["generated.ts"] = banner +
  `/* 舊入口：改由 ./index 匯出（檔案保留避免斷 import）。 */\nexport * from "./index";\n`;

let stale = false;
for (const [file, body] of Object.entries(outputs)) {
  const path = join(OUT_DIR, file);
  if (check) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current !== body) { console.error(`${file} 與 schema 產物不一致`); stale = true; }
  } else {
    writeFileSync(path, body);
    console.log(`wrote frontend/src/types/${file}`);
  }
}
if (check) {
  if (stale) process.exit(1);
  console.log("types up-to-date");
}
