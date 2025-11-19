/**
 * Internal utilities for FuzzyCache
 *
 * @since 1.0.0
 */
import * as Hash from "effect/Hash"
import * as Equal from "effect/Equal"

/**
 * Matcher configuration for a single parameter
 *
 * @since 1.0.0
 * @category models
 */
export type ParamMatcher<A> =
  | { readonly _tag: "Exact" }
  | { readonly _tag: "Fuzzy"; readonly scorer: (cached: A, query: A) => number }

/**
 * Configuration mapping parameter names to matchers
 *
 * @since 1.0.0
 * @category models
 */
export type FuzzyConfig<Params extends Record<string, unknown>> = {
  readonly [K in keyof Params]: ParamMatcher<Params[K]>
}

/**
 * A bucket key that implements Hash and Equal for Effect's Cache
 *
 * @since 1.0.0
 * @category models
 */
export class BucketKey implements Equal.Equal {
  constructor(readonly hash: number) {}

  [Hash.symbol](): number {
    return this.hash
  }

  [Equal.symbol](that: unknown): boolean {
    if (this === that) return true
    if (!(that instanceof BucketKey)) return false
    return this.hash === that.hash
  }
}

/**
 * Cache entry stored in buckets
 *
 * @since 1.0.0
 * @category models
 */
export interface CacheEntry<Value> {
  readonly id: string
  readonly params: Record<string, unknown>
  readonly value: Value
  readonly timestamp: number
}

/**
 * Partition parameters into exact-match and fuzzy-match groups
 *
 * @since 1.0.0
 * @category utilities
 */
export function partitionParams<Params extends Record<string, unknown>>(
  params: Params,
  config: FuzzyConfig<Params>
): {
  exact: Partial<Params>
  fuzzy: Partial<Params>
} {
  const exact: Record<string, unknown> = {}
  const fuzzy: Record<string, unknown> = {}

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const matcher = config[key]
      if (matcher._tag === "Exact") {
        exact[key] = params[key]
      } else {
        fuzzy[key] = params[key]
      }
    }
  }

  return { exact: exact as Partial<Params>, fuzzy: fuzzy as Partial<Params> }
}

/**
 * Create a bucket key from exact-match parameters using Hash.hash
 *
 * @since 1.0.0
 * @category utilities
 */
export function createBucketKey(exactParams: Record<string, unknown>): BucketKey {
  // Sort keys for deterministic hashing
  const sorted = Object.keys(exactParams)
    .sort()
    .map(key => `${key}:${JSON.stringify(exactParams[key])}`)
    .join("|")

  const hash = Hash.hash(sorted)

  return new BucketKey(hash)
}

/**
 * Score a cache entry against query parameters
 *
 * @since 1.0.0
 * @category utilities
 */
export function scoreEntry<Params extends Record<string, unknown>>(
  entry: CacheEntry<unknown>,
  queryParams: Params,
  config: FuzzyConfig<Params>
): number {
  const scores: number[] = []

  for (const key in config) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      const matcher = config[key]

      if (matcher._tag === "Exact") {
        // Exact params already match (we're in the correct bucket)
        scores.push(1.0)
      } else {
        // Run custom scorer function
        const cachedValue = entry.params[key] as Params[Extract<keyof Params, string>]
        const queryValue = queryParams[key]
        const score = matcher.scorer(cachedValue, queryValue)
        scores.push(score)
      }
    }
  }

  // Average all scores
  if (scores.length === 0) return 0
  return scores.reduce((sum, score) => sum + score, 0) / scores.length
}

/**
 * Generate a unique ID for cache entries
 *
 * @since 1.0.0
 * @category utilities
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
}
