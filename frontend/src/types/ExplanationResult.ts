/* 由 schemas/*.schema.json 產生（ADR-003）。禁止手動編輯。
 * 重新產生：node scripts/generate_types.mjs
 */
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
