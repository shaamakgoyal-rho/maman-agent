/**
 * Episode similarity (spec §11):
 * 1. MinHash + LSH banding to find candidate neighbor pairs cheaply.
 * 2. Normalized weighted Levenshtein over canonical token sequences.
 * 3. Duration and application-overlap checks.
 * 4. Complete-linkage clustering at the (default) 0.82 threshold.
 */

export const DEFAULT_SIMILARITY_THRESHOLD = 0.82;

// Locked substitution weights.
const W_SAME_APP_SAME_TYPE_DIFF_ROLE = 0.25;
const W_SAME_APP_DIFF_TYPE = 0.6;
const W_DIFF_APP_EQUIVALENT_ACTION = 0.5;
const W_UNRELATED = 1.0;
const W_INDEL = 0.7;

type TokenParts = {
  source: string;
  app: string;
  eventType: string;
  role: string;
  semantic: string;
  object: string;
};

function parseToken(token: string): TokenParts {
  const [source = "-", app = "-", eventType = "-", role = "-", semantic = "-", object = "-"] =
    token.split(":");
  return { source, app, eventType, role, semantic, object };
}

/** Cost of substituting token a with token b (0 = identical). */
export function substitutionCost(a: string, b: string): number {
  if (a === b) return 0;
  const pa = parseToken(a);
  const pb = parseToken(b);
  const sameApp = pa.app === pb.app;
  const sameType = pa.eventType === pb.eventType;
  if (sameApp && sameType) return W_SAME_APP_SAME_TYPE_DIFF_ROLE;
  if (sameApp) return W_SAME_APP_DIFF_TYPE;
  // Different app, semantically equivalent action: same event type AND same
  // object family means the same business action performed elsewhere.
  if (sameType && pa.object === pb.object) return W_DIFF_APP_EQUIVALENT_ACTION;
  return W_UNRELATED;
}

/** Normalized weighted Levenshtein similarity in 0..1. */
export function sequenceSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = new Float64Array(rows * cols);
  for (let i = 1; i < rows; i++) d[i * cols] = i * W_INDEL;
  for (let j = 1; j < cols; j++) d[j] = j * W_INDEL;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const sub = d[(i - 1) * cols + (j - 1)]! + substitutionCost(a[i - 1]!, b[j - 1]!);
      const del = d[(i - 1) * cols + j]! + W_INDEL;
      const ins = d[i * cols + (j - 1)]! + W_INDEL;
      d[i * cols + j] = Math.min(sub, del, ins);
    }
  }
  const distance = d[rows * cols - 1]!;
  const maxDistance = Math.max(a.length, b.length) * W_INDEL;
  // Worst case is all-indel; substitutions can exceed indel pairs slightly,
  // so clamp for safety.
  return Math.max(0, Math.min(1, 1 - distance / maxDistance));
}

// ---- MinHash + LSH ----

const MINHASH_FUNCTIONS = 64;
const LSH_BANDS = 16; // 16 bands x 4 rows

function hash32(value: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 2-shingles of the token sequence. */
function shingles(tokens: string[]): string[] {
  if (tokens.length === 1) return [tokens[0]!];
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]}${tokens[i + 1]}`);
  return out;
}

export function minhashSignature(tokens: string[]): Uint32Array {
  const sig = new Uint32Array(MINHASH_FUNCTIONS).fill(0xffffffff);
  for (const shingle of shingles(tokens)) {
    for (let f = 0; f < MINHASH_FUNCTIONS; f++) {
      const h = hash32(shingle, f * 0x9e3779b9);
      if (h < sig[f]!) sig[f] = h;
    }
  }
  return sig;
}

/** Candidate neighbor pairs via LSH banding (indexes into `sequences`). */
export function candidatePairs(sequences: string[][]): Array<[number, number]> {
  const signatures = sequences.map(minhashSignature);
  const rowsPerBand = MINHASH_FUNCTIONS / LSH_BANDS;
  const buckets = new Map<string, number[]>();
  signatures.forEach((sig, index) => {
    for (let band = 0; band < LSH_BANDS; band++) {
      const key =
        `${band}:` + Array.from(sig.slice(band * rowsPerBand, (band + 1) * rowsPerBand)).join(",");
      const bucket = buckets.get(key) ?? [];
      bucket.push(index);
      buckets.set(key, bucket);
    }
  });
  const pairs = new Set<string>();
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        pairs.add(`${bucket[i]},${bucket[j]}`);
      }
    }
  }
  return [...pairs].map((p) => p.split(",").map(Number) as [number, number]);
}

// ---- clustering ----

export type ClusterInput = {
  tokens: string[];
  active_duration_ms: number;
  app_categories: string[];
};

/** Duration check: within 3x of each other; app overlap: Jaccard >= 0.5. */
export function passesSanityChecks(a: ClusterInput, b: ClusterInput): boolean {
  const [lo, hi] = [
    Math.min(a.active_duration_ms, b.active_duration_ms),
    Math.max(a.active_duration_ms, b.active_duration_ms),
  ];
  if (lo === 0 || hi / lo > 3) return false;
  const setA = new Set(a.app_categories);
  const union = new Set([...a.app_categories, ...b.app_categories]);
  const intersection = b.app_categories.filter((c) => setA.has(c)).length;
  return union.size > 0 && intersection / union.size >= 0.5;
}

/**
 * Complete-linkage clustering: a cluster only forms/grows when EVERY pair
 * inside it meets the similarity threshold and sanity checks.
 * Returns clusters as index arrays plus each cluster's mean pairwise similarity.
 */
export function clusterEpisodes(
  inputs: ClusterInput[],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): Array<{ members: number[]; similarity_mean: number }> {
  const n = inputs.length;
  if (n === 0) return [];

  // Candidate pair discovery: exact all-pairs for small sets; MinHash/LSH
  // banding above that (LSH is probabilistic — acceptable only at scale,
  // where a missed borderline pair costs little).
  const EXACT_PAIRWISE_LIMIT = 64;
  const pairs: Array<[number, number]> =
    n <= EXACT_PAIRWISE_LIMIT
      ? Array.from({ length: n }, (_, i) =>
          Array.from({ length: n - i - 1 }, (_, k) => [i, i + k + 1] as [number, number]),
        ).flat()
      : candidatePairs(inputs.map((x) => x.tokens));

  const sim = new Map<string, number>();
  const key = (i: number, j: number) => (i < j ? `${i},${j}` : `${j},${i}`);
  for (const [i, j] of pairs) {
    if (!passesSanityChecks(inputs[i]!, inputs[j]!)) continue;
    sim.set(key(i, j), sequenceSimilarity(inputs[i]!.tokens, inputs[j]!.tokens));
  }
  const similarity = (i: number, j: number) => sim.get(key(i, j)) ?? 0;

  // Agglomerative complete linkage.
  let clusters: number[][] = Array.from({ length: n }, (_, i) => [i]);
  for (;;) {
    let best: { a: number; b: number; s: number } | null = null;
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        // complete linkage = MINIMUM pairwise similarity between clusters
        let minSim = Infinity;
        for (const i of clusters[a]!) {
          for (const j of clusters[b]!) {
            minSim = Math.min(minSim, similarity(i, j));
            if (minSim < threshold) break;
          }
          if (minSim < threshold) break;
        }
        if (minSim >= threshold && (best === null || minSim > best.s)) {
          best = { a, b, s: minSim };
        }
      }
    }
    if (!best) break;
    const merged = [...clusters[best.a]!, ...clusters[best.b]!];
    clusters = clusters.filter((_, idx) => idx !== best.a && idx !== best.b);
    clusters.push(merged);
  }

  return clusters.map((members) => {
    if (members.length === 1) return { members, similarity_mean: 1 };
    let total = 0;
    let count = 0;
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        total += similarity(members[x]!, members[y]!);
        count++;
      }
    }
    return { members, similarity_mean: count ? total / count : 1 };
  });
}
