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
import * as Order from "effect/Order"
import * as Deferred from "effect/Deferred"
import * as Hash from "effect/Hash"
import * as MutableHashMap from "effect/MutableHashMap"
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
  cacheVariance,
  hasNotExpired
} from "./internal/fuzzycache.js"
import { pipe } from "effect"

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
  Effect.gen(function* () {
    // Capture the current context to provide R when calling lookup
    const context = yield* Effect.context<R>()

    // Helper: Create stats tracker using Effect's pattern
    const createStatsTracker = () => {
      let hits = 0
      let misses = 0

      return {
        trackHit: () => { hits++ },
        trackMiss: () => { misses++ },
        get: () => ({ hits, misses })
      }
    }

    // Track our own stats for entry-level hits/misses
    // Note: We can't use bucketCache.cacheStats directly because it tracks bucket-level
    // access (when buckets are created/accessed), not entry-level access (when actual
    // fuzzy entries are hit/missed). We need entry-level granularity for correct stats.
    const fuzzyStatsTracker = createStatsTracker()

    // Create underlying Cache for bucket storage
    // Each bucket key maps to an Array of cache entries
    const bucketCache = yield* Cache.make<BucketKey, Array<CacheEntry<Value>>>({
      capacity: options.capacity.bucket,
      timeToLive: Duration.infinity,  // We manage TTL per entry
      lookup: () => Effect.succeed([])
    })

    // Track in-flight lookups to deduplicate concurrent requests for same params
    // Maps params hash → Deferred for the in-progress lookup
    const pendingLookups = MutableHashMap.empty<number, Deferred.Deferred<Value, Error>>()

    // Helper: Create consistent hash key for params
    const hashParams = (params: Params): number => Hash.structure(params)

    // Helper: Compute TTL in milliseconds from Exit
    const computeTTL = (exit: Exit.Exit<Value, Error>): number =>
      Duration.toMillis(options.timeToLive(exit))

    // Helper: Add entry with capacity enforcement via eviction
    const addEntryWithEviction = (bucket: Array<CacheEntry<Value>>, entry: CacheEntry<Value>): void => {
      if (bucket.length >= options.capacity.list) {
        // Find entry with earliest expiration time using Array.min
        // Note: Array.min returns the element directly for non-empty arrays
        const toEvict = Array.min(
          bucket as Array.NonEmptyArray<CacheEntry<Value>>,
          Order.mapInput(Order.number, (e: CacheEntry<Value>) => e.timeToLiveMillis)
        )
        const index = bucket.indexOf(toEvict)
        if (index !== -1) {
          bucket.splice(index, 1)
        }
      }
      bucket.push(entry)
    }

    // Helper: Find best matching entry in bucket
    const findBestMatch = (
      bucket: Array<CacheEntry<Value>>,
      params: Params,
      now: number
    ): Option.Option<ScoredResult<Value>> => {
      const minScoreThreshold = options.minScore ?? 0.0

      const scored = pipe(
        bucket,
        Array.filterMap((entry) =>
          pipe(
            entry,
            Option.liftPredicate(hasNotExpired(now)),
            Option.map((entry) => ({
              value: entry.value,
              score: scoreEntry(entry, params, options.config),
              params: entry.params
            }))
          )
        ),
        Array.filter((result) => result.score >= minScoreThreshold),
        Array.sortWith((entry) => entry.score, Order.number)
      );

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
            fuzzyStatsTracker.trackHit()
            return existing.value.value
          }

          // Check if lookup already in-flight for these params
          const paramsHash = hashParams(params)
          const pendingDeferred = MutableHashMap.get(pendingLookups, paramsHash)

          if (Option.isSome(pendingDeferred)) {
            // Another fiber is already looking up these params, wait for it
            fuzzyStatsTracker.trackHit()
            return yield* Deferred.await(pendingDeferred.value)
          }

          // No match found and no in-flight lookup, start new lookup
          fuzzyStatsTracker.trackMiss()

          // Create Deferred for this lookup
          const deferred = yield* Deferred.make<Value, Error>()
          MutableHashMap.set(pendingLookups, paramsHash, deferred)

          // Perform lookup with proper cleanup
          const result = yield* Effect.provide(options.lookup(params), context).pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Effect.gen(function* () {
                // Remove from pending map
                MutableHashMap.remove(pendingLookups, paramsHash)

                // Complete the deferred so other waiting fibers get the result
                yield* Deferred.complete(deferred, exit)

                if (Exit.isSuccess(exit)) {
                  // Store in bucket
                  const entry: CacheEntry<Value> = {
                    id: generateId(),
                    params,
                    value: exit.value,
                    timeToLiveMillis: now + computeTTL(exit),
                    loadedMillis: now
                  }
                  addEntryWithEviction(bucket, entry)
                  return exit.value
                } else {
                  // Re-throw the error
                  return yield* Effect.fail(exit.cause)
                }
              })
            )
          )

          return result
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

          // Check if lookup already in-flight for these params
          const paramsHash = hashParams(params)
          const pendingDeferred = MutableHashMap.get(pendingLookups, paramsHash)

          if (Option.isSome(pendingDeferred)) {
            // Another fiber is already looking up these params, wait for it
            const value = yield* Deferred.await(pendingDeferred.value)
            return Either.left(value) // From cache (pending)
          }

          // No match found and no in-flight lookup, start new lookup
          // Create Deferred for this lookup
          const deferred = yield* Deferred.make<Value, Error>()
          MutableHashMap.set(pendingLookups, paramsHash, deferred)

          // Perform lookup with proper cleanup
          const value = yield* Effect.provide(options.lookup(params), context).pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Effect.gen(function* () {
                // Remove from pending map
                MutableHashMap.remove(pendingLookups, paramsHash)

                // Complete the deferred so other waiting fibers get the result
                yield* Deferred.complete(deferred, exit)

                if (Exit.isSuccess(exit)) {
                  // Store in bucket
                  const entry: CacheEntry<Value> = {
                    id: generateId(),
                    params,
                    value: exit.value,
                    timeToLiveMillis: now + computeTTL(exit),
                    loadedMillis: now
                  }
                  addEntryWithEviction(bucket, entry)
                  return exit.value
                } else {
                  // Re-throw the error
                  return yield* Effect.fail(exit.cause)
                }
              })
            )
          )

          return Either.right(value) // Newly computed
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
          const bestMatch = findBestMatch(bucketOption.value, params, now)

          if (Option.isSome(bestMatch)) {
            return Option.some(bestMatch.value.value)
          }

          // No completed match found, check if lookup is in-flight
          const paramsHash = hashParams(params)
          const pendingDeferred = MutableHashMap.get(pendingLookups, paramsHash)

          if (Option.isSome(pendingDeferred)) {
            // Wait for in-flight lookup
            const value = yield* Deferred.await(pendingDeferred.value)
            return Option.some(value)
          }

          return Option.none()
        }),

      getOptionComplete: (params: Params) =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucketOption = yield* bucketCache.getOptionComplete(bucketKey)

          if (Option.isNone(bucketOption)) {
            return Option.none()
          }

          // Check if lookup is in-flight - if so, return None (not complete)
          const paramsHash = hashParams(params)
          const pendingDeferred = MutableHashMap.get(pendingLookups, paramsHash)

          if (Option.isSome(pendingDeferred)) {
            return Option.none() // Still pending, not complete
          }

          const now = yield* Clock.currentTimeMillis
          const bestMatch = findBestMatch(bucketOption.value, params, now)
          return Option.map(bestMatch, (scored) => scored.value)
        }),

      getAll: (params: Params, threshold = 0.0): Effect.Effect<Array<ScoredResult<Value>>, Error> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)
          const now = yield* Clock.currentTimeMillis

          // Remove expired entries from bucket (in-place cleanup, reverse order to maintain indices)
          for (let i = bucket.length - 1; i >= 0; i--) {
            if (hasExpired(now)(bucket[i]!)) {
              bucket.splice(i, 1)
            }
          }

          // If no valid entries, call lookup and store result
          if (bucket.length === 0) {
            const value: Value = yield* Effect.provide(options.lookup(params), context)
            const entry: CacheEntry<Value> = {
              id: generateId(),
              params,
              value,
              timeToLiveMillis: now + computeTTL(Exit.succeed(value)),
              loadedMillis: now
            }
            addEntryWithEviction(bucket, entry)
            return [{ value, score: 1.0, params }]
          }

          // Score and filter by the higher of per-call threshold or global minScore
          const effectiveThreshold = Math.max(threshold, options.minScore ?? 0.0)
          const scored = bucket
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
          addEntryWithEviction(bucket, entry)
        }),

      set: (params: Params, value: Value) =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)
          const now = yield* Clock.currentTimeMillis

          // Check if an entry with identical params already exists
          const existingIndex = bucket.findIndex((entry) => {
            // Use Effect's Equal.equals for deep equality comparison
            return (
              Object.keys(params).length === Object.keys(entry.params).length &&
              Object.keys(params).every((key) => Equal.equals(params[key], entry.params[key]))
            )
          })

          if (existingIndex !== -1) {
            // Update existing entry's value and timestamp
            const existingEntry = bucket[existingIndex]!
            bucket[existingIndex] = {
              id: existingEntry.id,
              params,
              value,
              timeToLiveMillis: now + computeTTL(Exit.succeed(value)),
              loadedMillis: now
            }
          } else {
            // Add new entry with capacity enforcement
            const entry: CacheEntry<Value> = {
              id: generateId(),
              params,
              value,
              timeToLiveMillis: now + computeTTL(Exit.succeed(value)),
              loadedMillis: now
            }
            addEntryWithEviction(bucket, entry)
          }
        }),

      exactStats: Effect.map(bucketCache.cacheStats, (stats) => stats),

      fuzzyStats: Effect.gen(function* () {
        const buckets = yield* bucketCache.values
        const totalSize = buckets.reduce((sum, bucket) => sum + bucket.length, 0)
        const { hits, misses } = fuzzyStatsTracker.get()
        return Cache.makeCacheStats({ hits, misses, size: totalSize })
      }),

      cacheStats: Effect.gen(function* () {
        // For backwards compatibility, return fuzzy stats
        const buckets = yield* bucketCache.values
        const totalSize = buckets.reduce((sum, bucket) => sum + bucket.length, 0)
        const { hits, misses } = fuzzyStatsTracker.get()
        return Cache.makeCacheStats({ hits, misses, size: totalSize })
      }),

      contains: (params: Params) =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucketOption = yield* bucketCache.getOptionComplete(bucketKey)

          if (Option.isNone(bucketOption)) {
            return false
          }

          return bucketOption.value.length > 0
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
          const entry = Array.findFirst(bucketOption.value, (e) => e.value === bestMatch.value.value)

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
            // Find and remove the best matching entry
            const index = bucket.findIndex((entry) => entry.value === bestMatch.value.value)
            if (index !== -1) {
              bucket.splice(index, 1)
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
            // Find and remove the best matching entry
            const index = bucket.findIndex((entry) => entry.value === bestMatch.value.value)
            if (index !== -1) {
              bucket.splice(index, 1)
            }
          }
        }),

      invalidateAll: bucketCache.invalidateAll,

      size: Effect.gen(function* () {
        const buckets = yield* bucketCache.values
        return buckets.reduce((sum, bucket) => sum + bucket.length, 0)
      }),

      keys: Effect.gen(function* () {
        const buckets = yield* bucketCache.values
        return Array.flatMap(buckets, (bucket) =>
          Array.map(bucket, (entry) => entry.params as Params)
        )
      }),

      values: Effect.gen(function* () {
        const buckets = yield* bucketCache.values
        return Array.flatMap(buckets, (bucket) =>
          Array.map(bucket, (entry) => entry.value)
        )
      }),

      entries: Effect.gen(function* () {
        const buckets = yield* bucketCache.values
        return Array.flatMap(buckets, (bucket) =>
          Array.map(bucket, (entry) => [entry.params as Params, entry.value] as [Params, Value])
        )
      })
    }
  })

