/**
 * Matcher factories for FuzzyCache parameter matching strategies
 *
 * @since 1.0.0
 */
import * as Option from "effect/Option"
import { ParamMatcher } from "./internal/config.js"


export const Exact = ParamMatcher.Exact
export const Fuzzy = <A>(scorer: (cached: A, query: A) => Option.Option<number>) => ParamMatcher.Fuzzy({ scorer })
export const match = ParamMatcher.$match
export const isFuzzy = ParamMatcher.$is("Fuzzy")
export const isExact = ParamMatcher.$is("Exact")

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
  Fuzzy<string>((cached, query): Option.Option<number> => {
    const distance = computeLevenshtein(cached, query)
    const maxLength = Math.max(cached.length, query.length)

    // Handle empty strings
    if (maxLength === 0) return Option.some(1.0)

    const normalized = distance / maxLength

    // If beyond threshold, exclude entry entirely
    if (normalized > threshold) return Option.none()

    // Return similarity score (1.0 = identical, 0.0 = at threshold)
    return Option.some(1.0 - normalized)
  })

/**
 * Creates a fuzzy numeric matcher with tolerance-based matching.
 * Numbers are discarded beyond tolerance, and scored based on the distance from the target.
 *
 * @param tolerance - Maximum absolute difference for a perfect match
 * @returns A fuzzy matcher for numeric parameters
 *
 * @since 1.0.0
 * @category constructors
 */
export const numeric = (tolerance: number): ParamMatcher<number> => {
  // Degenerate case: no tolerance -> only exact matches
  if (tolerance <= 0) {
    return Fuzzy<number>((cached, query) =>
      cached === query ? Option.some(1.0) : Option.none()
    )
  }

  const invTolerance = 1 / tolerance

  return Fuzzy<number>((cached, query) => {
    const diff = Math.abs(cached - query)

    // Outside tolerance → no match
    if (diff > tolerance) return Option.none()

    // Inside tolerance: score from 1.0 (exact) down to 0.0 (at boundary)
    const score = 1.0 - diff * invTolerance
    return Option.some(score)
  })
}

