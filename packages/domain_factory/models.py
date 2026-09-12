"""domain-factory Pydantic models — the single source of the wire schema.

§8, §10, §13, §14, §18.
JSON Schema 與 TypeScript types 由此單向產生（ADR-003）；禁止手寫對應型別。
"""
from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "1.0"


# ---------------------------------------------------------------- enums

class RobotStatus(str, Enum):
    RUNNING = "RUNNING"
    IDLE = "IDLE"
    SETUP = "SETUP"
    STARVED = "STARVED"
    BLOCKED = "BLOCKED"
    WARNING = "WARNING"
    ERROR = "ERROR"
    MAINTENANCE = "MAINTENANCE"
    OFFLINE = "OFFLINE"
    EMERGENCY_STOP = "EMERGENCY_STOP"
    WAITING_MACHINE = "WAITING_MACHINE"  # §10.6: CNC 加工期間，不計為 Active


class CellState(str, Enum):
    RUNNING = "RUNNING"
    STARVED = "STARVED"
    BLOCKED = "BLOCKED"
    DEGRADED = "DEGRADED"
    FAULT = "FAULT"
    MAINTENANCE = "MAINTENANCE"


class LineState(str, Enum):
    RUNNING = "RUNNING"
    IDLE = "IDLE"
    CHANGEOVER = "CHANGEOVER"
    BLOCKED = "BLOCKED"
    STARVED = "STARVED"
    DEGRADED = "DEGRADED"
    STOPPED = "STOPPED"
    MAINTENANCE = "MAINTENANCE"


class StationState(str, Enum):
    READY = "READY"
    PROCESSING = "PROCESSING"
    BLOCKED = "BLOCKED"
    STARVED = "STARVED"
    FAULT = "FAULT"
    MAINTENANCE = "MAINTENANCE"


class ConveyorStatus(str, Enum):
    RUNNING = "RUNNING"
    IDLE = "IDLE"
    BLOCKED = "BLOCKED"
    JAMMED = "JAMMED"
    WARNING = "WARNING"
    ERROR = "ERROR"
    MAINTENANCE = "MAINTENANCE"
    OFFLINE = "OFFLINE"


class AmrStatus(str, Enum):
    IDLE = "IDLE"
    DELIVERING = "DELIVERING"
    RETURNING = "RETURNING"
    CHARGING = "CHARGING"
    WAITING = "WAITING"
    ERROR = "ERROR"


class PartLifecycleState(str, Enum):
    """§13.3 生產階段維度。"""
    RAW = "RAW"
    QUEUED = "QUEUED"
    PROCESSING = "PROCESSING"
    IN_TRANSIT = "IN_TRANSIT"
    HELD = "HELD"
    COMPLETED = "COMPLETED"


class PartQualityState(str, Enum):
    """§13.3 品質判定維度，與位置無關。"""
    UNKNOWN = "UNKNOWN"
    PASS_ = "PASS"
    REWORK_REQUIRED = "REWORK_REQUIRED"
    SCRAP = "SCRAP"


class LocationType(str, Enum):
    BUFFER = "BUFFER"
    STATION = "STATION"
    CONVEYOR = "CONVEYOR"
    REWORK_AREA = "REWORK_AREA"
    AMR = "AMR"
    FINISHED = "FINISHED"


class Operation(str, Enum):
    WELDING = "WELDING"
    ASSEMBLY = "ASSEMBLY"
    MACHINING = "MACHINING"
    INSPECTION = "INSPECTION"
    REWORK = "REWORK"


class Severity(str, Enum):
    INFO = "INFO"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class OrderStatus(str, Enum):
    PLANNED = "PLANNED"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    DELAYED = "DELAYED"
    CANCELLED = "CANCELLED"


Pct = Annotated[float, Field(ge=0, le=100)]
Ratio = Annotated[float, Field(ge=0, le=1)]
NonNegInt = Annotated[int, Field(ge=0)]
NonNeg = Annotated[float, Field(ge=0)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", use_enum_values=True)


# ---------------------------------------------------------------- provenance (§13.4)

class BranchFrom(StrictModel):
    run_id: str
    seq: NonNegInt


class RunProvenance(StrictModel):
    run_id: str
    engine_version: str
    domain_version: str
    schema_version: str
    parameter_set_id: str
    parameter_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    seed: int
    layout_id: Optional[str] = None                                  # §50 佈局單一來源
    layout_hash: Optional[str] = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")
    initial_snapshot_id: Optional[str] = None
    branch_from: Optional[BranchFrom] = None


# ---------------------------------------------------------------- entities

class RobotState(StrictModel):
    """§8.2"""
    robot_id: str
    line_id: str
    cell_id: str
    station_id: str
    process: str
    status: RobotStatus
    mode: Literal["AUTO", "MANUAL", "TEACH"]
    cycle_state: str
    cycle_progress: Ratio
    cycle_time_sec: NonNeg
    target_cycle_time_sec: NonNeg
    joint_load_percent: list[Pct] = Field(min_length=6, max_length=6)
    joint_temperature_c: list[float] = Field(min_length=6, max_length=6)
    tool_health_percent: Pct
    energy_kw: NonNeg
    alarm_code: Optional[str] = None
    maintenance_risk: Ratio


class StationSnapshot(StrictModel):
    """§10.4"""
    station_id: str
    cell_id: str
    state: StationState
    robot_id: str
    machine_id: Optional[str] = None
    current_part_id: Optional[str] = None
    cycle_progress: Ratio
    station_cycle_sec: NonNeg
    target_station_cycle_sec: NonNeg
    blocked_time_sec: NonNeg
    starved_time_sec: NonNeg
    idle_time_sec: NonNeg
    fault_kind: Optional[str] = None       # §45.12 tool_failure / minor_stop / safety_gate / utility_air
    fault_progress: Ratio = 0.0            # 修復進度 0→1（維修情境動畫的權威來源）


class BufferSnapshot(StrictModel):
    buffer_id: str
    capacity: Optional[NonNegInt] = None  # null = unbounded (finished goods)
    occupancy: NonNegInt
    reorder_point: Optional[NonNegInt] = None


class CellSnapshot(StrictModel):
    """§10.2, §27 Process Cells 面板。"""
    cell_id: str
    name: str
    state: CellState
    operation: Operation
    oee: Ratio
    throughput_uph: NonNeg
    input_buffer: BufferSnapshot
    output_buffer: BufferSnapshot
    stations: list[StationSnapshot]
    active_stations: NonNegInt
    idle_stations: NonNegInt
    error_stations: NonNegInt
    avg_station_cycle_sec: NonNeg
    is_bottleneck: bool
    safety_awaiting_reset: bool = False   # §46：條件解除、待操作員 Reset


class ConveyorSnapshot(StrictModel):
    """§11"""
    conveyor_id: str
    status: ConveyorStatus
    from_cell: str
    to_cell: str
    speed_mps: NonNeg
    item_count: NonNegInt
    in_transit_max: NonNegInt
    motor_current_a: NonNeg
    temperature_c: float
    energy_kw: NonNeg


class AmrTaskState(str, Enum):
    """§39.4 任務狀態機（顯示層據此推導路徑與動作）。"""
    IDLE = "IDLE"
    TRAVEL_TO_PICKUP = "TRAVEL_TO_PICKUP"
    DOCKING_PICKUP = "DOCKING_PICKUP"
    LOADING = "LOADING"
    TRAVEL_TO_DROPOFF = "TRAVEL_TO_DROPOFF"
    DOCKING_DROPOFF = "DOCKING_DROPOFF"
    UNLOADING = "UNLOADING"
    RETURNING = "RETURNING"
    WAITING_FOR_DOCK = "WAITING_FOR_DOCK"
    CHARGING = "CHARGING"
    BLOCKED = "BLOCKED"
    ERROR = "ERROR"


class PerceivedObject(StrictModel):
    kind: Literal["amr", "obstacle"]
    id: str
    distance_m: NonNeg                 # 交通邏輯實際比較的量：他車=中心距、障礙物=到邊緣（見 ref）
    bearing_deg: float                 # 0 = 正前方，正 = 左
    ref: Literal["center", "edge"] = "center"   # §52：distance_m 的參考點
    radius_m: NonNeg = 0.0             # ref="edge" 時的物體半徑（畫面可還原中心距）


class AmrPerception(StrictModel):
    """§51 感知層（WareTwin 借鏡）：純由引擎交通判斷的輸入推導，前端畫扇形／射線。"""
    state: Literal["CLEAR", "CAUTION", "STOPPED"]
    heading: list[float] = Field(min_length=2, max_length=2)
    ahead_m: Optional[float] = None    # 前方 ±45° 錐內最近物體；None = 無
    nearest_m: Optional[float] = None
    safe_m: NonNeg
    clear_m: NonNeg
    hard_stop_m: NonNeg
    sense_m: NonNeg
    obstacles: list[PerceivedObject] = Field(default_factory=list)


class AmrSnapshot(StrictModel):
    """§12＋§39：粗粒度 status 沿用，細粒度 task_state 驅動 3D 行走。"""
    amr_id: str
    status: AmrStatus
    task_state: AmrTaskState
    battery_percent: Pct
    current_task: Optional[str] = None
    task_type: Optional[str] = None
    task_target: Optional[str] = None
    carrying: Optional[str] = None          # full / empty / fg
    phase_progress: float = Field(ge=0, le=1)
    phase_total_sec: NonNeg
    queue_length: NonNegInt
    position: list[float] = Field(min_length=2, max_length=2)
    # §47：權威路線（折線 [x,z]…）與沿線進度；交通狀態（讓行／改道）
    route: list[list[float]] = Field(default_factory=list)
    route_progress: float = Field(default=0.0, ge=0, le=1)
    traffic_state: Literal["CLEAR", "YIELDING", "REROUTED", "BLOCKED"] = "CLEAR"   # §53 BLOCKED=無安全路徑
    perception: Optional[AmrPerception] = None      # §51


class RackSnapshot(StrictModel):
    """§39.1 Cell-side Rack（Slot 欄位；權威=引擎）。"""
    rack_id: str
    cell_id: str
    sku: str
    capacity: NonNegInt
    qty: NonNegInt
    reorder_point: NonNegInt
    reserved: NonNegInt
    container_id: str
    last_replenished_time: Optional[str] = None
    material_low: bool
    stockout_sec: NonNeg


class SkuStock(StrictModel):
    sku: str
    qty: NonNegInt
    capacity: NonNegInt


class SupermarketSnapshot(StrictModel):
    """§44.2 Component Supermarket（v7：per-SKU 庫存 + 空箱架）。"""
    per_sku: list[SkuStock]
    empties: NonNegInt


class StagingSnapshot(StrictModel):
    """§44.8 Finished Goods Staging：shipped 於此卸貨才計入；滿 3 板出貨。
    §45.4：出貨改事件鏈（ASSIGNED→DOCKED→SHIPPED），門動畫由 door_open 驅動。"""
    units: NonNegInt
    pallet_size: NonNegInt
    pallets_per_truck: NonNegInt
    outbound_total: NonNegInt
    outbound_stage: Literal["IDLE", "ASSIGNED", "DOCKED"]
    door_open: bool
    outbound_progress: Ratio = 0.0
    shipment_id: Optional[str] = None


class FacilityUnit(StrictModel):
    """§45.8 廠務設備（欄位依設備不同；允許擴充）。"""
    model_config = ConfigDict(extra="allow")
    asset_id: str
    state: str


class ObstacleSnapshot(StrictModel):
    """§48 空間障礙物：有座標／半徑／剩餘時間；AMR 路線規劃繞開、移動鉗制。"""
    obstacle_id: str
    position: list[float] = Field(min_length=2, max_length=2)
    radius_m: NonNeg
    clearance_m: NonNeg = 0.0       # §49：規劃淨空（半徑 + hard_stop）——畫面第二圈
    label: str
    remaining_sec: NonNeg


class DispatchCandidate(StrictModel):
    """§51 派工候選評估（每台 AMR 一列；落選者附原因）。"""
    amr_id: str
    eligible: bool
    state: str
    battery_percent: Pct
    distance_m: NonNeg                 # 到取貨點（走廊 L 形 → 曼哈頓）
    pref_match: bool
    rank: Optional[int] = None         # 適格者排名（1 = 選中）
    rejected_reason: Optional[str] = None


class DispatchDecision(StrictModel):
    """§51 派工 Decision Record：規則、選中理由句、候選清單（WareTwin 借鏡）。"""
    decision_id: str
    task_id: str
    task_type: str
    target: str
    priority: int
    sim_tick: NonNegInt
    sim_time: str
    queue_wait_sec: NonNeg
    chosen: Optional[str] = None       # None = 延後（無適格 AMR）
    rule: str
    reason: str
    candidates: list[DispatchCandidate]


class FacilitySnapshot(StrictModel):
    """§45.8：compressor／hvac／fume_extraction／mdp／charger 狀態（由引擎推導）。"""
    compressor: FacilityUnit
    hvac: FacilityUnit
    fume_extraction: FacilityUnit
    mdp: FacilityUnit
    charger: FacilityUnit


class ReceivingSnapshot(StrictModel):
    """§45.3 收貨事件鏈：ARRIVED→DOOR_OPENING→UNLOADING→INSPECTING→WAIT_PICKUP。"""
    stage: Literal["IDLE", "ARRIVED", "DOOR_OPENING", "UNLOADING",
                   "INSPECTING", "WAIT_PICKUP"]
    sku: Optional[str] = None
    qty: NonNegInt
    door_open: bool
    truck_id: Optional[str] = None


class AmrKpiPerUnit(StrictModel):
    amr_id: str
    tasks_completed: NonNegInt
    busy_min: NonNeg
    distance_m: NonNeg
    charging_min: NonNeg
    battery: Pct


class AmrKpis(StrictModel):
    """§39.6 物流 KPI。"""
    utilization_pct: NonNeg
    tasks_completed: NonNegInt
    avg_task_wait_sec: NonNeg
    on_time_replenishment_pct: NonNeg
    stockout_min: NonNeg
    distance_m: NonNeg
    energy_kwh: NonNeg
    charging_min: NonNeg
    dock_wait_min: NonNeg
    starvation_from_logistics_min: NonNeg
    pending_tasks: NonNegInt
    per_amr: list[AmrKpiPerUnit]


class PartCounts(StrictModel):
    """§13.3 守恆式的權威計數：created = wip + good_completed + scrap。"""
    created: NonNegInt
    wip: NonNegInt
    good_completed: NonNegInt
    scrap: NonNegInt
    held: NonNegInt          # wip 子集
    rework_wip: NonNegInt    # wip 中 quality_state=REWORK_REQUIRED 的子集
    shipped: NonNegInt       # good_completed 中已由 AMR 出貨的子集


class ProductionOrder(StrictModel):
    """§10.3"""
    order_id: str
    line_id: str
    product_id: str
    target_quantity: NonNegInt
    completed_quantity: NonNegInt
    defect_quantity: NonNegInt
    priority: Literal["LOW", "NORMAL", "HIGH"]
    status: OrderStatus
    planned_start: str
    planned_end: str


class OeeBlock(StrictModel):
    """§18.2 OEE = A × P × Q（引擎計算，前端只顯示）。"""
    availability: Ratio
    performance: Ratio
    quality: Ratio
    oee: Ratio
    target_oee: Ratio


class KpiSnapshot(StrictModel):
    """§18 — 全部由同一組原始事件推導。"""
    total_output: NonNegInt
    good_units: NonNegInt
    defect_units: NonNegInt
    rework_units: NonNegInt
    wip: NonNegInt
    throughput_uph: NonNeg
    takt_time_sec: NonNeg
    target_good_units: NonNegInt
    first_pass_yield: Ratio
    defect_rate: Ratio
    oee: OeeBlock
    runtime_sec: NonNeg
    downtime_sec: NonNeg
    planned_time_sec: NonNeg
    avg_lead_time_sec: NonNeg          # §40.1（最近 100 件 good 的平均 lead time）
    energy_kwh_total: NonNeg
    idle_waste_kwh: NonNeg             # §41.1（idle/blocked/空轉 能耗）
    baseline_kw: NonNeg                # §41.2（參數模型解析期望；非實測平均）
    baseline_delta_pct: float          # §41.1（最近一分鐘平均 vs baseline，%）
    demand_limit_kw: NonNeg
    units_per_kwh: NonNeg
    energy_kwh_per_unit: NonNeg
    energy_kw_current: NonNeg
    peak_demand_kw: NonNeg


class MinutePoint(StrictModel):
    """引擎 per-minute aggregator 輸出（§10.7）；Live 與 Pre-roll 共用。"""
    sim_minute: str          # "HH:MM" (sim_time)
    good_units: NonNegInt
    defect_units: NonNegInt
    throughput_uph: NonNeg
    oee: Ratio
    defect_rate: Ratio
    energy_kw: NonNeg
    wip: NonNegInt


class TwinEvent(StrictModel):
    """§15.2"""
    event_id: str
    run_id: str
    seq: NonNegInt
    sim_tick: NonNegInt
    sim_time: str
    source_type: str
    source_id: str
    event_type: str
    severity: Severity
    line_id: Optional[str] = None
    cell_id: Optional[str] = None
    message: str
    value: Optional[float] = None
    threshold: Optional[float] = None
    acknowledged: bool = False


class Alert(StrictModel):
    """§19"""
    alert_id: str
    severity: Severity
    source_type: str
    source_id: str
    title: str
    detail: str
    sim_time: str
    event_seq: NonNegInt
    acknowledged: bool = False
    resolved: bool = False


class FactoryEnvironment(StrictModel):
    temperature_c: float
    humidity_percent: Pct
    system_status: Literal["NORMAL", "DEGRADED", "ALARM"]


class LineSnapshot(StrictModel):
    line_id: str
    name: str
    state: LineState
    bottleneck_cell_id: Optional[str] = None


# ---------------------------------------------------------------- envelope (§14.2)

class FactoryState(StrictModel):
    """Snapshot payload（`state` 欄位內容）。"""
    factory_id: str
    environment: FactoryEnvironment
    line: LineSnapshot
    cells: list[CellSnapshot]
    conveyors: list[ConveyorSnapshot]
    amrs: list[AmrSnapshot]
    robots: list[RobotState]
    raw_buffer: BufferSnapshot
    rework_buffer: BufferSnapshot
    finished_buffer: BufferSnapshot
    parts: PartCounts
    racks: list[RackSnapshot]
    supermarket: SupermarketSnapshot
    staging: StagingSnapshot
    receiving: ReceivingSnapshot
    facility: FacilitySnapshot
    obstacles: list[ObstacleSnapshot] = Field(default_factory=list)   # §48
    dispatch_decisions: list[DispatchDecision] = Field(default_factory=list)  # §51
    amr_kpis: AmrKpis
    orders: list[ProductionOrder]
    kpis: KpiSnapshot
    history_minutes: list[MinutePoint]
    recent_events: list[TwinEvent]
    alerts: list[Alert]
    simulated_history: bool


class ControlState(StrictModel):
    """§51 模擬控制狀態（後端權威；多分頁一致）。§52：seq 單調遞增，前端拒收倒退的控制狀態。"""
    paused: bool
    speed: float = Field(gt=0)
    seq: NonNegInt = 0


class SnapshotMessage(StrictModel):
    """§14.2 — seq 為此快照已包含到哪一筆 Event；Snapshot 本身不占序號。"""
    type: Literal["snapshot"]
    schema_version: str
    run_id: str
    seq: NonNegInt
    sim_tick: NonNegInt
    sim_time: str
    generated_at: str
    provenance: RunProvenance
    state: FactoryState
    control: Optional[ControlState] = None      # §51：Live 後端填；fixture／demo 可省略


class ControlMessage(StrictModel):
    """§51 控制變更廣播（暫停／播放／倍速／Reset 後）：所有分頁以此同步。無 seq。"""
    type: Literal["control"]
    schema_version: str
    run_id: str
    sim_tick: NonNegInt
    control: ControlState


class EventMessage(StrictModel):
    """§14.2 — 只有 Event 遞增 seq。"""
    type: Literal["event"]
    schema_version: str
    run_id: str
    seq: NonNegInt
    sim_tick: NonNegInt
    sim_time: str
    generated_at: str
    event: TwinEvent


class AmrPatchEntry(StrictModel):
    """§50：單台 AMR 的增量（只帶變動欄位）。"""
    amr_id: str
    position: Optional[list[float]] = Field(default=None, min_length=2, max_length=2)
    route: Optional[list[list[float]]] = None
    route_progress: Optional[float] = Field(default=None, ge=0, le=1)
    phase_progress: Optional[float] = Field(default=None, ge=0, le=1)
    status: Optional[AmrStatus] = None
    task_state: Optional[AmrTaskState] = None
    traffic_state: Optional[Literal["CLEAR", "YIELDING", "REROUTED", "BLOCKED"]] = None
    carrying: Optional[str] = None
    battery_percent: Optional[Pct] = None
    perception: Optional[AmrPerception] = None     # §51


class AmrPatchMessage(StrictModel):
    """§50（WareTwin 借鏡）：AMR 位置 10 Hz 增量串流；不遞增 seq（非事件）、
    不取代 1 Hz snapshot（snapshot 每秒整份覆蓋）。"""
    type: Literal["amr_patch"]
    schema_version: str
    run_id: str
    sim_tick: NonNegInt
    sim_time: str
    generated_at: Optional[str] = None
    amrs: list[AmrPatchEntry]


class ExplanationResult(StrictModel):
    """§22.2 — AI/規則式解釋的固定格式；不得缺少證據與不確定性標示。"""
    summary: str
    primary_cause: str
    evidence: list[str] = Field(min_length=1)
    recommended_actions: list[str]
    confidence: Ratio
    assumptions: list[str] = Field(min_length=1)
    expected_impact: str
    risk: str
    requires_human_approval: bool
    is_simulation_result: bool


class ScenarioSide(StrictModel):
    run_id: str
    kpis: dict
    provenance: RunProvenance


class MetricRow(StrictModel):
    """§50：Baseline vs Scenario 對照一列（方向感知）。"""
    key: str
    label: str
    higher_is_better: bool
    baseline: float
    scenario: float
    delta: float
    delta_pct: Optional[float] = None
    better: Optional[bool] = None


class FirstDivergence(StrictModel):
    """§50：兩條事件流（略過注入事件本身）第一個不同的事件。"""
    index: NonNegInt
    sim_tick: NonNegInt
    sim_time: str
    baseline_event: Optional[str] = None
    scenario_event: Optional[str] = None
    message: str


class ScenarioResult(StrictModel):
    """§23 What-if 比較結果（12 項 KPI delta）。"""
    scenario_id: str
    injection: dict
    horizon_min: int
    branch_from: BranchFrom
    baseline: ScenarioSide
    scenario: ScenarioSide
    deltas: dict
    metrics: list[MetricRow] = Field(default_factory=list)          # §50：12 項統一對照表
    first_divergence: Optional[FirstDivergence] = None               # §50：事件流第一分岔
    evidence_raw: dict
    explanation: Optional[ExplanationResult] = None


WIRE_MODELS = [SnapshotMessage, EventMessage, ScenarioResult, ExplanationResult, AmrPatchMessage,
               ControlMessage]
