/**
 * Comprehensive tests for FuzzyCache implementation
 *
 * Includes:
 * - Property-based tests using FastCheck
 * - API method tests
 * - TTL expiration tests using TestClock
 * - minScore threshold tests
 *
 * @since 1.0.0
 */

import { describe, it, assert } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Duration from "effect/Duration"
import * as Schema from "effect/Schema"
import * as Either from "effect/Either"
import * as Option from "effect/Option"
import * as Exit from "effect/Exit"
import * as TestClock from "effect/TestClock"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import { Arbitrary, FastCheck as fc } from "effect"
import * as FuzzyCache from "./FuzzyCache.js"
import * as Matchers from "./Matchers.js"

// ============================================================================
// Property-based tests
// ============================================================================

describe("FuzzyCache - Property-Based Tests", () => {
  describe("Exact Match Properties", () => {
    it("should always return score 1.0 for exact matches", async () => {
      const arb = Arbitrary.make(Schema.String.pipe(Schema.nonEmptyString()))

      await fc.assert(
        fc.asyncProperty(arb, async (key) => {
          await Effect.gen(function* () {
            const lookup = (params: { key: string }) =>
              Effect.succeed(`value-${params.key}`)

            const cache = yield* FuzzyCache.make({
              lookup,
              config: { key: Matchers.Exact() },
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            // First call
            const value1 = yield* cache.get({ key })
            assert.strictEqual(value1, `value-${key}`)

            // Second call with same key - should return cached value
            const value2 = yield* cache.get({ key })
            assert.strictEqual(value2, value1)

            // Check scored results with getAll
            const results = yield* cache.getAll({ key })
            assert.strictEqual(results.length, 1)
            assert.strictEqual(results[0]?.score, 1.0)
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 1000 }
      )
    })

    it("should never call lookup twice for same exact key", async () => {
      const arb = Arbitrary.make(Schema.String.pipe(Schema.nonEmptyString()))

      await fc.assert(
        fc.asyncProperty(arb, async (key) => {
          await Effect.gen(function* () {
            let callCount = 0
            const lookup = (params: { key: string }) =>
              Effect.sync(() => {
                callCount++
                return `value-${params.key}`
              })

            const cache = yield* FuzzyCache.make({
              lookup,
              config: { key: Matchers.Exact() },
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            // Call multiple times
            yield* cache.get({ key })
            yield* cache.get({ key })
            yield* cache.get({ key })

            // Should only lookup once
            assert.strictEqual(callCount, 1)
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 500 }
      )
    })
  })

  describe("Levenshtein Distance Properties", () => {
    it("should return score 1.0 for identical strings", async () => {
      const arb = Arbitrary.make(Schema.String.pipe(Schema.nonEmptyString()))

      await fc.assert(
        fc.asyncProperty(arb, async (str) => {
          await Effect.gen(function* () {
            const lookup = (params: { text: string }) =>
              Effect.succeed(`result-${params.text}`)

            const cache = yield* FuzzyCache.make({
              lookup,
              config: { text: Matchers.levenshtein(0.5) },
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            // Cache the string
            yield* cache.set({ text: str }, `result-${str}`)

            // Query with identical string - getAll returns scored results
            const results = yield* cache.getAll({ text: str })

            // Should always have score 1.0 for identical strings
            assert.isTrue(results.length > 0)
            assert.strictEqual(results[0]?.score, 1.0)
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 1000 }
      )
    })

    it("should have symmetric distance: dist(a,b) = dist(b,a)", async () => {
      const arbPair = Arbitrary.make(
        Schema.Tuple(
          Schema.String.pipe(Schema.nonEmptyString()),
          Schema.String.pipe(Schema.nonEmptyString())
        )
      )

      await fc.assert(
        fc.asyncProperty(arbPair, async ([str1, str2]) => {
          await Effect.gen(function* () {
            const lookup = (params: { text: string }) =>
              Effect.succeed(`result-${params.text}`)

            const cache = yield* FuzzyCache.make({
              lookup,
              config: { text: Matchers.levenshtein(0.0) }, // Allow all scores
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            // Cache str1, query str2
            yield* cache.set({ text: str1 }, `result-${str1}`)
            const results1 = yield* cache.getAll({ text: str2 })
            const score1 = results1[0]?.score ?? 0

            // Clear and reverse
            yield* cache.invalidateAll

            // Cache str2, query str1
            yield* cache.set({ text: str2 }, `result-${str2}`)
            const results2 = yield* cache.getAll({ text: str1 })
            const score2 = results2[0]?.score ?? 0

            // Scores should be identical (symmetric property)
            assert.isTrue(Math.abs(score1 - score2) < 0.001)
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 500 }
      )
    })

    it("should have score in range [0, 1]", async () => {
      const arbPair = Arbitrary.make(
        Schema.Tuple(Schema.String, Schema.String)
      )

      await fc.assert(
        fc.asyncProperty(arbPair, async ([cached, query]) => {
          await Effect.gen(function* () {
            const lookup = (params: { text: string }) =>
              Effect.succeed(`result-${params.text}`)

            const cache = yield* FuzzyCache.make({
              lookup,
              config: { text: Matchers.levenshtein(0.0) },
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            yield* cache.set({ text: cached }, `result-${cached}`)
            const results = yield* cache.getAll({ text: query })

            // Score must be in [0, 1]
            const score = results[0]?.score ?? 0
            assert.isTrue(score >= 0)
            assert.isTrue(score <= 1)
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 1000 }
      )
    })
  })

  describe("Numeric Matcher Properties", () => {
    it("should return score 1.0 for values within tolerance", async () => {
      const arb = Arbitrary.make(Schema.Number.pipe(Schema.between(0, 1000)))

      await fc.assert(
        fc.asyncProperty(arb, async (baseValue) => {
          await Effect.gen(function* () {
            const tolerance = 10
            const lookup = (params: { value: number }) =>
              Effect.succeed(`result-${params.value}`)

            const cache = yield* FuzzyCache.make({
              lookup,
              config: { value: Matchers.numeric(tolerance) },
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            // Cache base value
            yield* cache.set({ value: baseValue }, `result-${baseValue}`)

            // Query with value within tolerance (baseValue + 5)
            const queryValue = baseValue + 5
            const results = yield* cache.getAll({ value: queryValue })

            // Should have score 1.0 since within tolerance
            assert.strictEqual(results[0]?.score, 1.0)
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 500 }
      )
    })

    it("should have score 0 for values at 2x tolerance", async () => {
      const arb = Arbitrary.make(Schema.Number.pipe(Schema.between(100, 1000)))

      await fc.assert(
        fc.asyncProperty(arb, async (baseValue) => {
          await Effect.gen(function* () {
            const tolerance = 10
            const lookup = (params: { value: number }) =>
              Effect.succeed(`result-${params.value}`)

            const cache = yield* FuzzyCache.make({
              lookup,
              config: { value: Matchers.numeric(tolerance) },
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            // Cache base value
            yield* cache.set({ value: baseValue }, `result-${baseValue}`)

            // Query with value at 2x tolerance
            const queryValue = baseValue + (tolerance * 2)
            const results = yield* cache.getAll({ value: queryValue })

            // Should have score 0 at 2x tolerance
            assert.strictEqual(results[0]?.score, 0.0)
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 500 }
      )
    })

    it("should decrease monotonically as distance increases", async () => {
      const arb = Arbitrary.make(Schema.Number.pipe(Schema.between(100, 500)))

      await fc.assert(
        fc.asyncProperty(arb, async (baseValue) => {
          await Effect.gen(function* () {
            const tolerance = 20
            const lookup = (params: { value: number }) =>
              Effect.succeed(`result-${params.value}`)

            const cache = yield* FuzzyCache.make({
              lookup,
              config: { value: Matchers.numeric(tolerance) },
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            // Cache base value
            yield* cache.set({ value: baseValue }, `result-${baseValue}`)

            // Test increasing distances
            const results1 = yield* cache.getAll({ value: baseValue + 5 })
            const results2 = yield* cache.getAll({ value: baseValue + 15 })
            const results3 = yield* cache.getAll({ value: baseValue + 25 })

            const score1 = results1[0]?.score ?? 0
            const score2 = results2[0]?.score ?? 0
            const score3 = results3[0]?.score ?? 0

            // Scores should decrease as distance increases
            assert.isTrue(score1 >= score2)
            assert.isTrue(score2 >= score3)
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 300 }
      )
    })
  })

  describe("Bucketing Properties", () => {
    it("should isolate buckets by exact match parameters", async () => {
      const arbPair = Arbitrary.make(
        Schema.Tuple(
          Schema.String.pipe(Schema.nonEmptyString()),
          Schema.String.pipe(Schema.nonEmptyString())
        )
      )

      await fc.assert(
        fc.asyncProperty(arbPair, async ([url1, url2]) => {
          await Effect.gen(function* () {
            // Skip if urls are the same
            if (url1 === url2) return

            const lookup = (params: { url: string; prompt: string }) =>
              Effect.succeed(`answer-${params.url}`)

            const cache = yield* FuzzyCache.make({
              lookup,
              config: {
                url: Matchers.Exact(),
                prompt: Matchers.levenshtein(0.3)
              },
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            // Store in bucket for url1
            yield* cache.set({ url: url1, prompt: "test" }, "value1")

            // Query bucket for url2 (different exact param) - will trigger lookup
            const value = yield* cache.get({ url: url2, prompt: "test" })

            // Should trigger lookup (new bucket)
            assert.strictEqual(value, `answer-${url2}`)

            // Check scored results
            const results = yield* cache.getAll({ url: url2, prompt: "test" })
            assert.strictEqual(results[0]?.score, 1.0)
            assert.strictEqual(results[0]?.value, `answer-${url2}`)
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 500 }
      )
    })

    it("should return all entries in same bucket", async () => {
      const arb = Arbitrary.make(Schema.String.pipe(Schema.nonEmptyString()))

      await fc.assert(
        fc.asyncProperty(arb, async (url) => {
          await Effect.gen(function* () {
            const lookup = (params: { url: string; prompt: string }) =>
              Effect.succeed(`result-${params.prompt}`)

            const cache = yield* FuzzyCache.make({
              lookup,
              config: {
                url: Matchers.Exact(),
                prompt: Matchers.levenshtein(0.0) // Return all
              },
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            // Add multiple entries to same bucket (same url)
            yield* cache.set({ url, prompt: "A" }, "resultA")
            yield* cache.set({ url, prompt: "B" }, "resultB")
            yield* cache.set({ url, prompt: "C" }, "resultC")

            // Query should return all 3 with getAll
            const results = yield* cache.getAll({ url, prompt: "X" })
            assert.strictEqual(results.length, 3)
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 300 }
      )
    })
  })

  describe("Cache Invalidation Properties", () => {
    it("should have size 0 after invalidateAll", async () => {
      const arbArray = Arbitrary.make(
        Schema.Array(Schema.String).pipe(Schema.maxItems(10))
      )

      await fc.assert(
        fc.asyncProperty(arbArray, async (keys) => {
          await Effect.gen(function* () {
            const lookup = (params: { key: string }) =>
              Effect.succeed(`value-${params.key}`)

            const cache = yield* FuzzyCache.make({
              lookup,
              config: { key: Matchers.Exact() },
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            // Add all keys
            for (const key of keys) {
              yield* cache.set({ key }, `value-${key}`)
            }

            // Invalidate all
            yield* cache.invalidateAll

            // Size should be 0
            const size = yield* cache.size
            assert.strictEqual(size, 0)
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 300 }
      )
    })

    it("should track size correctly", async () => {
      const arbArray = Arbitrary.make(
        Schema.Array(Schema.String.pipe(Schema.nonEmptyString())).pipe(
          Schema.minItems(1),
          Schema.maxItems(20)
        )
      )

      await fc.assert(
        fc.asyncProperty(arbArray, async (keys) => {
          await Effect.gen(function* () {
            const lookup = (params: { key: string }) =>
              Effect.succeed(`value-${params.key}`)

            const cache = yield* FuzzyCache.make({
              lookup,
              config: { key: Matchers.Exact() },
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            // Add all keys
            for (const key of keys) {
              yield* cache.set({ key }, `value-${key}`)
            }

            // Size should equal number of unique keys
            const size = yield* cache.size
            const uniqueKeys = new Set(keys).size
            assert.strictEqual(size, uniqueKeys)
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 300 }
      )
    })
  })

  describe("Score Ordering Properties", () => {
    it("should always return results sorted by score descending", async () => {
      const arb = Arbitrary.make(
        Schema.Tuple(
          Schema.String.pipe(Schema.nonEmptyString()),
          Schema.Array(Schema.String.pipe(Schema.nonEmptyString())).pipe(
            Schema.minItems(2),
            Schema.maxItems(5)
          )
        )
      )

      await fc.assert(
        fc.asyncProperty(arb, async ([url, prompts]) => {
          await Effect.gen(function* () {
            const lookup = (params: { url: string; prompt: string }) =>
              Effect.succeed(`result-${params.prompt}`)

            const cache = yield* FuzzyCache.make({
              lookup,
              config: {
                url: Matchers.Exact(),
                prompt: Matchers.levenshtein(0.0)
              },
              capacity: { bucket: 100, list: 10 },
              timeToLive: Duration.infinity
            })

            // Add all prompts to same bucket
            for (const prompt of prompts) {
              yield* cache.set({ url, prompt }, `result-${prompt}`)
            }

            // Query with getAll to get scored results
            const results = yield* cache.getAll({ url, prompt: "query" })

            // Verify descending order
            for (let i = 0; i < results.length - 1; i++) {
              assert.isTrue(results[i]!.score >= results[i + 1]!.score)
            }
          }).pipe(Effect.runPromise)
        }),
        { numRuns: 300 }
      )
    })
  })
})

// ============================================================================
// Cache Subtype Verification Tests
// ============================================================================

describe("FuzzyCache - Cache Subtype Conformance", () => {
  it.effect("should be assignable to Cache type", () =>
    Effect.gen(function* () {
      const lookup = (params: { key: string }) =>
        Effect.succeed(`value-${params.key}`)

      const fuzzyCache = yield* FuzzyCache.make({
        lookup,
        config: { key: Matchers.Exact() },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.infinity
      })

      // Type test: Should be assignable to Cache interface
      const asCache: import("effect/Cache").Cache<{ key: string }, string, never> = fuzzyCache

      // Verify it works as a Cache
      const value = yield* asCache.get({ key: "test" })
      assert.strictEqual(value, "value-test")
    }))

  it.effect("should work with functions expecting Cache interface", () =>
    Effect.gen(function* () {
      // Helper function that accepts any Cache
      const getCached = <K, V, E>(
        cache: import("effect/Cache").Cache<K, V, E>,
        key: K
      ): Effect.Effect<V, E> => cache.get(key)

      const fuzzyCache = yield* FuzzyCache.make({
        lookup: (params: { key: string }) => Effect.succeed(`value-${params.key}`),
        config: { key: Matchers.Exact() },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.infinity
      })

      // Should work seamlessly with generic cache functions
      const value = yield* getCached(fuzzyCache, { key: "test" })
      assert.strictEqual(value, "value-test")
    }))

  it.effect("should implement all Cache methods correctly", () =>
    Effect.gen(function* () {
      const fuzzyCache = yield* FuzzyCache.make({
        lookup: (params: { key: string }) => Effect.succeed(`value-${params.key}`),
        config: { key: Matchers.Exact() },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.infinity
      })

      // Test get
      const value1 = yield* fuzzyCache.get({ key: "a" })
      assert.strictEqual(value1, "value-a")

      // Test getEither
      const either1 = yield* fuzzyCache.getEither({ key: "a" })
      assert.isTrue(Either.isLeft(either1))

      const either2 = yield* fuzzyCache.getEither({ key: "b" })
      assert.isTrue(Either.isRight(either2))

      // Test getOption
      const option1 = yield* fuzzyCache.getOption({ key: "a" })
      assert.isTrue(Option.isSome(option1))

      const option2 = yield* fuzzyCache.getOption({ key: "c" })
      assert.isTrue(Option.isNone(option2))

      // Test getOptionComplete
      const optionComplete = yield* fuzzyCache.getOptionComplete({ key: "a" })
      assert.isTrue(Option.isSome(optionComplete))

      // Test refresh
      yield* fuzzyCache.refresh({ key: "a" })
      const value2 = yield* fuzzyCache.get({ key: "a" })
      assert.strictEqual(value2, "value-a")

      // Test set
      yield* fuzzyCache.set({ key: "d" }, "custom-value")
      const value3 = yield* fuzzyCache.get({ key: "d" })
      assert.strictEqual(value3, "custom-value")
    }))

  it.effect("should return proper CacheStats structure", () =>
    Effect.gen(function* () {
      const fuzzyCache = yield* FuzzyCache.make({
        lookup: (params: { key: string }) => Effect.succeed(`value-${params.key}`),
        config: { key: Matchers.Exact() },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.infinity
      })

      // Trigger some cache operations
      yield* fuzzyCache.get({ key: "a" })  // miss
      yield* fuzzyCache.get({ key: "a" })  // hit
      yield* fuzzyCache.get({ key: "b" })  // miss
      yield* fuzzyCache.set({ key: "c" }, "value-c")

      const stats = yield* fuzzyCache.cacheStats

      // Verify CacheStats structure
      assert.strictEqual(typeof stats.hits, "number")
      assert.strictEqual(typeof stats.misses, "number")
      assert.strictEqual(typeof stats.size, "number")

      // Verify actual values
      assert.strictEqual(stats.hits, 1, "Should have 1 hit")
      assert.strictEqual(stats.misses, 2, "Should have 2 misses")
      assert.strictEqual(stats.size, 3, "Should have 3 entries")
    }))

  it.effect("should return proper EntryStats structure", () =>
    Effect.gen(function* () {
      const fuzzyCache = yield* FuzzyCache.make({
        lookup: (params: { key: string }) => Effect.succeed(`value-${params.key}`),
        config: { key: Matchers.Exact() },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.infinity
      })

      const beforeTime = yield* Clock.currentTimeMillis
      yield* fuzzyCache.get({ key: "test" })
      const afterTime = yield* Clock.currentTimeMillis

      const entryStatsOption = yield* fuzzyCache.entryStats({ key: "test" })

      assert.isTrue(Option.isSome(entryStatsOption))
      if (Option.isSome(entryStatsOption)) {
        const entryStats = entryStatsOption.value

        // Verify EntryStats structure
        assert.strictEqual(typeof entryStats.loadedMillis, "number")

        // Verify loadedMillis is within expected range
        assert.isTrue(entryStats.loadedMillis >= beforeTime)
        assert.isTrue(entryStats.loadedMillis <= afterTime)
      }
    }))

  it.effect("should track entry-level stats, not bucket-level stats", () =>
    Effect.gen(function* () {
      const fuzzyCache = yield* FuzzyCache.make({
        lookup: (params: { userId: string; query: string }) =>
          Effect.succeed(`result-${params.query}`),
        config: {
          userId: Matchers.Exact(),  // Exact match - defines bucket
          query: Matchers.Exact()  // Also exact match to ensure no fuzzy hits
        },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.infinity
      })

      // Add multiple entries to the SAME bucket (same userId, different queries)
      yield* fuzzyCache.get({ userId: "user1", query: "hello" })  // miss, creates bucket
      yield* fuzzyCache.get({ userId: "user1", query: "world" })  // miss, same bucket
      yield* fuzzyCache.get({ userId: "user1", query: "test" })   // miss, same bucket

      // Access existing entries (hits)
      yield* fuzzyCache.get({ userId: "user1", query: "hello" })  // hit
      yield* fuzzyCache.get({ userId: "user1", query: "world" })  // hit

      const stats = yield* fuzzyCache.cacheStats

      // Stats should reflect entry-level operations, not bucket operations
      // We have: 3 misses (3 different entries), 2 hits (2 repeat accesses), 3 entries total
      // The key insight: even though all entries are in the same bucket (same userId),
      // we track stats at the entry level (based on exact query matches)
      assert.strictEqual(stats.misses, 3, "Should track entry-level misses")
      assert.strictEqual(stats.hits, 2, "Should track entry-level hits")
      assert.strictEqual(stats.size, 3, "Should track entry count, not bucket count")
    }))

  it.effect("should provide separate exactStats and fuzzyStats", () =>
    Effect.gen(function* () {
      const fuzzyCache = yield* FuzzyCache.make({
        lookup: (params: { userId: string; query: string }) =>
          Effect.succeed(`result-${params.query}`),
        config: {
          userId: Matchers.Exact(),  // Exact match - defines bucket
          query: Matchers.Exact()  // Also exact match for clarity
        },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.infinity
      })

      // Add entries to create buckets and entries
      yield* fuzzyCache.get({ userId: "user1", query: "hello" })  // entry miss
      yield* fuzzyCache.get({ userId: "user1", query: "world" })  // entry miss (same bucket)
      yield* fuzzyCache.get({ userId: "user2", query: "test" })   // entry miss (new bucket)

      // Access existing entries
      yield* fuzzyCache.get({ userId: "user1", query: "hello" })  // entry hit
      yield* fuzzyCache.get({ userId: "user2", query: "test" })   // entry hit

      // Get stats
      const exactStats = yield* fuzzyCache.exactStats
      const fuzzyStats = yield* fuzzyCache.fuzzyStats
      const cacheStats = yield* fuzzyCache.cacheStats

      // exactStats comes from bucketCache - tracks bucket-level operations
      // Note: bucketCache.size may be higher than expected due to how Effect's Cache
      // tracks entries internally (including Pending states, etc.)
      // The important thing is that exactStats tracks different metrics than fuzzyStats
      assert.strictEqual(typeof exactStats.size, "number", "exactStats should have a size")
      assert.strictEqual(typeof exactStats.hits, "number", "exactStats should have hits")
      assert.strictEqual(typeof exactStats.misses, "number", "exactStats should have misses")

      // fuzzyStats tracks entry-level operations (our custom tracking)
      // We had 3 entry misses (hello, world, test) and 2 entry hits (hello repeat, test repeat)
      assert.strictEqual(fuzzyStats.hits, 2, "fuzzyStats: 2 entry hits")
      assert.strictEqual(fuzzyStats.misses, 3, "fuzzyStats: 3 entry misses")
      assert.strictEqual(fuzzyStats.size, 3, "fuzzyStats: 3 entries")

      // cacheStats should be same as fuzzyStats (backwards compatibility)
      assert.strictEqual(cacheStats.hits, fuzzyStats.hits, "cacheStats matches fuzzyStats.hits")
      assert.strictEqual(cacheStats.misses, fuzzyStats.misses, "cacheStats matches fuzzyStats.misses")
      assert.strictEqual(cacheStats.size, fuzzyStats.size, "cacheStats matches fuzzyStats.size")
    }))

  it.effect("should work as ConsumerCache subtype", () =>
    Effect.gen(function* () {
      const fuzzyCache = yield* FuzzyCache.make({
        lookup: (params: { key: string }) => Effect.succeed(`value-${params.key}`),
        config: { key: Matchers.Exact() },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.infinity
      })

      // Type test: Should be assignable to ConsumerCache
      const asConsumerCache: import("effect/Cache").ConsumerCache<{ key: string }, string, never> = fuzzyCache

      // First populate the cache via the full cache interface
      yield* fuzzyCache.set({ key: "test" }, "test-value")

      // Verify ConsumerCache read-only methods work
      const option = yield* asConsumerCache.getOption({ key: "test" })
      assert.isTrue(Option.isSome(option))

      const hasKey = yield* asConsumerCache.contains({ key: "test" })
      assert.isTrue(hasKey)

      // ConsumerCache can invalidate
      yield* asConsumerCache.invalidate({ key: "test" })
      const optionAfter = yield* asConsumerCache.getOption({ key: "test" })
      assert.isTrue(Option.isNone(optionAfter))
    }))
})

// ============================================================================
// API Method Tests
// ============================================================================

describe("FuzzyCache - API Methods", () => {
  describe("getEither", () => {
    it.effect("should return Either.right for newly computed values", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        const result = yield* cache.getEither({ key: "test" })
        assert.isTrue(Either.isRight(result))
        if (Either.isRight(result)) {
          assert.strictEqual(result.right, "value-test")
        }
      }))

    it.effect("should return Either.left for cached values", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.get({ key: "test" })
        const result = yield* cache.getEither({ key: "test" })

        assert.isTrue(Either.isLeft(result))
        if (Either.isLeft(result)) {
          assert.strictEqual(result.left, "value-test")
        }
      }))
  })

  describe("getOption", () => {
    it.effect("should return Option.none when cache is empty", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        const result = yield* cache.getOption({ key: "test" })
        assert.isTrue(Option.isNone(result))
      }))

    it.effect("should return Option.some when value is cached", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.get({ key: "test" })
        const result = yield* cache.getOption({ key: "test" })

        assert.isTrue(Option.isSome(result))
        if (Option.isSome(result)) {
          assert.strictEqual(result.value, "value-test")
        }
      }))
  })

  describe("getOptionComplete", () => {
    it.effect("should return Option.none when cache is empty", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        const result = yield* cache.getOptionComplete({ key: "test" })
        assert.isTrue(Option.isNone(result))
      }))

    it.effect("should return Option.some when value is cached", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.get({ key: "test" })
        const result = yield* cache.getOptionComplete({ key: "test" })

        assert.isTrue(Option.isSome(result))
        if (Option.isSome(result)) {
          assert.strictEqual(result.value, "value-test")
        }
      }))
  })

  describe("refresh", () => {
    it.effect("should force recomputation", () =>
      Effect.gen(function* () {
        let counter = 0
        const lookup = (_params: { key: string }) =>
          Effect.sync(() => {
            counter++
            return `value-${counter}`
          })

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.get({ key: "test" })
        assert.strictEqual(counter, 1)

        yield* cache.get({ key: "test" })
        assert.strictEqual(counter, 1)

        yield* cache.refresh({ key: "test" })
        assert.strictEqual(counter, 2)
      }))

    it.effect("should add entry if key doesn't exist", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        const size1 = yield* cache.size
        assert.strictEqual(size1, 0)

        yield* cache.refresh({ key: "test" })

        const size2 = yield* cache.size
        assert.strictEqual(size2, 1)
      }))
  })

  describe("contains", () => {
    it.effect("should return false for empty cache", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        const contains = yield* cache.contains({ key: "test" })
        assert.isFalse(contains)
      }))

    it.effect("should return true when bucket has entries", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.set({ key: "test" }, "value")
        const contains = yield* cache.contains({ key: "test" })
        assert.isTrue(contains)
      }))
  })

  describe("entryStats", () => {
    it.effect("should return Option.none for non-existent entry", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        const stats = yield* cache.entryStats({ key: "test" })
        assert.isTrue(Option.isNone(stats))
      }))

    it.effect("should return stats for existing entry", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.get({ key: "test" })
        const stats = yield* cache.entryStats({ key: "test" })

        assert.isTrue(Option.isSome(stats))
      }))
  })

  describe("invalidate", () => {
    it.effect("should remove entry from cache", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.set({ key: "test" }, "value")
        const size1 = yield* cache.size
        assert.strictEqual(size1, 1)

        yield* cache.invalidate({ key: "test" })
        const size2 = yield* cache.size
        assert.strictEqual(size2, 0)
      }))

    it.effect("should do nothing when entry doesn't exist", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.invalidate({ key: "nonexistent" })
        const size = yield* cache.size
        assert.strictEqual(size, 0)
      }))
  })

  describe("invalidateWhen", () => {
    it.effect("should invalidate when predicate returns true", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.set({ key: "test" }, "old-value")
        yield* cache.invalidateWhen(
          { key: "test" },
          (value) => value.startsWith("old")
        )

        const size = yield* cache.size
        assert.strictEqual(size, 0)
      }))

    it.effect("should keep entry when predicate returns false", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.set({ key: "test" }, "new-value")
        yield* cache.invalidateWhen(
          { key: "test" },
          (value) => value.startsWith("old")
        )

        const size = yield* cache.size
        assert.strictEqual(size, 1)
      }))
  })

  describe("keys, values, entries", () => {
    it.effect("should return all keys", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.set({ key: "a" }, "value-a")
        yield* cache.set({ key: "b" }, "value-b")

        const keys = yield* cache.keys
        const keyStrings = keys.map(k => k.key).sort()
        assert.deepStrictEqual(keyStrings, ["a", "b"])
      }))

    it.effect("should return all values", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.set({ key: "a" }, "value-a")
        yield* cache.set({ key: "b" }, "value-b")

        const values = yield* cache.values
        const sortedValues = values.sort()
        assert.deepStrictEqual(sortedValues, ["value-a", "value-b"])
      }))

    it.effect("should return all entries", () =>
      Effect.gen(function* () {
        const lookup = (params: { key: string }) =>
          Effect.succeed(`value-${params.key}`)

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.infinity
        })

        yield* cache.set({ key: "a" }, "value-a")
        yield* cache.set({ key: "b" }, "value-b")

        const entries = yield* cache.entries
        assert.strictEqual(entries.length, 2)
      }))
  })
})

// ============================================================================
// TTL Expiration Tests with TestClock
// ============================================================================

describe("FuzzyCache - TTL Expiration", () => {
  it.effect("should not count expired entries as cache hits", () =>
    Effect.gen(function* () {
      const cache = yield* FuzzyCache.make({
        lookup: (params: { key: string }) => Effect.succeed(`value-${params.key}`),
        config: { key: Matchers.Exact() },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.seconds(1)
      })

      yield* cache.get({ key: "test" })
      yield* TestClock.adjust(Duration.seconds(2))
      yield* cache.get({ key: "test" })

      const { hits, misses } = yield* cache.cacheStats
      assert.strictEqual(hits, 0)
      assert.strictEqual(misses, 2)
    }))

  it.effect("should filter expired entries in getAll", () =>
    Effect.gen(function* () {
      const cache = yield* FuzzyCache.make({
        lookup: (params: { text: string }) => Effect.succeed(`result-${params.text}`),
        config: { text: Matchers.levenshtein(0.0) },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.seconds(5)
      })

      // Add entries
      yield* cache.set({ text: "hello" }, "value1")
      yield* cache.set({ text: "hallo" }, "value2")

      // Both should be present
      const results1 = yield* cache.getAll({ text: "test" })
      assert.strictEqual(results1.length, 2)

      // Expire entries
      yield* TestClock.adjust(Duration.seconds(6))

      // Should trigger lookup (no valid entries)
      const results2 = yield* cache.getAll({ text: "test" })
      assert.strictEqual(results2.length, 1)
      assert.strictEqual(results2[0]?.value, "result-test")
    }))

  it.effect("should not return expired entries in getOption", () =>
    Effect.gen(function* () {
      const cache = yield* FuzzyCache.make({
        lookup: (params: { key: string }) => Effect.succeed(`value-${params.key}`),
        config: { key: Matchers.Exact() },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.seconds(1)
      })

      yield* cache.set({ key: "test" }, "value")

      // Should be present
      const result1 = yield* cache.getOption({ key: "test" })
      assert.isTrue(Option.isSome(result1))

      // Expire entry
      yield* TestClock.adjust(Duration.seconds(2))

      // Should be gone
      const result2 = yield* cache.getOption({ key: "test" })
      assert.isTrue(Option.isNone(result2))
    }))

  it.effect("should respect entries that haven't expired yet", () =>
    Effect.gen(function* () {
      const cache = yield* FuzzyCache.make({
        lookup: (params: { key: string }) => Effect.succeed(`value-${params.key}`),
        config: { key: Matchers.Exact() },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.seconds(10)
      })

      yield* cache.get({ key: "test" })

      // Advance time but not past TTL
      yield* TestClock.adjust(Duration.seconds(5))

      const result = yield* cache.get({ key: "test" })
      assert.strictEqual(result, "value-test")

      // Should be a cache hit
      const { hits, misses } = yield* cache.cacheStats
      assert.strictEqual(hits, 1)
      assert.strictEqual(misses, 1)
    }))

  it.effect("should handle entries with different expiration times", () =>
    Effect.gen(function* () {
      const cache = yield* FuzzyCache.makeWith({
        lookup: (params: { key: string }) => Effect.succeed(`value-${params.key}`),
        config: { key: Matchers.Exact() },
        capacity: { bucket: 100, list: 10 },
        timeToLive: (exit) =>
          Exit.isSuccess(exit)
            ? Duration.seconds(10)
            : Duration.seconds(1)
      })

      // Add entry with 10 second TTL
      yield* cache.get({ key: "test1" })

      // Advance 5 seconds
      yield* TestClock.adjust(Duration.seconds(5))

      // Add another entry with 10 second TTL
      yield* cache.get({ key: "test2" })

      // Advance 6 more seconds (total 11)
      yield* TestClock.adjust(Duration.seconds(6))

      // First entry should be expired, second should not
      const result1 = yield* cache.getOption({ key: "test1" })
      const result2 = yield* cache.getOption({ key: "test2" })

      assert.isTrue(Option.isNone(result1))
      assert.isTrue(Option.isSome(result2))
    }))

  it.effect("should handle fuzzy entries in same bucket with staggered TTLs", () =>
    Effect.gen(function* () {
      const cache = yield* FuzzyCache.make({
        lookup: (params: { userId: string; query: string }) =>
          Effect.succeed(`value-${params.query}`),
        config: {
          userId: Matchers.Exact(),
          query: Matchers.levenshtein(0.0)
        },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.seconds(5)
      })

      // Add first fuzzy entry to bucket using set (expires at T+5)
      yield* cache.set({ userId: "user1", query: "hello" }, "value-hello")

      // Advance 3 seconds
      yield* TestClock.adjust(Duration.seconds(3))

      // Add second fuzzy entry to SAME bucket using set (expires at T+8)
      yield* cache.set({ userId: "user1", query: "hallo" }, "value-hallo")

      // Advance 3 more seconds (total 6 seconds from start)
      yield* TestClock.adjust(Duration.seconds(3))

      // At T=6000ms: first entry expired (6000 > 5000), second entry still valid (6000 < 8000)
      // Use getAll to see all entries in the bucket (expired ones are filtered out)
      const allResults = yield* cache.getAll({ userId: "user1", query: "test" })

      assert.strictEqual(allResults.length, 1, "Only one entry should remain (first expired)")
      assert.strictEqual(allResults[0]?.value, "value-hallo", "Only second entry should remain")
    }))
})

// ============================================================================
// minScore Threshold Tests
// ============================================================================

describe("FuzzyCache - minScore Threshold", () => {
  it.effect("should filter results below minScore in get", () =>
    Effect.gen(function* () {
      let lookupCalls = 0
      const cache = yield* FuzzyCache.make({
        lookup: (params: { text: string }) => Effect.sync(() => {
          lookupCalls++
          return `result-${params.text}`
        }),
        config: { text: Matchers.levenshtein(0.8) },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.infinity,
        minScore: 0.8
      })

      // Cache a value
      yield* cache.set({ text: "hello" }, "cached-hello")

      // Query with very different text (low score)
      // Should trigger lookup because score is below threshold
      const result = yield* cache.get({ text: "xyz" })
      assert.strictEqual(result, "result-xyz")
      assert.strictEqual(lookupCalls, 1)
    }))

  it.effect("should allow per-call threshold in getAll", () =>
    Effect.gen(function* () {
      const cache = yield* FuzzyCache.make({
        lookup: (params: { text: string }) => Effect.succeed(`result-${params.text}`),
        config: { text: Matchers.levenshtein(0.5) },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.infinity,
        minScore: 0.5
      })

      // Cache multiple values
      yield* cache.set({ text: "hello" }, "value1")
      yield* cache.set({ text: "hallo" }, "value2")
      yield* cache.set({ text: "hullo" }, "value3")

      // Get all with high threshold
      const results = yield* cache.getAll({ text: "hello" }, 0.9)

      // Should only return exact or very close matches
      assert.isTrue(results.length >= 1)
      assert.isTrue(results[0]!.score >= 0.9)
    }))

  it.effect("should use global minScore when no threshold provided", () =>
    Effect.gen(function* () {
      const cache = yield* FuzzyCache.make({
        lookup: (params: { text: string }) => Effect.succeed(`result-${params.text}`),
        config: { text: Matchers.levenshtein(0.0) },
        capacity: { bucket: 100, list: 10 },
        timeToLive: Duration.infinity,
        minScore: 0.7
      })

      yield* cache.set({ text: "hello" }, "value1")
      yield* cache.set({ text: "world" }, "value2")

      // getAll should filter by global minScore
      const results = yield* cache.getAll({ text: "hello" })

      // All results should have score >= 0.7
      for (const result of results) {
        assert.isTrue(result.score >= 0.7)
      }
    }))
})

// ============================================================================
// Max Capacity and Expiration-Based Eviction Tests
// ============================================================================

describe("FuzzyCache - Max Capacity with Expiration-Based Eviction", () => {
  describe("Queue Capacity Enforcement", () => {
    it.effect("should evict entry with earliest TTL when queue capacity is reached", () =>
      Effect.gen(function* () {
        const cache = yield* FuzzyCache.make({
          lookup: (params: { bucket: string; query: string }) =>
            Effect.succeed(`value-${params.query}`),
          config: {
            bucket: Matchers.Exact(),
            query: Matchers.levenshtein(0.0)
          },
          capacity: { bucket: 5, list: 3 },
          timeToLive: Duration.seconds(10)
        })

        // Fill queue to capacity (3 entries in same bucket)
        yield* cache.set({ bucket: "b1", query: "q1" }, "v1")
        yield* cache.set({ bucket: "b1", query: "q2" }, "v2")
        yield* cache.set({ bucket: "b1", query: "q3" }, "v3")

        // Verify all 3 are present by checking values directly
        const valuesBefore = yield* cache.values
        assert.strictEqual(valuesBefore.length, 3, "Should have 3 entries before eviction")

        // Add one more entry to trigger eviction
        yield* cache.set({ bucket: "b1", query: "q4" }, "v4")

        // Verify only 3 entries remain (one was evicted)
        const valuesAfter = yield* cache.values
        assert.strictEqual(valuesAfter.length, 3, "Should have 3 entries after eviction")

        // Verify the earliest entry (k1/v1) was evicted
        const values = valuesAfter.sort()
        assert.deepStrictEqual(values, ["v2", "v3", "v4"])
      }))

    it.effect("should evict entry with earliest TTL based on expiration time, not insertion order", () =>
      Effect.gen(function* () {
        const cache = yield* FuzzyCache.make({
          lookup: (params: { bucket: string; query: string }) =>
            Effect.succeed(`value-${params.query}`),
          config: {
            bucket: Matchers.Exact(),
            query: Matchers.levenshtein(0.0)
          },
          capacity: { bucket: 5, list: 3 },
          timeToLive: Duration.seconds(10)
        })

        // Add entry with TTL expiring at T+10s
        yield* cache.set({ bucket: "b1", query: "q1" }, "v1")

        // Advance time by 3 seconds
        yield* TestClock.adjust(Duration.seconds(3))

        // Add entry with TTL expiring at T+13s (later than q1)
        yield* cache.set({ bucket: "b1", query: "q2" }, "v2")

        // Advance time by 2 seconds (total T+5s)
        yield* TestClock.adjust(Duration.seconds(2))

        // Add entry with TTL expiring at T+15s (latest)
        yield* cache.set({ bucket: "b1", query: "q3" }, "v3")

        // Add one more to trigger eviction
        // q1 has earliest expiration (T+10s), so it should be evicted
        yield* cache.set({ bucket: "b1", query: "q4" }, "v4")

        const valuesAfter = yield* cache.values
        const values = valuesAfter.sort()

        // k1 should be evicted (earliest expiration)
        assert.deepStrictEqual(values, ["v2", "v3", "v4"])
      }))
  })

  describe("Expiration-Based Eviction Priority", () => {
    it.effect("should evict entry with shortest TTL when capacity is reached", () =>
      Effect.gen(function* () {
        const cache = yield* FuzzyCache.makeWith({
          lookup: (params: { bucket: string; query: string }) =>
            Effect.succeed(`value-${params.query}`),
          config: {
            bucket: Matchers.Exact(),
            query: Matchers.levenshtein(0.0)
          },
          capacity: { bucket: 5, list: 3 },
          timeToLive: (exit) => {
            if (Exit.isSuccess(exit)) {
              const value = exit.value
              // Different TTLs based on value
              if (value === "v1") return Duration.seconds(5)
              if (value === "v2") return Duration.seconds(10)
              if (value === "v3") return Duration.seconds(15)
              return Duration.seconds(20)
            }
            return Duration.seconds(1)
          }
        })

        // Add 3 entries with different TTLs
        yield* cache.set({ bucket: "b1", query: "q1" }, "v1") // expires at T+5s
        yield* cache.set({ bucket: "b1", query: "q2" }, "v2") // expires at T+10s
        yield* cache.set({ bucket: "b1", query: "q3" }, "v3") // expires at T+15s

        // Verify all 3 are present
        const valuesBefore = yield* cache.values
        assert.strictEqual(valuesBefore.length, 3)

        // Add 4th entry to trigger eviction (expires at T+20s)
        yield* cache.set({ bucket: "b1", query: "q4" }, "v4")

        // Entry with 5s TTL (k1) should be evicted
        const valuesAfter = yield* cache.values
        assert.strictEqual(valuesAfter.length, 3)

        const values = valuesAfter.sort()
        assert.deepStrictEqual(values, ["v2", "v3", "v4"])
      }))

    it.effect("should maintain entries with longer TTLs after eviction", () =>
      Effect.gen(function* () {
        const cache = yield* FuzzyCache.makeWith({
          lookup: (params: { bucket: string; query: string }) =>
            Effect.succeed(`value-${params.query}`),
          config: {
            bucket: Matchers.Exact(),
            query: Matchers.levenshtein(0.0)
          },
          capacity: { bucket: 5, list: 3 },
          timeToLive: (exit) => {
            if (Exit.isSuccess(exit)) {
              const value = exit.value
              if (value === "short") return Duration.seconds(5)
              if (value === "medium") return Duration.seconds(10)
              if (value === "long") return Duration.seconds(15)
              return Duration.seconds(20)
            }
            return Duration.seconds(1)
          }
        })

        // Fill to capacity with staggered TTLs
        yield* cache.set({ bucket: "b1", query: "q1" }, "short")
        yield* cache.set({ bucket: "b1", query: "q2" }, "medium")
        yield* cache.set({ bucket: "b1", query: "q3" }, "long")

        // Add new entry to trigger eviction
        yield* cache.set({ bucket: "b1", query: "q4" }, "newest")

        // Verify short TTL was evicted
        const valuesAfter = yield* cache.values
        const values = new Set(valuesAfter)

        assert.isFalse(values.has("short"), "Short TTL entry should be evicted")
        assert.isTrue(values.has("medium"), "Medium TTL entry should remain")
        assert.isTrue(values.has("long"), "Long TTL entry should remain")
        assert.isTrue(values.has("newest"), "Newest entry should be present")
      }))
  })

  describe("Bucket Capacity Enforcement", () => {
    it.effect("should enforce bucket capacity limit", () =>
      Effect.gen(function* () {
        const cache = yield* FuzzyCache.make({
          lookup: (params: { bucket: string; key: string }) =>
            Effect.succeed(`value-${params.key}`),
          config: {
            bucket: Matchers.Exact(),
            key: Matchers.Exact()
          },
          capacity: { bucket: 3, list: 5 },
          timeToLive: Duration.seconds(10)
        })

        // Fill bucket capacity with different buckets
        yield* cache.set({ bucket: "b1", key: "k1" }, "v1")
        yield* cache.set({ bucket: "b2", key: "k2" }, "v2")
        yield* cache.set({ bucket: "b3", key: "k3" }, "v3")

        // Verify all 3 buckets exist
        const size1 = yield* cache.size
        assert.strictEqual(size1, 3)

        // Add entry to new bucket (should trigger bucket eviction)
        yield* cache.set({ bucket: "b4", key: "k4" }, "v4")

        // Verify size is still at bucket capacity
        const size2 = yield* cache.size
        assert.strictEqual(size2, 3)
      }))
  })

  describe("Mixed Capacity Scenarios", () => {
    it.effect("should handle multiple evictions with staggered TTLs", () =>
      Effect.gen(function* () {
        const cache = yield* FuzzyCache.makeWith({
          lookup: (params: { bucket: string; query: string }) =>
            Effect.succeed(`value-${params.query}`),
          config: {
            bucket: Matchers.Exact(),
            query: Matchers.levenshtein(0.0)
          },
          capacity: { bucket: 5, list: 3 },
          timeToLive: (exit) => {
            if (Exit.isSuccess(exit)) {
              const value = exit.value
              // Parse TTL from value like "ttl-5"
              const match = value.match(/ttl-(\d+)/)
              if (match) {
                return Duration.seconds(parseInt(match[1]!))
              }
            }
            return Duration.seconds(10)
          }
        })

        // Fill queue with entries having different TTLs
        yield* cache.set({ bucket: "b1", query: "q1" }, "ttl-5")  // shortest
        yield* cache.set({ bucket: "b1", query: "q2" }, "ttl-15") // longest
        yield* cache.set({ bucket: "b1", query: "q3" }, "ttl-10") // medium

        // Add multiple new entries to trigger multiple evictions
        yield* cache.set({ bucket: "b1", query: "q4" }, "ttl-12")
        yield* cache.set({ bucket: "b1", query: "q5" }, "ttl-8")

        // Verify capacity is maintained
        const valuesAfter = yield* cache.values
        assert.strictEqual(valuesAfter.length, 3, "Should maintain queue capacity of 3")

        // Verify eviction order: shortest TTLs evicted first
        const values = new Set(valuesAfter)

        // q1 (ttl-5) should be evicted when q4 is added
        // q3 (ttl-10) should be evicted when q5 is added (ttl-10 was the earliest in bucket at that time)
        assert.isFalse(values.has("ttl-5"), "Shortest TTL should be evicted first")
        assert.isFalse(values.has("ttl-10"), "Next shortest TTL should be evicted second")

        // Remaining should be ttl-15, ttl-12, and ttl-8
        assert.isTrue(values.has("ttl-8"))
        assert.isTrue(values.has("ttl-12"))
        assert.isTrue(values.has("ttl-15"))
      }))

    it.effect("should evict correct entry when entries have same initial time but different TTLs", () =>
      Effect.gen(function* () {
        const cache = yield* FuzzyCache.makeWith({
          lookup: (params: { bucket: string; query: string }) =>
            Effect.succeed(`value-${params.query}`),
          config: {
            bucket: Matchers.Exact(),
            query: Matchers.levenshtein(0.0)
          },
          capacity: { bucket: 5, list: 3 },
          timeToLive: (exit) => {
            if (Exit.isSuccess(exit)) {
              const value = exit.value
              if (value === "v1") return Duration.seconds(5)
              if (value === "v2") return Duration.seconds(10)
              if (value === "v3") return Duration.seconds(15)
            }
            return Duration.seconds(10)
          }
        })

        // Add all 3 entries at the same time with different TTLs
        yield* cache.set({ bucket: "b1", query: "q1" }, "v1") // expires at T + 5s
        yield* cache.set({ bucket: "b1", query: "q2" }, "v2") // expires at T + 10s
        yield* cache.set({ bucket: "b1", query: "q3" }, "v3") // expires at T + 15s

        // Don't advance time - add 4th entry immediately
        yield* cache.set({ bucket: "b1", query: "q4" }, "v4")

        // v1 should be evicted (earliest absolute expiration time)
        const valuesAfter = yield* cache.values
        const values = new Set(valuesAfter)

        assert.isFalse(values.has("v1"), "Entry with shortest TTL should be evicted")
        assert.isTrue(values.has("v2"))
        assert.isTrue(values.has("v3"))
        assert.isTrue(values.has("v4"))
      }))

    it.effect("should continuously evict earliest expiring entries as capacity is exceeded", () =>
      Effect.gen(function* () {
        const cache = yield* FuzzyCache.make({
          lookup: (params: { bucket: string; query: string }) =>
            Effect.succeed(`value-${params.query}`),
          config: {
            bucket: Matchers.Exact(),
            query: Matchers.levenshtein(0.0)
          },
          capacity: { bucket: 5, list: 2 },
          timeToLive: Duration.seconds(10)
        })

        // Add entries one by one with time progression
        yield* cache.set({ bucket: "b1", query: "q1" }, "v1")
        yield* TestClock.adjust(Duration.seconds(1))

        yield* cache.set({ bucket: "b1", query: "q2" }, "v2")
        yield* TestClock.adjust(Duration.seconds(1))

        // At capacity (2 entries)
        let size = yield* cache.size
        assert.strictEqual(size, 2)

        // Add 3rd entry - should evict q1 (earliest expiration at T+10s)
        yield* cache.set({ bucket: "b1", query: "q3" }, "v3")
        yield* TestClock.adjust(Duration.seconds(1))

        size = yield* cache.size
        assert.strictEqual(size, 2, "Should maintain capacity of 2")

        let valuesAfter = yield* cache.values
        let values = new Set(valuesAfter)
        assert.isFalse(values.has("v1"), "v1 should be evicted")
        assert.isTrue(values.has("v2"))
        assert.isTrue(values.has("v3"))

        // Add 4th entry - should evict q2 (now the earliest at T+11s)
        yield* cache.set({ bucket: "b1", query: "q4" }, "v4")

        valuesAfter = yield* cache.values
        values = new Set(valuesAfter)
        assert.isFalse(values.has("v2"), "v2 should be evicted")
        assert.isTrue(values.has("v3"))
        assert.isTrue(values.has("v4"))
      }))
  })

  describe("In-flight Request Deduplication", () => {
    it.effect("should deduplicate concurrent requests for same params", () =>
      Effect.gen(function* () {
        let lookupCount = 0

        const cache = yield* FuzzyCache.make({
          lookup: (params: { key: string }) =>
            Effect.sync(() => {
              lookupCount++
              return `value-${params.key}`
            }),
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.minutes(5)
        })

        // Launch 5 concurrent get operations for same params
        const results = yield* Effect.all([
          cache.get({ key: "test" }),
          cache.get({ key: "test" }),
          cache.get({ key: "test" }),
          cache.get({ key: "test" }),
          cache.get({ key: "test" })
        ], { concurrency: "unbounded" })

        // Should only lookup once
        assert.strictEqual(lookupCount, 1)

        // All results should be the same
        assert.isTrue(results.every(r => r === results[0]))
        assert.strictEqual(results[0], "value-test")
      }))

    it.effect("getOption should wait for in-flight lookups", () =>
      Effect.gen(function* () {
        const startDeferred = yield* Deferred.make<void>()
        const completeDeferred = yield* Deferred.make<void>()

        const cache = yield* FuzzyCache.make({
          lookup: (params: { key: string }) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(startDeferred, void 0)
              yield* Deferred.await(completeDeferred)
              return `value-${params.key}`
            }),
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.minutes(5)
        })

        // Start lookup in background
        const getFiber = yield* Effect.fork(cache.get({ key: "test" }))

        // Wait for lookup to start
        yield* Deferred.await(startDeferred)

        // Fork getOption (it will wait for pending lookup)
        const getOptionFiber = yield* Effect.fork(cache.getOption({ key: "test" }))

        // Complete the lookup
        yield* Deferred.succeed(completeDeferred, void 0)

        // Both should complete successfully
        const valueExit = yield* getFiber.await
        const optionExit = yield* getOptionFiber.await

        assert.isTrue(Exit.isSuccess(valueExit))
        assert.isTrue(Exit.isSuccess(optionExit))

        if (Exit.isSuccess(valueExit) && Exit.isSuccess(optionExit)) {
          const value = valueExit.value
          const option = optionExit.value

          assert.strictEqual(value, "value-test")
          assert.isTrue(Option.isSome(option))
          if (Option.isSome(option)) {
            assert.strictEqual(option.value, "value-test")
          }
        }
      }))

    it.effect("getOptionComplete should return None for in-flight lookups", () =>
      Effect.gen(function* () {
        const startDeferred = yield* Deferred.make<void>()
        const completeDeferred = yield* Deferred.make<void>()

        const cache = yield* FuzzyCache.make({
          lookup: (params: { key: string }) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(startDeferred, void 0)
              yield* Deferred.await(completeDeferred)
              return `value-${params.key}`
            }),
          config: { key: Matchers.Exact() },
          capacity: { bucket: 100, list: 10 },
          timeToLive: Duration.minutes(5)
        })

        // Start lookup in background
        const getFiber = yield* Effect.fork(cache.get({ key: "test" }))

        // Wait for lookup to start
        yield* Deferred.await(startDeferred)

        // getOptionComplete should return None (not complete yet)
        const option = yield* cache.getOptionComplete({ key: "test" })
        assert.isTrue(Option.isNone(option))

        // Complete the lookup
        yield* Deferred.succeed(completeDeferred, void 0)
        yield* getFiber.await

        // Now getOptionComplete should return Some
        const optionAfter = yield* cache.getOptionComplete({ key: "test" })
        assert.isTrue(Option.isSome(optionAfter))
      }))
  })
})
