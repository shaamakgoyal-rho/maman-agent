export {
  segmentEpisodes,
  canonicalToken,
  maxSensitivity,
  INACTIVITY_BOUNDARY_MS,
  EVENT_GAP_BOUNDARY_MS,
  MIN_EPISODE_EVENTS,
  MIN_EPISODE_ACTIVE_MS,
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
  type PatternScores,
} from "./scoring.js";
export {
  runPatternEngine,
  patternSignature,
  type EngineOptions,
  type EngineResult,
  type WatchingPattern,
} from "./engine.js";
export { deterministicName, type NamingResult } from "./naming.js";
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
