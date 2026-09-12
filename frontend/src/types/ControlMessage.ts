/* 由 schemas/*.schema.json 產生（ADR-003）。禁止手動編輯。
 * 重新產生：node scripts/generate_types.mjs
 */
export type Type = "control";
export type SchemaVersion = string;
export type RunId = string;
export type SimTick = number;
export type Paused = boolean;
export type Speed = number;
export type Seq = number;

/**
 * §51 控制變更廣播（暫停／播放／倍速／Reset 後）：所有分頁以此同步。無 seq。
 */
export interface ControlMessage {
  type: Type;
  schema_version: SchemaVersion;
  run_id: RunId;
  sim_tick: SimTick;
  control: ControlState;
}
/**
 * §51 模擬控制狀態（後端權威；多分頁一致）。§52：seq 單調遞增，前端拒收倒退的控制狀態。
 */
export interface ControlState {
  paused: Paused;
  speed: Speed;
  seq?: Seq;
}
