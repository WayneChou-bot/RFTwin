// Fixture ← JSON Schema（AJV）驗證（ADR-003：fixture 必須通過 AJV）。
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(ROOT, "schemas", "SnapshotMessage.schema.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(ROOT, "fixtures", "snapshot.live-001.json"), "utf8"));

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(fixture)) {
  console.error(validate.errors);
  process.exit(1);
}
console.log("fixture valid against SnapshotMessage.schema.json");
