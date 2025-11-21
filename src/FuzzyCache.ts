/**
 * FuzzyCache - A bucket-based fuzzy cache that extends Effect's Cache
 *
 * @since 1.0.0
 */
import * as Cache from "effect/Cache"
import * as Effect from "effect/Effect"
import * as Duration from "effect/Duration"
import * as Option from "effect/Option"
import * as Either from "effect/Either"
import * as Predicate from "effect/Predicate"
import * as Exit from "effect/Exit"
import type { FuzzyConfig } from "./internal/config.js"
import { cacheVariance, consumerCacheVariance } from "./internal/config.js"
import * as Impl from "./internal/fuzzycache.js"

/**
 * @since 1.0.0
 * @category symbols
 */
export const FuzzyCacheTypeId: unique symbol = Symbol.for("@effect/FuzzyCache")

/**
 * @since 1.0.0
 * @category symbols
 */
export type FuzzyCacheTypeId = typeof FuzzyCacheTypeId

/**
 * A scored result containing the cached value, its relevance score, and original parameters
 *
 * @since 1.0.0
 * @category models
 */
export interface ScoredResult<Value> {
  readonly value: Value
  readonly score: number
  readonly params: Record<string, unknown>
}

/**
 * FuzzyCache extends Effect's Cache interface with fuzzy parameter matching.
 *
 * Unlike standard caches that require exact key matches, FuzzyCache returns scored
 * results based on parameter similarity. The cache organizes entries into buckets
 * based on exact-match parameters, then scores entries within each bucket using
 * fuzzy-match parameters.
 *
 * Key differences from standard Cache:
 * - `get()` returns the best-matching cached value (highest score)
 * - `getAll()` returns all matches above a threshold, sorted by score
 * - `getOption()` returns the best match as Option.Option
 * - All other Cache methods work as expected
 *
 * @since 1.0.0
 * @category models
 */
export interface FuzzyCache<Params extends Record<string, unknown>, Value, Error = never>
  extends Cache.Cache<Params, Value, Error> {
  readonly [FuzzyCacheTypeId]: FuzzyCacheTypeId

  /**
   * Retrieves the best-matching cached value for the given parameters.
   * If no cached values exist, computes a new value using the lookup function.
   *
   * Returns the value with the highest fuzzy match score.
   */
  get(params: Params): Effect.Effect<Value, Error>

  /**
   * Retrieves the best-matching cached value as Either.
   * - Left: value was already cached
   * - Right: value was newly computed
   */
  getEither(params: Params): Effect.Effect<Either.Either<Value, Value>, Error>

  /**
   * Retrieves the best-matching cached value if it exists, otherwise returns Option.none.
   * Does not trigger the lookup function.
   */
  getOption(params: Params): Effect.Effect<Option.Option<Value>, Error>

  /**
   * Retrieves the best-matching cached value if it exists and lookup is complete.
   * Returns Option.none if still computing.
   */
  getOptionComplete(params: Params): Effect.Effect<Option.Option<Value>>

  /**
   * Retrieves all cached values matching the given parameters above the specified threshold,
   * sorted by score (highest first).
   *
   * @param params - Query parameters to match against
   * @param threshold - Minimum score threshold (0.0 to 1.0). Defaults to 0.0 (return all)
   */
  getAll(params: Params, threshold?: number): Effect.Effect<Array<ScoredResult<Value>>, Error>

  /**
   * Forces recomputation of the value for the given parameters.
   * Unlike `get`, this always triggers the lookup function but doesn't invalidate
   * existing cache entries, so requests can still be served while recomputing.
   */
  refresh(params: Params): Effect.Effect<void, Error>

  /**
   * Associates the specified value with the given parameters in the cache.
   */
  set(params: Params, value: Value): Effect.Effect<void>

  /**
   * Returns cache statistics for exact bucket lookups.
   * Tracks hits/misses at the bucket level (when buckets are found/created).
   */
  readonly exactStats: Effect.Effect<Cache.CacheStats>

  /**
   * Returns cache statistics for fuzzy entry matching.
   * Tracks hits/misses at the entry level (when fuzzy matches succeed/fail).
   */
  readonly fuzzyStats: Effect.Effect<Cache.CacheStats>

  /**
   * Returns combined cache statistics (for backwards compatibility).
   * Same as fuzzyStats.
   */
  readonly cacheStats: Effect.Effect<Cache.CacheStats>

  /**
   * Returns whether any value matching the given parameters exists in the cache.
   */
  contains(params: Params): Effect.Effect<boolean>

  /**
   * Returns statistics for the best-matching entry.
   */
  entryStats(params: Params): Effect.Effect<Option.Option<Cache.EntryStats>>

  /**
   * Invalidates the best-matching cached value for the given parameters.
   */
  invalidate(params: Params): Effect.Effect<void>

  /**
   * Invalidates the best-matching cached value for the given parameters if the predicate holds.
   */
  invalidateWhen(params: Params, predicate: Predicate.Predicate<Value>): Effect.Effect<void>

  /**
   * Invalidates all cached values.
   */
  readonly invalidateAll: Effect.Effect<void>

  /**
   * Returns the approximate number of cache entries across all buckets.
   */
  readonly size: Effect.Effect<number>

  /**
   * Returns all parameter sets currently in the cache.
   */
  readonly keys: Effect.Effect<Array<Params>>

  /**
   * Returns all values currently in the cache.
   */
  readonly values: Effect.Effect<Array<Value>>

  /**
   * Returns all entries (params-value pairs) currently in the cache.
   */
  readonly entries: Effect.Effect<Array<[Params, Value]>>
}

/**
 * A `Lookup` function that, given parameters, returns an Effect that will either
 * produce a value or fail with an error.
 *
 * @since 1.0.0
 * @category models
 */
export type Lookup<Params extends Record<string, unknown>, Value, Error = never, R = never> = (
  params: Params
) => Effect.Effect<Value, Error, R>

/**
 * Constructs a new FuzzyCache with the specified capacity, time to live, fuzzy config,
 * and lookup function.
 *
 * The FuzzyCache organizes entries into buckets based on exact-match parameters,
 * then scores entries within each bucket using fuzzy-match parameters. This allows
 * efficient retrieval of cached values that approximately match the query parameters.
 *
 * @since 1.0.0
 * @category constructors
 * @example
 * ```typescript
 * import * as FuzzyCache from "./FuzzyCache"
 * import * as Matchers from "./Matchers"
 * import { Effect, Duration } from "effect"
 *
 * interface SearchParams {
 *   readonly userId: string
 *   readonly query: string
 *   readonly maxResults: number
 * }
 *
 * const cache = FuzzyCache.make({
 *   lookup: (params: SearchParams) =>
 *     Effect.succeed(`Result for ${params.query}`),
 *   config: {
 *     userId: Matchers.Exact(),
 *     query: Matchers.levenshtein(0.3),
 *     maxResults: Matchers.numeric(5)
 *   },
 *   capacity: 100,
 *   timeToLive: Duration.minutes(5)
 * })
 *
 * // Usage
 * const program = Effect.gen(function* () {
 *   const fuzzyCache = yield* cache
 *
 *   // First call will invoke lookup
 *   const value = yield* fuzzyCache.get({
 *     userId: "user123",
 *     query: "hello",
 *     maxResults: 10
 *   })
 *
 *   // Similar query will return cached result (best match)
 *   const cachedValue = yield* fuzzyCache.get({
 *     userId: "user123",
 *     query: "hello world",  // Similar to "hello"
 *     maxResults: 12  // Within numeric tolerance of 10
 *   })
 *
 *   // Get all matches above threshold
 *   const allMatches = yield* fuzzyCache.getAll(
 *     { userId: "user123", query: "hello", maxResults: 10 },
 *     0.7  // Minimum score threshold
 *   )
 * })
 * ```
 */
export const make = <Params extends Record<string, unknown>, Value, Error = never, R = never>(
  options: {
    readonly lookup: Lookup<Params, Value, Error, R>
    readonly config: FuzzyConfig<Params>
    readonly capacity: { readonly bucket: number; readonly list: number }
    readonly timeToLive: Duration.DurationInput
    readonly minScore?: number
  }
): Effect.Effect<FuzzyCache<Params, Value, Error>, never, R> =>
  makeWith({
    lookup: options.lookup,
    config: options.config,
    capacity: options.capacity,
    timeToLive: () => options.timeToLive,
    minScore: options.minScore ?? 0
  })

/**
 * Constructs a new FuzzyCache where the time to live can depend on the `Exit` value
 * returned by the lookup function.
 *
 * This allows different TTLs for successful vs failed lookups, or dynamic TTLs based
 * on the computed value.
 *
 * @since 1.0.0
 * @category constructors
 * @example
 * ```typescript
 * import * as FuzzyCache from "./FuzzyCache"
 * import * as Matchers from "./Matchers"
 * import { Effect, Duration, Exit } from "effect"
 *
 * const cache = FuzzyCache.makeWith({
 *   lookup: (params: { key: string }) =>
 *     Effect.succeed(`value-${params.key}`),
 *   config: {
 *     key: Matchers.Exact()
 *   },
 *   capacity: 100,
 *   timeToLive: (exit) =>
 *     Exit.isSuccess(exit)
 *       ? Duration.minutes(10)  // Cache successes for 10 minutes
 *       : Duration.seconds(30)  // Cache failures for 30 seconds
 * })
 * ```
 */
export const makeWith = <Params extends Record<string, unknown>, Value, Error = never, R = never>(
  options: {
    readonly lookup: Lookup<Params, Value, Error, R>
    readonly config: FuzzyConfig<Params>
    readonly capacity: { readonly bucket: number; readonly list: number }
    readonly timeToLive: (exit: Exit.Exit<Value, Error>) => Duration.DurationInput
    readonly minScore?: number
  }
): Effect.Effect<FuzzyCache<Params, Value, Error>, never, R> =>
  Effect.map(
    Impl.makeImpl({
      lookup: options.lookup,
      config: options.config,
      capacity: options.capacity,
      timeToLive: options.timeToLive,
      minScore: options.minScore ?? 0
    }),
    (impl) => ({
      [FuzzyCacheTypeId]: FuzzyCacheTypeId,
      [Cache.CacheTypeId]: cacheVariance,
      [Cache.ConsumerCacheTypeId]: consumerCacheVariance,
      get: impl.get,
      getEither: impl.getEither,
      getOption: impl.getOption,
      getOptionComplete: impl.getOptionComplete,
      getAll: impl.getAll,
      refresh: impl.refresh,
      set: impl.set,
      exactStats: impl.exactStats,
      fuzzyStats: impl.fuzzyStats,
      cacheStats: impl.cacheStats,
      contains: impl.contains,
      entryStats: impl.entryStats,
      invalidate: impl.invalidate,
      invalidateWhen: impl.invalidateWhen,
      invalidateAll: impl.invalidateAll,
      size: impl.size,
      keys: impl.keys,
      values: impl.values,
      entries: impl.entries
    })
  )
