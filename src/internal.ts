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
 * Stores the exact-match parameters and computes a structural hash using Effect's Hash.structureKeys.
 * Uses prototype-based implementation for better performance.
 *
 * @since 1.0.0
 * @category models
 */
export interface BucketKey extends Equal.Equal {
  readonly exactParams: Record<string, unknown>
  _cachedHash?: number
}

const BucketKeyProto: Omit<BucketKey, "exactParams" | "_cachedHash"> = {
  [Hash.symbol](this: BucketKey): number {
    if (this._cachedHash !== undefined) {
      return this._cachedHash
    }

    // Sort keys for deterministic hashing
    const keys = Object.keys(this.exactParams).sort()

    // Use Hash.structureKeys for efficient structural hashing
    const hash = Hash.structureKeys(this.exactParams, keys)

    // Cache the hash by mutating (safe since it's deterministic)
    ;(this as { _cachedHash?: number })._cachedHash = hash

    return hash
  },

  [Equal.symbol](this: BucketKey, that: unknown): boolean {
    if (this === that) return true
    if (typeof that !== "object" || that === null) return false
    if (!("exactParams" in that)) return false

    const thatKey = that as BucketKey

    // Fast path: compare cached hashes if both are computed
    if (this._cachedHash !== undefined && thatKey._cachedHash !== undefined) {
      if (this._cachedHash !== thatKey._cachedHash) return false
    }

    // Deep equality check on exactParams
    const thisKeys = Object.keys(this.exactParams).sort()
    const thatKeys = Object.keys(thatKey.exactParams).sort()

    // Different number of keys
    if (thisKeys.length !== thatKeys.length) return false

    // Check all keys and values match
    for (let i = 0; i < thisKeys.length; i++) {
      const key = thisKeys[i]
      if (key !== thatKeys[i]) return false
      if (!Equal.equals(this.exactParams[key], thatKey.exactParams[key])) return false
    }

    return true
  }
}

/**
 * Create a new BucketKey with the given exact-match parameters
 *
 * @since 1.0.0
 * @category constructors
 */
export const makeBucketKey = (exactParams: Record<string, unknown>): BucketKey => {
  return Object.create(BucketKeyProto, {
    exactParams: {
      value: exactParams,
      enumerable: true,
      writable: false
    }
  })
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
 * Create a bucket key from exact-match parameters
 *
 * Uses Effect's Hash.structureKeys for efficient structural hashing of the parameters.
 * The BucketKey caches the computed hash for performance.
 *
 * @since 1.0.0
 * @category utilities
 */
export function createBucketKey(exactParams: Record<string, unknown>): BucketKey {
  return makeBucketKey(exactParams)
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
