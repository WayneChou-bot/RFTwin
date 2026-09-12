/* 由 schemas/*.schema.json 產生（ADR-003）。禁止手動編輯。
 * 重新產生：node scripts/generate_types.mjs
 */
export type Type = "amr_patch";
export type SchemaVersion = string;
export type RunId = string;
export type SimTick = number;
export type SimTime = string;
export type GeneratedAt = string | null;
export type AmrId = string;
export type Position = [number, number] | null;
export type Route = number[][] | null;
export type RouteProgress = number | null;
export type PhaseProgress = number | null;
export type AmrStatus = "IDLE" | "DELIVERING" | "RETURNING" | "CHARGING" | "WAITING" | "ERROR";
/**
 * §39.4 任務狀態機（顯示層據此推導路徑與動作）。
 */
export type AmrTaskState =
  | "IDLE"
  | "TRAVEL_TO_PICKUP"
  | "DOCKING_PICKUP"
  | "LOADING"
  | "TRAVEL_TO_DROPOFF"
  | "DOCKING_DROPOFF"
  | "UNLOADING"
  | "RETURNING"
  | "WAITING_FOR_DOCK"
  | "CHARGING"
  | "BLOCKED"
  | "ERROR";
export type TrafficState = ("CLEAR" | "YIELDING" | "REROUTED" | "BLOCKED") | null;
export type Carrying = string | null;
export type BatteryPercent = number | null;
export type State = "CLEAR" | "CAUTION" | "STOPPED";
/**
 * @minItems 2
 * @maxItems 2
 */
export type Heading = [number, number];
export type AheadM = number | null;
export type NearestM = number | null;
export type SafeM = number;
export type ClearM = number;
export type HardStopM = number;
export type SenseM = number;
export type Kind = "amr" | "obstacle";
export type Id = string;
export type DistanceM = number;
export type BearingDeg = number;
export type Ref = "center" | "edge";
export type RadiusM = number;
export type Obstacles = PerceivedObject[];
export type Amrs = AmrPatchEntry[];

/**
 * §50（WareTwin 借鏡）：AMR 位置 10 Hz 增量串流；不遞增 seq（非事件）、
 * 不取代 1 Hz snapshot（snapshot 每秒整份覆蓋）。
 */
export interface AmrPatchMessage {
  type: Type;
  schema_version: SchemaVersion;
  run_id: RunId;
  sim_tick: SimTick;
  sim_time: SimTime;
  generated_at?: GeneratedAt;
  amrs: Amrs;
}
/**
 * §50：單台 AMR 的增量（只帶變動欄位）。
 */
export interface AmrPatchEntry {
  amr_id: AmrId;
  position?: Position;
  route?: Route;
  route_progress?: RouteProgress;
  phase_progress?: PhaseProgress;
  status?: AmrStatus | null;
  task_state?: AmrTaskState | null;
  traffic_state?: TrafficState;
  carrying?: Carrying;
  battery_percent?: BatteryPercent;
  perception?: AmrPerception | null;
}
/**
 * §51 感知層（WareTwin 借鏡）：純由引擎交通判斷的輸入推導，前端畫扇形／射線。
 */
export interface AmrPerception {
  state: State;
  heading: Heading;
  ahead_m?: AheadM;
  nearest_m?: NearestM;
  safe_m: SafeM;
  clear_m: ClearM;
  hard_stop_m: HardStopM;
  sense_m: SenseM;
  obstacles?: Obstacles;
}
export interface PerceivedObject {
  kind: Kind;
  id: Id;
  distance_m: DistanceM;
  bearing_deg: BearingDeg;
  ref?: Ref;
  radius_m?: RadiusM;
}
