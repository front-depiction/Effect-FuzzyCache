/**
 * FuzzyCache - A bucket-based fuzzy cache that extends Effect's Cache
 *
 * @since 1.0.0
 */
import * as Cache from "effect/Cache"
import * as Effect from "effect/Effect"
import * as Duration from "effect/Duration"
import {
  type BucketKey,
  type CacheEntry,
  type FuzzyConfig,
  partitionParams,
  createBucketKey,
  scoreEntry,
  generateId
} from "./internal.js"

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
 * FuzzyCache interface providing fuzzy parameter matching with scored results
 *
 * @since 1.0.0
 * @category models
 */
export interface FuzzyCache<Params extends Record<string, unknown>, Value, Error> {
  /**
   * Get cached values matching the given parameters, sorted by relevance score
   */
  readonly get: (params: Params) => Effect.Effect<Array<ScoredResult<Value>>, Error>

  /**
   * Set a value in the cache for the given parameters
   */
  readonly set: (params: Params, value: Value) => Effect.Effect<void>

  /**
   * Invalidate all cached values
   */
  readonly invalidateAll: Effect.Effect<void>

  /**
   * Get the approximate number of cache entries
   */
  readonly size: Effect.Effect<number>
}

/**
 * Creates a new FuzzyCache with the specified configuration
 *
 * The FuzzyCache organizes entries into buckets based on exact-match parameters,
 * then scores entries within each bucket using fuzzy-match parameters. This allows
 * efficient retrieval of cached values that approximately match the query parameters.
 *
 * @since 1.0.0
 * @category constructors
 * @example
 * ```typescript
 * import { FuzzyCache } from "./FuzzyCache"
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
 *     Effect.succeed([`Result for ${params.query}`]),
 *   config: {
 *     userId: { _tag: "Exact" },
 *     query: {
 *       _tag: "Fuzzy",
 *       scorer: (cached, query) => {
 *         // Simple string similarity
 *         if (cached === query) return 1.0
 *         if (typeof cached === "string" && typeof query === "string") {
 *           return cached.toLowerCase().includes(query.toLowerCase()) ? 0.7 : 0.3
 *         }
 *         return 0
 *       }
 *     },
 *     maxResults: {
 *       _tag: "Fuzzy",
 *       scorer: (cached, query) => {
 *         if (typeof cached === "number" && typeof query === "number") {
 *           return 1 - Math.abs(cached - query) / Math.max(cached, query)
 *         }
 *         return 0
 *       }
 *     }
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
 *   const results = yield* fuzzyCache.get({
 *     userId: "user123",
 *     query: "hello",
 *     maxResults: 10
 *   })
 *
 *   // Similar query will return scored cached results
 *   const fuzzyResults = yield* fuzzyCache.get({
 *     userId: "user123",
 *     query: "hello world",
 *     maxResults: 12
 *   })
 *
 *   console.log(fuzzyResults[0].score) // e.g., 0.85
 * })
 * ```
 */
export const make = <Params extends Record<string, unknown>, Value, Error, R>(
  options: {
    readonly lookup: (params: Params) => Effect.Effect<Value, Error, R>
    readonly config: FuzzyConfig<Params>
    readonly capacity: number
    readonly timeToLive: Duration.DurationInput
  }
): Effect.Effect<FuzzyCache<Params, Value, Error>, never, R> =>
  Effect.gen(function* () {
    // Create underlying Cache for bucket storage
    // Each bucket key maps to a Set of cache entries
    const bucketCache = yield* Cache.make<BucketKey, Set<CacheEntry<Value>>>({
      capacity: options.capacity,
      timeToLive: options.timeToLive,
      lookup: () => Effect.succeed(new Set<CacheEntry<Value>>())
    })

    return {
      get: (params: Params) =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)

          // Get bucket from Effect's Cache
          const bucket = yield* bucketCache.get(bucketKey)

          // If bucket is empty, call lookup and store result
          if (bucket.size === 0) {
            const value = yield* options.lookup(params)
            const entry: CacheEntry<Value> = {
              id: generateId(),
              params,
              value,
              timestamp: Date.now()
            }
            bucket.add(entry)
            return [{ value, score: 1.0, params }]
          }

          // Score each entry in the bucket
          const scored = Array.from(bucket).map((entry) => ({
            value: entry.value,
            score: scoreEntry(entry, params, options.config),
            params: entry.params
          }))

          // Sort by score descending (highest score first)
          return scored.sort((a, b) => b.score - a.score)
        }) as Effect.Effect<Array<ScoredResult<Value>>, Error, never>,

      set: (params: Params, value: Value) =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)

          const entry: CacheEntry<Value> = {
            id: generateId(),
            params,
            value,
            timestamp: Date.now()
          }
          bucket.add(entry)
        }),

      invalidateAll: bucketCache.invalidateAll,

      size: Effect.gen(function* () {
        // Get all buckets and sum their sizes
        const buckets = yield* bucketCache.values
        return buckets.reduce((sum, bucket) => sum + bucket.size, 0)
      })
    }
  })
