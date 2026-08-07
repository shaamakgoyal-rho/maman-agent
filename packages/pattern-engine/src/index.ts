export {
  segmentEpisodes,
  canonicalToken,
  maxSensitivity,
  INACTIVITY_BOUNDARY_MS,
  EVENT_GAP_BOUNDARY_MS,
  MIN_EPISODE_EVENTS,
  MIN_EPISODE_ACTIVE_MS,
  DERIVED_DURATION_CAP_MS,
  type SegmentationOptions,
  type SegmentedEpisode,
} from "./segmentation.js";
export {
  sequenceSimilarity,
  substitutionCost,
  minhashSignature,
  candidatePairs,
  clusterEpisodes,
  passesSanityChecks,
  DEFAULT_SIMILARITY_THRESHOLD,
} from "./similarity.js";
export {
  scorePattern,
  feasibilityScore,
  riskScore,
  errorReductionScore,
  projectedMinutesSavedWeekly,
  distinctDayCount,
  median,
  percentile,
  clamp01,
  representativeSequence,
  ELIGIBILITY,
  OPPORTUNITY_THRESHOLD,
  type EligibilityThresholds,
  type PatternScores,
} from "./scoring.js";
export {
  runPatternEngine,
  patternSignature,
  effectiveEligibility,
  type EngineOptions,
  type EngineResult,
  type TunableEligibility,
  type WatchingPattern,
} from "./engine.js";
export { deterministicName, describeObserved, stepPhrase, type NamingResult } from "./naming.js";
export {
  explainWorkflowSteps,
  type WorkflowExplanation,
  type ObservedStepExplanation,
  type StepAutomation,
  type AutomationStep,
} from "./explain.js";
export { toPatternFeature, categorizeApp } from "./projection.js";
export {
  replayCandidate,
  replayAgainstTrace,
  humanizeToken,
  type ReplayReport,
  type ReplayRunResult,
  type ReplayVerdict,
  type EpisodeTrace,
} from "./replay.js";
