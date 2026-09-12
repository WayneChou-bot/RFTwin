/* 由 schemas/*.schema.json 產生（ADR-003）。禁止手動編輯。
 * 重新產生：node scripts/generate_types.mjs
 */
export * from "./SnapshotMessage";
export type { AmrPatchMessage } from "./AmrPatchMessage";
export type { ControlMessage } from "./ControlMessage";
export type { EventMessage } from "./EventMessage";
export type { ExplanationResult } from "./ExplanationResult";
export type { ScenarioResult } from "./ScenarioResult";
