/* 由 schemas/*.schema.json 產生（ADR-003）。禁止手動編輯。
 * 重新產生：node scripts/generate_types.mjs
 */
export type Type = "event";
export type SchemaVersion = string;
export type RunId = string;
export type Seq = number;
export type SimTick = number;
export type SimTime = string;
export type GeneratedAt = string;
export type EventId = string;
export type RunId1 = string;
export type Seq1 = number;
export type SimTick1 = number;
export type SimTime1 = string;
export type SourceType = string;
export type SourceId = string;
export type EventType = string;
export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type LineId = string | null;
export type CellId = string | null;
export type Message = string;
export type Value = number | null;
export type Threshold = number | null;
export type Acknowledged = boolean;

/**
 * §14.2 — 只有 Event 遞增 seq。
 */
export interface EventMessage {
  type: Type;
  schema_version: SchemaVersion;
  run_id: RunId;
  seq: Seq;
  sim_tick: SimTick;
  sim_time: SimTime;
  generated_at: GeneratedAt;
  event: TwinEvent;
}
/**
 * §15.2
 */
export interface TwinEvent {
  event_id: EventId;
  run_id: RunId1;
  seq: Seq1;
  sim_tick: SimTick1;
  sim_time: SimTime1;
  source_type: SourceType;
  source_id: SourceId;
  event_type: EventType;
  severity: Severity;
  line_id?: LineId;
  cell_id?: CellId;
  message: Message;
  value?: Value;
  threshold?: Threshold;
  acknowledged?: Acknowledged;
}
