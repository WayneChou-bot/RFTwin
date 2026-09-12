/* 由 schemas/*.schema.json 產生（ADR-003）。禁止手動編輯。
 * 重新產生：node scripts/generate_types.mjs
 */
export type ScenarioId = string;
export type HorizonMin = number;
export type RunId = string;
export type Seq = number;
export type RunId1 = string;
export type RunId2 = string;
export type EngineVersion = string;
export type DomainVersion = string;
export type SchemaVersion = string;
export type ParameterSetId = string;
export type ParameterHash = string;
export type Seed = number;
export type LayoutId = string | null;
export type LayoutHash = string | null;
export type InitialSnapshotId = string | null;
export type Key = string;
export type Label = string;
export type HigherIsBetter = boolean;
export type Baseline = number;
export type Scenario = number;
export type Delta = number;
export type DeltaPct = number | null;
export type Better = boolean | null;
export type Metrics = MetricRow[];
export type Index = number;
export type SimTick = number;
export type SimTime = string;
export type BaselineEvent = string | null;
export type ScenarioEvent = string | null;
export type Message = string;
export type Summary = string;
export type PrimaryCause = string;
/**
 * @minItems 1
 */
export type Evidence = [string, ...string[]];
export type RecommendedActions = string[];
export type Confidence = number;
/**
 * @minItems 1
 */
export type Assumptions = [string, ...string[]];
export type ExpectedImpact = string;
export type Risk = string;
export type RequiresHumanApproval = boolean;
export type IsSimulationResult = boolean;

/**
 * §23 What-if 比較結果（12 項 KPI delta）。
 */
export interface ScenarioResult {
  scenario_id: ScenarioId;
  injection: Injection;
  horizon_min: HorizonMin;
  branch_from: BranchFrom;
  baseline: ScenarioSide;
  scenario: ScenarioSide;
  deltas: Deltas;
  metrics?: Metrics;
  first_divergence?: FirstDivergence | null;
  evidence_raw: EvidenceRaw;
  explanation?: ExplanationResult | null;
}
export interface Injection {
  [k: string]: unknown;
}
export interface BranchFrom {
  run_id: RunId;
  seq: Seq;
}
export interface ScenarioSide {
  run_id: RunId1;
  kpis: Kpis;
  provenance: RunProvenance;
}
export interface Kpis {
  [k: string]: unknown;
}
export interface RunProvenance {
  run_id: RunId2;
  engine_version: EngineVersion;
  domain_version: DomainVersion;
  schema_version: SchemaVersion;
  parameter_set_id: ParameterSetId;
  parameter_hash: ParameterHash;
  seed: Seed;
  layout_id?: LayoutId;
  layout_hash?: LayoutHash;
  initial_snapshot_id?: InitialSnapshotId;
  branch_from?: BranchFrom | null;
}
export interface Deltas {
  [k: string]: unknown;
}
/**
 * §50：Baseline vs Scenario 對照一列（方向感知）。
 */
export interface MetricRow {
  key: Key;
  label: Label;
  higher_is_better: HigherIsBetter;
  baseline: Baseline;
  scenario: Scenario;
  delta: Delta;
  delta_pct?: DeltaPct;
  better?: Better;
}
/**
 * §50：兩條事件流（略過注入事件本身）第一個不同的事件。
 */
export interface FirstDivergence {
  index: Index;
  sim_tick: SimTick;
  sim_time: SimTime;
  baseline_event?: BaselineEvent;
  scenario_event?: ScenarioEvent;
  message: Message;
}
export interface EvidenceRaw {
  [k: string]: unknown;
}
/**
 * §22.2 — AI/規則式解釋的固定格式；不得缺少證據與不確定性標示。
 */
export interface ExplanationResult {
  summary: Summary;
  primary_cause: PrimaryCause;
  evidence: Evidence;
  recommended_actions: RecommendedActions;
  confidence: Confidence;
  assumptions: Assumptions;
  expected_impact: ExpectedImpact;
  risk: Risk;
  requires_human_approval: RequiresHumanApproval;
  is_simulation_result: IsSimulationResult;
}
