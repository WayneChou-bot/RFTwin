/* 由 schemas/*.schema.json 產生（ADR-003）。禁止手動編輯。
 * 重新產生：node scripts/generate_types.mjs
 */
export type Type = "snapshot";
export type SchemaVersion = string;
export type RunId = string;
export type Seq = number;
export type SimTick = number;
export type SimTime = string;
export type GeneratedAt = string;
export type RunId1 = string;
export type EngineVersion = string;
export type DomainVersion = string;
export type SchemaVersion1 = string;
export type ParameterSetId = string;
export type ParameterHash = string;
export type Seed = number;
export type LayoutId = string | null;
export type LayoutHash = string | null;
export type InitialSnapshotId = string | null;
export type RunId2 = string;
export type Seq1 = number;
export type FactoryId = string;
export type TemperatureC = number;
export type HumidityPercent = number;
export type SystemStatus = "NORMAL" | "DEGRADED" | "ALARM";
export type LineId = string;
export type Name = string;
export type LineState =
  "RUNNING" | "IDLE" | "CHANGEOVER" | "BLOCKED" | "STARVED" | "DEGRADED" | "STOPPED" | "MAINTENANCE";
export type BottleneckCellId = string | null;
export type CellId = string;
export type Name1 = string;
export type CellState = "RUNNING" | "STARVED" | "BLOCKED" | "DEGRADED" | "FAULT" | "MAINTENANCE";
export type Operation = "WELDING" | "ASSEMBLY" | "MACHINING" | "INSPECTION" | "REWORK";
export type Oee = number;
export type ThroughputUph = number;
export type BufferId = string;
export type Capacity = number | null;
export type Occupancy = number;
export type ReorderPoint = number | null;
export type StationId = string;
export type CellId1 = string;
export type StationState = "READY" | "PROCESSING" | "BLOCKED" | "STARVED" | "FAULT" | "MAINTENANCE";
export type RobotId = string;
export type MachineId = string | null;
export type CurrentPartId = string | null;
export type CycleProgress = number;
export type StationCycleSec = number;
export type TargetStationCycleSec = number;
export type BlockedTimeSec = number;
export type StarvedTimeSec = number;
export type IdleTimeSec = number;
export type FaultKind = string | null;
export type FaultProgress = number;
export type Stations = StationSnapshot[];
export type ActiveStations = number;
export type IdleStations = number;
export type ErrorStations = number;
export type AvgStationCycleSec = number;
export type IsBottleneck = boolean;
export type SafetyAwaitingReset = boolean;
export type Cells = CellSnapshot[];
export type ConveyorId = string;
export type ConveyorStatus =
  "RUNNING" | "IDLE" | "BLOCKED" | "JAMMED" | "WARNING" | "ERROR" | "MAINTENANCE" | "OFFLINE";
export type FromCell = string;
export type ToCell = string;
export type SpeedMps = number;
export type ItemCount = number;
export type InTransitMax = number;
export type MotorCurrentA = number;
export type TemperatureC1 = number;
export type EnergyKw = number;
export type Conveyors = ConveyorSnapshot[];
export type AmrId = string;
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
export type BatteryPercent = number;
export type CurrentTask = string | null;
export type TaskType = string | null;
export type TaskTarget = string | null;
export type Carrying = string | null;
export type PhaseProgress = number;
export type PhaseTotalSec = number;
export type QueueLength = number;
/**
 * @minItems 2
 * @maxItems 2
 */
export type Position = [number, number];
export type Route = number[][];
export type RouteProgress = number;
export type TrafficState = "CLEAR" | "YIELDING" | "REROUTED" | "BLOCKED";
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
export type Amrs = AmrSnapshot[];
export type RobotId1 = string;
export type LineId1 = string;
export type CellId2 = string;
export type StationId1 = string;
export type Process = string;
export type RobotStatus =
  | "RUNNING"
  | "IDLE"
  | "SETUP"
  | "STARVED"
  | "BLOCKED"
  | "WARNING"
  | "ERROR"
  | "MAINTENANCE"
  | "OFFLINE"
  | "EMERGENCY_STOP"
  | "WAITING_MACHINE";
export type Mode = "AUTO" | "MANUAL" | "TEACH";
export type CycleState = string;
export type CycleProgress1 = number;
export type CycleTimeSec = number;
export type TargetCycleTimeSec = number;
/**
 * @minItems 6
 * @maxItems 6
 */
export type JointLoadPercent = [number, number, number, number, number, number];
/**
 * @minItems 6
 * @maxItems 6
 */
export type JointTemperatureC = [number, number, number, number, number, number];
export type ToolHealthPercent = number;
export type EnergyKw1 = number;
export type AlarmCode = string | null;
export type MaintenanceRisk = number;
export type Robots = RobotState[];
export type Created = number;
export type Wip = number;
export type GoodCompleted = number;
export type Scrap = number;
export type Held = number;
export type ReworkWip = number;
export type Shipped = number;
export type RackId = string;
export type CellId3 = string;
export type Sku = string;
export type Capacity1 = number;
export type Qty = number;
export type ReorderPoint1 = number;
export type Reserved = number;
export type ContainerId = string;
export type LastReplenishedTime = string | null;
export type MaterialLow = boolean;
export type StockoutSec = number;
export type Racks = RackSnapshot[];
export type Sku1 = string;
export type Qty1 = number;
export type Capacity2 = number;
export type PerSku = SkuStock[];
export type Empties = number;
export type Units = number;
export type PalletSize = number;
export type PalletsPerTruck = number;
export type OutboundTotal = number;
export type OutboundStage = "IDLE" | "ASSIGNED" | "DOCKED";
export type DoorOpen = boolean;
export type OutboundProgress = number;
export type ShipmentId = string | null;
export type Stage = "IDLE" | "ARRIVED" | "DOOR_OPENING" | "UNLOADING" | "INSPECTING" | "WAIT_PICKUP";
export type Sku2 = string | null;
export type Qty2 = number;
export type DoorOpen1 = boolean;
export type TruckId = string | null;
export type AssetId = string;
export type State1 = string;
export type ObstacleId = string;
/**
 * @minItems 2
 * @maxItems 2
 */
export type Position1 = [number, number];
export type RadiusM1 = number;
export type ClearanceM = number;
export type Label = string;
export type RemainingSec = number;
export type Obstacles1 = ObstacleSnapshot[];
export type DecisionId = string;
export type TaskId = string;
export type TaskType1 = string;
export type Target = string;
export type Priority = number;
export type SimTick1 = number;
export type SimTime1 = string;
export type QueueWaitSec = number;
export type Chosen = string | null;
export type Rule = string;
export type Reason = string;
export type AmrId1 = string;
export type Eligible = boolean;
export type State2 = string;
export type BatteryPercent1 = number;
export type DistanceM1 = number;
export type PrefMatch = boolean;
export type Rank = number | null;
export type RejectedReason = string | null;
export type Candidates = DispatchCandidate[];
export type DispatchDecisions = DispatchDecision[];
export type UtilizationPct = number;
export type TasksCompleted = number;
export type AvgTaskWaitSec = number;
export type OnTimeReplenishmentPct = number;
export type StockoutMin = number;
export type DistanceM2 = number;
export type EnergyKwh = number;
export type ChargingMin = number;
export type DockWaitMin = number;
export type StarvationFromLogisticsMin = number;
export type PendingTasks = number;
export type AmrId2 = string;
export type TasksCompleted1 = number;
export type BusyMin = number;
export type DistanceM3 = number;
export type ChargingMin1 = number;
export type Battery = number;
export type PerAmr = AmrKpiPerUnit[];
export type OrderId = string;
export type LineId2 = string;
export type ProductId = string;
export type TargetQuantity = number;
export type CompletedQuantity = number;
export type DefectQuantity = number;
export type Priority1 = "LOW" | "NORMAL" | "HIGH";
export type OrderStatus = "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "DELAYED" | "CANCELLED";
export type PlannedStart = string;
export type PlannedEnd = string;
export type Orders = ProductionOrder[];
export type TotalOutput = number;
export type GoodUnits = number;
export type DefectUnits = number;
export type ReworkUnits = number;
export type Wip1 = number;
export type ThroughputUph1 = number;
export type TaktTimeSec = number;
export type TargetGoodUnits = number;
export type FirstPassYield = number;
export type DefectRate = number;
export type Availability = number;
export type Performance = number;
export type Quality = number;
export type Oee1 = number;
export type TargetOee = number;
export type RuntimeSec = number;
export type DowntimeSec = number;
export type PlannedTimeSec = number;
export type AvgLeadTimeSec = number;
export type EnergyKwhTotal = number;
export type IdleWasteKwh = number;
export type BaselineKw = number;
export type BaselineDeltaPct = number;
export type DemandLimitKw = number;
export type UnitsPerKwh = number;
export type EnergyKwhPerUnit = number;
export type EnergyKwCurrent = number;
export type PeakDemandKw = number;
export type SimMinute = string;
export type GoodUnits1 = number;
export type DefectUnits1 = number;
export type ThroughputUph2 = number;
export type Oee2 = number;
export type DefectRate1 = number;
export type EnergyKw2 = number;
export type Wip2 = number;
export type HistoryMinutes = MinutePoint[];
export type EventId = string;
export type RunId3 = string;
export type Seq2 = number;
export type SimTick2 = number;
export type SimTime2 = string;
export type SourceType = string;
export type SourceId = string;
export type EventType = string;
export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type LineId3 = string | null;
export type CellId4 = string | null;
export type Message = string;
export type Value = number | null;
export type Threshold = number | null;
export type Acknowledged = boolean;
export type RecentEvents = TwinEvent[];
export type AlertId = string;
export type SourceType1 = string;
export type SourceId1 = string;
export type Title = string;
export type Detail = string;
export type SimTime3 = string;
export type EventSeq = number;
export type Acknowledged1 = boolean;
export type Resolved = boolean;
export type Alerts = Alert[];
export type SimulatedHistory = boolean;
export type Paused = boolean;
export type Speed = number;
export type Seq3 = number;

/**
 * §14.2 — seq 為此快照已包含到哪一筆 Event；Snapshot 本身不占序號。
 */
export interface SnapshotMessage {
  type: Type;
  schema_version: SchemaVersion;
  run_id: RunId;
  seq: Seq;
  sim_tick: SimTick;
  sim_time: SimTime;
  generated_at: GeneratedAt;
  provenance: RunProvenance;
  state: FactoryState;
  control?: ControlState | null;
}
export interface RunProvenance {
  run_id: RunId1;
  engine_version: EngineVersion;
  domain_version: DomainVersion;
  schema_version: SchemaVersion1;
  parameter_set_id: ParameterSetId;
  parameter_hash: ParameterHash;
  seed: Seed;
  layout_id?: LayoutId;
  layout_hash?: LayoutHash;
  initial_snapshot_id?: InitialSnapshotId;
  branch_from?: BranchFrom | null;
}
export interface BranchFrom {
  run_id: RunId2;
  seq: Seq1;
}
/**
 * Snapshot payload（`state` 欄位內容）。
 */
export interface FactoryState {
  factory_id: FactoryId;
  environment: FactoryEnvironment;
  line: LineSnapshot;
  cells: Cells;
  conveyors: Conveyors;
  amrs: Amrs;
  robots: Robots;
  raw_buffer: BufferSnapshot;
  rework_buffer: BufferSnapshot;
  finished_buffer: BufferSnapshot;
  parts: PartCounts;
  racks: Racks;
  supermarket: SupermarketSnapshot;
  staging: StagingSnapshot;
  receiving: ReceivingSnapshot;
  facility: FacilitySnapshot;
  obstacles?: Obstacles1;
  dispatch_decisions?: DispatchDecisions;
  amr_kpis: AmrKpis;
  orders: Orders;
  kpis: KpiSnapshot;
  history_minutes: HistoryMinutes;
  recent_events: RecentEvents;
  alerts: Alerts;
  simulated_history: SimulatedHistory;
}
export interface FactoryEnvironment {
  temperature_c: TemperatureC;
  humidity_percent: HumidityPercent;
  system_status: SystemStatus;
}
export interface LineSnapshot {
  line_id: LineId;
  name: Name;
  state: LineState;
  bottleneck_cell_id?: BottleneckCellId;
}
/**
 * §10.2, §27 Process Cells 面板。
 */
export interface CellSnapshot {
  cell_id: CellId;
  name: Name1;
  state: CellState;
  operation: Operation;
  oee: Oee;
  throughput_uph: ThroughputUph;
  input_buffer: BufferSnapshot;
  output_buffer: BufferSnapshot;
  stations: Stations;
  active_stations: ActiveStations;
  idle_stations: IdleStations;
  error_stations: ErrorStations;
  avg_station_cycle_sec: AvgStationCycleSec;
  is_bottleneck: IsBottleneck;
  safety_awaiting_reset?: SafetyAwaitingReset;
}
export interface BufferSnapshot {
  buffer_id: BufferId;
  capacity?: Capacity;
  occupancy: Occupancy;
  reorder_point?: ReorderPoint;
}
/**
 * §10.4
 */
export interface StationSnapshot {
  station_id: StationId;
  cell_id: CellId1;
  state: StationState;
  robot_id: RobotId;
  machine_id?: MachineId;
  current_part_id?: CurrentPartId;
  cycle_progress: CycleProgress;
  station_cycle_sec: StationCycleSec;
  target_station_cycle_sec: TargetStationCycleSec;
  blocked_time_sec: BlockedTimeSec;
  starved_time_sec: StarvedTimeSec;
  idle_time_sec: IdleTimeSec;
  fault_kind?: FaultKind;
  fault_progress?: FaultProgress;
}
/**
 * §11
 */
export interface ConveyorSnapshot {
  conveyor_id: ConveyorId;
  status: ConveyorStatus;
  from_cell: FromCell;
  to_cell: ToCell;
  speed_mps: SpeedMps;
  item_count: ItemCount;
  in_transit_max: InTransitMax;
  motor_current_a: MotorCurrentA;
  temperature_c: TemperatureC1;
  energy_kw: EnergyKw;
}
/**
 * §12＋§39：粗粒度 status 沿用，細粒度 task_state 驅動 3D 行走。
 */
export interface AmrSnapshot {
  amr_id: AmrId;
  status: AmrStatus;
  task_state: AmrTaskState;
  battery_percent: BatteryPercent;
  current_task?: CurrentTask;
  task_type?: TaskType;
  task_target?: TaskTarget;
  carrying?: Carrying;
  phase_progress: PhaseProgress;
  phase_total_sec: PhaseTotalSec;
  queue_length: QueueLength;
  position: Position;
  route?: Route;
  route_progress?: RouteProgress;
  traffic_state?: TrafficState;
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
/**
 * §8.2
 */
export interface RobotState {
  robot_id: RobotId1;
  line_id: LineId1;
  cell_id: CellId2;
  station_id: StationId1;
  process: Process;
  status: RobotStatus;
  mode: Mode;
  cycle_state: CycleState;
  cycle_progress: CycleProgress1;
  cycle_time_sec: CycleTimeSec;
  target_cycle_time_sec: TargetCycleTimeSec;
  joint_load_percent: JointLoadPercent;
  joint_temperature_c: JointTemperatureC;
  tool_health_percent: ToolHealthPercent;
  energy_kw: EnergyKw1;
  alarm_code?: AlarmCode;
  maintenance_risk: MaintenanceRisk;
}
/**
 * §13.3 守恆式的權威計數：created = wip + good_completed + scrap。
 */
export interface PartCounts {
  created: Created;
  wip: Wip;
  good_completed: GoodCompleted;
  scrap: Scrap;
  held: Held;
  rework_wip: ReworkWip;
  shipped: Shipped;
}
/**
 * §39.1 Cell-side Rack（Slot 欄位；權威=引擎）。
 */
export interface RackSnapshot {
  rack_id: RackId;
  cell_id: CellId3;
  sku: Sku;
  capacity: Capacity1;
  qty: Qty;
  reorder_point: ReorderPoint1;
  reserved: Reserved;
  container_id: ContainerId;
  last_replenished_time?: LastReplenishedTime;
  material_low: MaterialLow;
  stockout_sec: StockoutSec;
}
/**
 * §44.2 Component Supermarket（v7：per-SKU 庫存 + 空箱架）。
 */
export interface SupermarketSnapshot {
  per_sku: PerSku;
  empties: Empties;
}
export interface SkuStock {
  sku: Sku1;
  qty: Qty1;
  capacity: Capacity2;
}
/**
 * §44.8 Finished Goods Staging：shipped 於此卸貨才計入；滿 3 板出貨。
 * §45.4：出貨改事件鏈（ASSIGNED→DOCKED→SHIPPED），門動畫由 door_open 驅動。
 */
export interface StagingSnapshot {
  units: Units;
  pallet_size: PalletSize;
  pallets_per_truck: PalletsPerTruck;
  outbound_total: OutboundTotal;
  outbound_stage: OutboundStage;
  door_open: DoorOpen;
  outbound_progress?: OutboundProgress;
  shipment_id?: ShipmentId;
}
/**
 * §45.3 收貨事件鏈：ARRIVED→DOOR_OPENING→UNLOADING→INSPECTING→WAIT_PICKUP。
 */
export interface ReceivingSnapshot {
  stage: Stage;
  sku?: Sku2;
  qty: Qty2;
  door_open: DoorOpen1;
  truck_id?: TruckId;
}
/**
 * §45.8：compressor／hvac／fume_extraction／mdp／charger 狀態（由引擎推導）。
 */
export interface FacilitySnapshot {
  compressor: FacilityUnit;
  hvac: FacilityUnit;
  fume_extraction: FacilityUnit;
  mdp: FacilityUnit;
  charger: FacilityUnit;
}
/**
 * §45.8 廠務設備（欄位依設備不同；允許擴充）。
 */
export interface FacilityUnit {
  asset_id: AssetId;
  state: State1;
  [k: string]: unknown;
}
/**
 * §48 空間障礙物：有座標／半徑／剩餘時間；AMR 路線規劃繞開、移動鉗制。
 */
export interface ObstacleSnapshot {
  obstacle_id: ObstacleId;
  position: Position1;
  radius_m: RadiusM1;
  clearance_m?: ClearanceM;
  label: Label;
  remaining_sec: RemainingSec;
}
/**
 * §51 派工 Decision Record：規則、選中理由句、候選清單（WareTwin 借鏡）。
 */
export interface DispatchDecision {
  decision_id: DecisionId;
  task_id: TaskId;
  task_type: TaskType1;
  target: Target;
  priority: Priority;
  sim_tick: SimTick1;
  sim_time: SimTime1;
  queue_wait_sec: QueueWaitSec;
  chosen?: Chosen;
  rule: Rule;
  reason: Reason;
  candidates: Candidates;
}
/**
 * §51 派工候選評估（每台 AMR 一列；落選者附原因）。
 */
export interface DispatchCandidate {
  amr_id: AmrId1;
  eligible: Eligible;
  state: State2;
  battery_percent: BatteryPercent1;
  distance_m: DistanceM1;
  pref_match: PrefMatch;
  rank?: Rank;
  rejected_reason?: RejectedReason;
}
/**
 * §39.6 物流 KPI。
 */
export interface AmrKpis {
  utilization_pct: UtilizationPct;
  tasks_completed: TasksCompleted;
  avg_task_wait_sec: AvgTaskWaitSec;
  on_time_replenishment_pct: OnTimeReplenishmentPct;
  stockout_min: StockoutMin;
  distance_m: DistanceM2;
  energy_kwh: EnergyKwh;
  charging_min: ChargingMin;
  dock_wait_min: DockWaitMin;
  starvation_from_logistics_min: StarvationFromLogisticsMin;
  pending_tasks: PendingTasks;
  per_amr: PerAmr;
}
export interface AmrKpiPerUnit {
  amr_id: AmrId2;
  tasks_completed: TasksCompleted1;
  busy_min: BusyMin;
  distance_m: DistanceM3;
  charging_min: ChargingMin1;
  battery: Battery;
}
/**
 * §10.3
 */
export interface ProductionOrder {
  order_id: OrderId;
  line_id: LineId2;
  product_id: ProductId;
  target_quantity: TargetQuantity;
  completed_quantity: CompletedQuantity;
  defect_quantity: DefectQuantity;
  priority: Priority1;
  status: OrderStatus;
  planned_start: PlannedStart;
  planned_end: PlannedEnd;
}
/**
 * §18 — 全部由同一組原始事件推導。
 */
export interface KpiSnapshot {
  total_output: TotalOutput;
  good_units: GoodUnits;
  defect_units: DefectUnits;
  rework_units: ReworkUnits;
  wip: Wip1;
  throughput_uph: ThroughputUph1;
  takt_time_sec: TaktTimeSec;
  target_good_units: TargetGoodUnits;
  first_pass_yield: FirstPassYield;
  defect_rate: DefectRate;
  oee: OeeBlock;
  runtime_sec: RuntimeSec;
  downtime_sec: DowntimeSec;
  planned_time_sec: PlannedTimeSec;
  avg_lead_time_sec: AvgLeadTimeSec;
  energy_kwh_total: EnergyKwhTotal;
  idle_waste_kwh: IdleWasteKwh;
  baseline_kw: BaselineKw;
  baseline_delta_pct: BaselineDeltaPct;
  demand_limit_kw: DemandLimitKw;
  units_per_kwh: UnitsPerKwh;
  energy_kwh_per_unit: EnergyKwhPerUnit;
  energy_kw_current: EnergyKwCurrent;
  peak_demand_kw: PeakDemandKw;
}
/**
 * §18.2 OEE = A × P × Q（引擎計算，前端只顯示）。
 */
export interface OeeBlock {
  availability: Availability;
  performance: Performance;
  quality: Quality;
  oee: Oee1;
  target_oee: TargetOee;
}
/**
 * 引擎 per-minute aggregator 輸出（§10.7）；Live 與 Pre-roll 共用。
 */
export interface MinutePoint {
  sim_minute: SimMinute;
  good_units: GoodUnits1;
  defect_units: DefectUnits1;
  throughput_uph: ThroughputUph2;
  oee: Oee2;
  defect_rate: DefectRate1;
  energy_kw: EnergyKw2;
  wip: Wip2;
}
/**
 * §15.2
 */
export interface TwinEvent {
  event_id: EventId;
  run_id: RunId3;
  seq: Seq2;
  sim_tick: SimTick2;
  sim_time: SimTime2;
  source_type: SourceType;
  source_id: SourceId;
  event_type: EventType;
  severity: Severity;
  line_id?: LineId3;
  cell_id?: CellId4;
  message: Message;
  value?: Value;
  threshold?: Threshold;
  acknowledged?: Acknowledged;
}
/**
 * §19
 */
export interface Alert {
  alert_id: AlertId;
  severity: Severity;
  source_type: SourceType1;
  source_id: SourceId1;
  title: Title;
  detail: Detail;
  sim_time: SimTime3;
  event_seq: EventSeq;
  acknowledged?: Acknowledged1;
  resolved?: Resolved;
}
/**
 * §51 模擬控制狀態（後端權威；多分頁一致）。§52：seq 單調遞增，前端拒收倒退的控制狀態。
 */
export interface ControlState {
  paused: Paused;
  speed: Speed;
  seq?: Seq3;
}
