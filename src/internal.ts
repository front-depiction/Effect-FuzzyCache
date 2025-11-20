/**
 * Internal utilities for FuzzyCache
 *
 * @since 1.0.0
 */
import * as Hash from "effect/Hash"
import * as Equal from "effect/Equal"
import * as Data from "effect/Data"
import * as Record from "effect/Record"
import * as Either from "effect/Either"
import * as Number from "effect/Number"
import * as Option from "effect/Option"
import { pipe } from "effect/Function"

/**
 * Matcher configuration for a single parameter
 *
 * @since 1.0.0
 * @category models
 */
export type ParamMatcher<A> = Data.TaggedEnum<{
  Exact: {},
  Fuzzy: { readonly scorer: (cached: A, query: A) => number }
}>

interface ParamMatcherDefinitionn extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: ParamMatcher<this["A"]>
}

export const ParamMatcher = Data.taggedEnum<ParamMatcherDefinitionn>()

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
 * Stores the exact-match parameters and computes a structural hash using Effect's Hash.structure.
 * Uses prototype-based implementation for better performance.
 *
 * @since 1.0.0
 * @category models
 */
export interface BucketKey extends Equal.Equal {
  readonly exactParams: Record<string, unknown>
}

const BucketKeyProto: Omit<BucketKey, "exactParams"> = {
  [Hash.symbol](this: BucketKey): number {
    // Hash.structure is commutative (order-independent) for objects
    return Hash.cached(this, Hash.structure(this.exactParams))
  },

  [Equal.symbol](this: BucketKey, that: BucketKey): boolean {
    // Simple structural comparison of the exactParams records
    // We can iterate keys and use Equal.equals on each value
    const thisKeys = Object.keys(this.exactParams)
    const thatKeys = Object.keys(that.exactParams)

    if (thisKeys.length !== thatKeys.length) return false

    for (const key of thisKeys) {
      if (!(key in that.exactParams)) return false
      if (!Equal.equals(this.exactParams[key], that.exactParams[key])) return false
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
  readonly timeToLiveMillis: number  // Absolute expiration timestamp (now + ttl)
  readonly loadedMillis: number  // Timestamp when entry was created/loaded
}

/**
 * Check if a cache entry has expired
 *
 * @since 1.0.0
 * @category utilities
 */
export const hasExpired = <Value>(entry: CacheEntry<Value>, now: number): boolean =>
  now >= entry.timeToLiveMillis

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
  const [exact, fuzzy] = Record.partitionMap(params, (value, key) => {
    const matcher = config[key as keyof Params]
    // Left = exact, Right = fuzzy (partitionMap returns [left, right])
    return ParamMatcher.$is("Exact")(matcher) ? Either.left(value) : Either.right(value)
  })

  return { exact: exact as Partial<Params>, fuzzy: fuzzy as Partial<Params> }
}

/**
 * Create a bucket key from exact-match parameters
 *
 * Uses Effect's Hash.structure for efficient order-independent structural hashing of the parameters.
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
export const scoreEntry = <Params extends Record<string, unknown>>(
  entry: CacheEntry<unknown>,
  queryParams: Params,
  config: FuzzyConfig<Params>
): number => pipe(
  config,
  Record.map((matcher, key) =>
    ParamMatcher.$match(matcher, {
      Exact: () => 1,
      Fuzzy: ({ scorer }) => scorer(entry.params[key] as any, queryParams[key] as any)
    })),
  Record.values,
  Number.sumAll,
  Number.divide(Record.size(config)),
  Option.getOrElse(() => 0)
)


/**
 * Generate a unique ID for cache entries
 *
 * @since 1.0.0
 * @category utilities
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
}




export const cacheVariance = {
  /* c8 ignore next */
  _Key: (_: any) => _,
  /* c8 ignore next */
  _Error: (_: never) => _,
  /* c8 ignore next */
  _Value: (_: any) => _
}


export const consumerCacheVariance = {
  /* c8 ignore next */
  _Key: (_: any) => _,
  /* c8 ignore next */
  _Error: (_: never) => _,
  /* c8 ignore next */
  _Value: (_: never) => _
}
