/**
 * Matcher factories for FuzzyCache parameter matching strategies
 *
 * @since 1.0.0
 */
import type { ParamMatcher } from "./internal"

/**
 * Creates an exact matcher that requires parameter values to match exactly.
 *
 * Exact matchers are used for parameters that must match precisely during cache lookups.
 * These parameters are used for bucketing, grouping cache entries with identical exact values.
 *
 * @since 1.0.0
 * @category constructors
 * @example
 * ```typescript
 * import * as Matchers from "./matchers"
 *
 * const userIdMatcher = Matchers.Exact<string>()
 * // Used in config: { userId: Matchers.Exact() }
 * ```
 */
export const Exact = <A>(): ParamMatcher<A> => ({ _tag: "Exact" })

/**
 * Creates a fuzzy matcher with a custom scoring function.
 *
 * The scorer function receives a cached value and a query value, returning a score
 * between 0.0 (no match) and 1.0 (perfect match). Scores above a threshold are
 * considered valid matches.
 *
 * @since 1.0.0
 * @category constructors
 * @example
 * ```typescript
 * import * as Matchers from "./matchers"
 *
 * const ageMatcher = Matchers.Fuzzy<number>((cached, query) => {
 *   const diff = Math.abs(cached - query)
 *   return diff <= 5 ? 1.0 - (diff / 5) : 0.0
 * })
 * ```
 */
export const Fuzzy = <A>(scorer: (cached: A, query: A) => number): ParamMatcher<A> => ({
  _tag: "Fuzzy",
  scorer
})

/**
 * Computes the Levenshtein distance between two strings.
 *
 * The Levenshtein distance is the minimum number of single-character edits
 * (insertions, deletions, or substitutions) required to change one string into another.
 *
 * @internal
 */
function computeLevenshtein(a: string, b: string): number {
  const matrix: number[][] = []

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1, // substitution
          matrix[i]![j - 1]! + 1,     // insertion
          matrix[i - 1]![j]! + 1      // deletion
        )
      }
    }
  }

  return matrix[b.length]![a.length]!
}

/**
 * Creates a fuzzy string matcher using Levenshtein distance.
 *
 * The matcher computes the edit distance between strings and normalizes it by the
 * maximum string length. Strings with normalized distance below the threshold are
 * considered matches, with scores reflecting similarity (1.0 = identical, 0.0 = completely different).
 *
 * @param threshold - Maximum normalized distance for a match (0.0 to 1.0). Lower values require closer matches.
 * @returns A fuzzy matcher for string parameters
 *
 * @since 1.0.0
 * @category constructors
 * @example
 * ```typescript
 * import * as Matchers from "./matchers"
 *
 * // Match strings with up to 20% difference
 * const nameMatcher = Matchers.levenshtein(0.2)
 *
 * // "Alice" and "Alise" have distance 1, length 5, normalized = 0.2
 * // Score: 1.0 - 0.2 = 0.8 (match)
 *
 * // "Alice" and "Bob" have distance 5, length 5, normalized = 1.0
 * // Score: 0.0 (no match)
 * ```
 */
export const levenshtein = (threshold: number): ParamMatcher<string> =>
  Fuzzy<string>((cached, query) => {
    const distance = computeLevenshtein(cached, query)
    const maxLength = Math.max(cached.length, query.length)

    // Handle empty strings
    if (maxLength === 0) return 1.0

    const normalized = distance / maxLength

    // If beyond threshold, return 0
    if (normalized > threshold) return 0.0

    // Return similarity score (1.0 = identical, 0.0 = at threshold)
    return 1.0 - normalized
  })

/**
 * Creates a fuzzy numeric matcher with tolerance-based matching.
 *
 * Numbers within the tolerance range receive a score of 1.0. Numbers beyond the
 * tolerance decay proportionally, reaching 0.0 at double the tolerance distance.
 *
 * @param tolerance - Maximum absolute difference for a perfect match
 * @returns A fuzzy matcher for numeric parameters
 *
 * @since 1.0.0
 * @category constructors
 * @example
 * ```typescript
 * import * as Matchers from "./matchers"
 *
 * const priceMatcher = Matchers.numeric(10)
 *
 * // Query: 100
 * // Cached: 105 -> diff = 5, within tolerance -> score = 1.0
 * // Cached: 115 -> diff = 15, beyond tolerance -> score = 1.0 - ((15-10)/10) = 0.5
 * // Cached: 120 -> diff = 20, at 2x tolerance -> score = 0.0
 * // Cached: 125 -> diff = 25, beyond 2x tolerance -> score = 0.0
 * ```
 */
export const numeric = (tolerance: number): ParamMatcher<number> =>
  Fuzzy<number>((cached, query) => {
    const diff = Math.abs(cached - query)

    // Within tolerance: perfect match
    if (diff <= tolerance) return 1.0

    // Beyond tolerance: decay proportionally
    // At 2x tolerance, score reaches 0
    const excess = diff - tolerance
    const score = 1.0 - (excess / tolerance)

    return Math.max(0.0, score)
  })
