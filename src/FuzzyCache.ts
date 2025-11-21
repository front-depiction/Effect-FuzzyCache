/**
 * FuzzyCache - A bucket-based fuzzy cache that extends Effect's Cache
 *
 * @since 1.0.0
 */
import * as Cache from "effect/Cache"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Duration from "effect/Duration"
import * as Option from "effect/Option"
import * as Either from "effect/Either"
import * as Equal from "effect/Equal"
import * as Predicate from "effect/Predicate"
import * as Array from "effect/Array"
import * as Exit from "effect/Exit"
import {
  type BucketKey,
  type CacheEntry,
  type FuzzyConfig,
  partitionParams,
  createBucketKey,
  scoreEntry,
  generateId,
  hasExpired,
  consumerCacheVariance,
  cacheVariance
} from "./internal.js"

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
   * Returns cache statistics (hits, misses, size)
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
    readonly capacity: number
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
    readonly capacity: number
    readonly timeToLive: (exit: Exit.Exit<Value, Error>) => Duration.DurationInput
    readonly minScore?: number
  }
): Effect.Effect<FuzzyCache<Params, Value, Error>, never, R> =>
  Effect.gen(function* () {
    // Capture the current context to provide R when calling lookup
    const context = yield* Effect.context<R>()

    // Track our own stats for entry-level hits/misses
    let hits = 0
    let misses = 0

    // Create underlying Cache for bucket storage
    // Each bucket key maps to a Set of cache entries
    const bucketCache = yield* Cache.make<BucketKey, Set<CacheEntry<Value>>>({
      capacity: options.capacity,
      timeToLive: Duration.infinity,  // We manage TTL per entry
      lookup: () => Effect.succeed(new Set<CacheEntry<Value>>())
    })


    // Helper: Compute TTL in milliseconds from Exit
    const computeTTL = (exit: Exit.Exit<Value, Error>): number =>
      Duration.toMillis(options.timeToLive(exit))

    // Helper: Find best matching entry in bucket
    const findBestMatch = (
      bucket: Set<CacheEntry<Value>>,
      params: Params,
      now: number
    ): Option.Option<ScoredResult<Value>> => {
      if (bucket.size === 0) return Option.none()

      const minScoreThreshold = options.minScore ?? 0.0

      const scored = Array.fromIterable(bucket)
        // Filter out expired entries
        .filter((entry) => !hasExpired(entry, now))
        // Score remaining entries
        .map((entry) => ({
          value: entry.value,
          score: scoreEntry(entry, params, options.config),
          params: entry.params
        }))
        // Filter by minimum score threshold
        .filter((result) => result.score >= minScoreThreshold)
        .sort((a, b) => b.score - a.score)

      return Option.fromIterable(scored)
    }

    return {
      [FuzzyCacheTypeId]: FuzzyCacheTypeId,
      [Cache.CacheTypeId]: cacheVariance,
      [Cache.ConsumerCacheTypeId]: consumerCacheVariance,

      get: (params: Params): Effect.Effect<Value, Error> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)
          const now = yield* Clock.currentTimeMillis

          // Try to find existing match
          const existing = findBestMatch(bucket, params, now)
          if (Option.isSome(existing)) {
            hits++
            return existing.value.value
          }

          // No match found, call lookup
          misses++
          const value: Value = yield* Effect.provide(options.lookup(params), context)
          const entry: CacheEntry<Value> = {
            id: generateId(),
            params,
            value,
            timeToLiveMillis: now + computeTTL(Exit.succeed(value)),
            loadedMillis: now
          }
          bucket.add(entry)
          return value
        }),

      getEither: (params: Params): Effect.Effect<Either.Either<Value, Value>, Error> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)
          const now = yield* Clock.currentTimeMillis

          // Try to find existing match
          const existing = findBestMatch(bucket, params, now)
          if (Option.isSome(existing)) {
            return Either.left(existing.value.value)
          }

          // No match found, call lookup
          const value: Value = yield* Effect.provide(options.lookup(params), context)
          const entry: CacheEntry<Value> = {
            id: generateId(),
            params,
            value,
            timeToLiveMillis: now + computeTTL(Exit.succeed(value)),
            loadedMillis: now
          }
          bucket.add(entry)
          return Either.right(value)
        }),

      getOption: (params: Params) =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucketOption = yield* bucketCache.getOption(bucketKey)

          if (Option.isNone(bucketOption)) {
            return Option.none()
          }

          const now = yield* Clock.currentTimeMillis
          return Option.map(findBestMatch(bucketOption.value, params, now), (scored) => scored.value)
        }),

      getOptionComplete: (params: Params) =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucketOption = yield* bucketCache.getOptionComplete(bucketKey)

          if (Option.isNone(bucketOption)) {
            return Option.none()
          }

          const now = yield* Clock.currentTimeMillis
          return Option.map(findBestMatch(bucketOption.value, params, now), (scored) => scored.value)
        }),

      getAll: (params: Params, threshold = 0.0): Effect.Effect<Array<ScoredResult<Value>>, Error> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)
          const now = yield* Clock.currentTimeMillis

          // Filter out expired entries first
          const validEntries = Array.fromIterable(bucket)
            .filter((entry) => !hasExpired(entry, now))

          // If no valid entries, call lookup and store result
          if (validEntries.length === 0) {
            const value: Value = yield* Effect.provide(options.lookup(params), context)
            const entry: CacheEntry<Value> = {
              id: generateId(),
              params,
              value,
              timeToLiveMillis: now + computeTTL(Exit.succeed(value)),
              loadedMillis: now
            }
            bucket.add(entry)
            return [{ value, score: 1.0, params }]
          }

          // Score and filter by the higher of per-call threshold or global minScore
          const effectiveThreshold = Math.max(threshold, options.minScore ?? 0.0)
          const scored = validEntries
            .map((entry) => ({
              value: entry.value,
              score: scoreEntry(entry, params, options.config),
              params: entry.params
            }))
            .filter((result) => result.score >= effectiveThreshold)
            .sort((a, b) => b.score - a.score)

          return scored
        }),

      refresh: (params: Params): Effect.Effect<void, Error> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)
          const now = yield* Clock.currentTimeMillis

          // Always call lookup
          const value: Value = yield* Effect.provide(options.lookup(params), context)
          const entry: CacheEntry<Value> = {
            id: generateId(),
            params,
            value,
            timeToLiveMillis: now + computeTTL(Exit.succeed(value)),
            loadedMillis: now
          }
          bucket.add(entry)
        }),

      set: (params: Params, value: Value) =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)
          const now = yield* Clock.currentTimeMillis

          // Check if an entry with identical params already exists
          const existingEntry = Array.findFirst(
            Array.fromIterable(bucket),
            (entry) => {
              // Use Effect's Equal.equals for deep equality comparison
              return Object.keys(params).length === Object.keys(entry.params).length &&
                Object.keys(params).every((key) =>
                  Equal.equals(params[key], entry.params[key])
                )
            }
          )

          if (Option.isSome(existingEntry)) {
            // Update existing entry's value and timestamp
            bucket.delete(existingEntry.value)
            const updatedEntry: CacheEntry<Value> = {
              id: existingEntry.value.id,
              params,
              value,
              timeToLiveMillis: now + computeTTL(Exit.succeed(value)),
              loadedMillis: now
            }
            bucket.add(updatedEntry)
          } else {
            // Add new entry
            const entry: CacheEntry<Value> = {
              id: generateId(),
              params,
              value,
              timeToLiveMillis: now + computeTTL(Exit.succeed(value)),
              loadedMillis: now
            }
            bucket.add(entry)
          }
        }),

      cacheStats: Effect.gen(function* () {
        const bucketSize = yield* Effect.gen(function* () {
          const buckets = yield* bucketCache.values
          return buckets.reduce((sum, bucket) => sum + bucket.size, 0)
        })
        return Cache.makeCacheStats({ hits, misses, size: bucketSize })
      }),

      contains: (params: Params) =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucketOption = yield* bucketCache.getOptionComplete(bucketKey)

          if (Option.isNone(bucketOption)) {
            return false
          }

          return bucketOption.value.size > 0
        }),

      entryStats: (params: Params) =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucketOption = yield* bucketCache.getOptionComplete(bucketKey)

          if (Option.isNone(bucketOption)) {
            return Option.none()
          }

          const now = yield* Clock.currentTimeMillis
          const bestMatch = findBestMatch(bucketOption.value, params, now)
          if (Option.isNone(bestMatch)) {
            return Option.none()
          }

          // Find the actual entry to get timestamp
          const entry = Array.findFirst(
            Array.fromIterable(bucketOption.value),
            (e) => e.value === bestMatch.value.value
          )

          if (Option.isNone(entry)) {
            return Option.none()
          }

          return Option.some(Cache.makeEntryStats(entry.value.loadedMillis))
        }),

      invalidate: (params: Params) =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucketOption = yield* bucketCache.getOptionComplete(bucketKey)

          if (Option.isNone(bucketOption)) {
            return
          }

          const bucket = bucketOption.value
          const now = yield* Clock.currentTimeMillis
          const bestMatch = findBestMatch(bucket, params, now)

          if (Option.isSome(bestMatch)) {
            // Remove the best matching entry
            const entryToRemove = Array.findFirst(
              Array.fromIterable(bucket),
              (entry) => entry.value === bestMatch.value.value
            )

            if (Option.isSome(entryToRemove)) {
              bucket.delete(entryToRemove.value)
            }
          }
        }),

      invalidateWhen: (params: Params, predicate: Predicate.Predicate<Value>) =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucketOption = yield* bucketCache.getOptionComplete(bucketKey)

          if (Option.isNone(bucketOption)) {
            return
          }

          const bucket = bucketOption.value
          const now = yield* Clock.currentTimeMillis
          const bestMatch = findBestMatch(bucket, params, now)

          if (Option.isSome(bestMatch) && predicate(bestMatch.value.value)) {
            // Remove the best matching entry if predicate holds
            const entryToRemove = Array.findFirst(
              Array.fromIterable(bucket),
              (entry) => entry.value === bestMatch.value.value
            )

            if (Option.isSome(entryToRemove)) {
              bucket.delete(entryToRemove.value)
            }
          }
        }),

      invalidateAll: bucketCache.invalidateAll,

      size: Effect.gen(function* () {
        const buckets = yield* bucketCache.values
        return buckets.reduce((sum, bucket) => sum + bucket.size, 0)
      }),

      keys: Effect.gen(function* () {
        const buckets = yield* bucketCache.entries
        return Array.flatMap(buckets, ([_, bucket]) =>
          Array.map(Array.fromIterable(bucket), (entry) => entry.params as Params)
        )
      }),

      values: Effect.gen(function* () {
        const buckets = yield* bucketCache.values
        return Array.flatMap(buckets, (bucket) =>
          Array.map(Array.fromIterable(bucket), (entry) => entry.value)
        )
      }),

      entries: Effect.gen(function* () {
        const buckets = yield* bucketCache.values
        return Array.flatMap(buckets, (bucket) =>
          Array.map(Array.fromIterable(bucket), (entry) => [entry.params as Params, entry.value] as [Params, Value])
        )
      })
    }
  })

