/**
 * Property-based tests for FuzzyCache implementation using FastCheck and Schema.Arbitrary
 *
 * @since 1.0.0
 */

import { describe, it, expect } from "bun:test"
import * as Effect from "effect/Effect"
import * as Duration from "effect/Duration"
import * as Schema from "effect/Schema"
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
          await Effect.runPromise(
            Effect.gen(function* () {
              const lookup = (params: { key: string }) =>
                Effect.succeed(`value-${params.key}`)

              const cache = yield* FuzzyCache.make({
                lookup,
                config: { key: Matchers.Exact() },
                capacity: 100,
                timeToLive: Duration.infinity
              })

              // First call
              const result1 = yield* cache.get({ key })
              expect(result1.length).toBe(1)
              expect(result1[0]?.score).toBe(1.0)

              // Second call with same key - should always return score 1.0
              const result2 = yield* cache.get({ key })
              expect(result2.length).toBe(1)
              expect(result2[0]?.score).toBe(1.0)
              expect(result2[0]?.value).toBe(result1[0]?.value)
            })
          )
        }),
        { numRuns: 100 }
      )
    })

    it("should never call lookup twice for same exact key", async () => {
      const arb = Arbitrary.make(Schema.String.pipe(Schema.nonEmptyString()))

      await fc.assert(
        fc.asyncProperty(arb, async (key) => {
          await Effect.runPromise(
            Effect.gen(function* () {
              let callCount = 0
              const lookup = (params: { key: string }) =>
                Effect.sync(() => {
                  callCount++
                  return `value-${params.key}`
                })

              const cache = yield* FuzzyCache.make({
                lookup,
                config: { key: Matchers.Exact() },
                capacity: 100,
                timeToLive: Duration.infinity
              })

              // Call multiple times
              yield* cache.get({ key })
              yield* cache.get({ key })
              yield* cache.get({ key })

              // Should only lookup once
              expect(callCount).toBe(1)
            })
          )
        }),
        { numRuns: 50 }
      )
    })
  })

  describe("Levenshtein Distance Properties", () => {
    it("should return score 1.0 for identical strings", async () => {
      const arb = Arbitrary.make(Schema.String.pipe(Schema.nonEmptyString()))

      await fc.assert(
        fc.asyncProperty(arb, async (str) => {
          await Effect.runPromise(
            Effect.gen(function* () {
              const lookup = (params: { text: string }) =>
                Effect.succeed(`result-${params.text}`)

              const cache = yield* FuzzyCache.make({
                lookup,
                config: { text: Matchers.levenshtein(0.5) },
                capacity: 100,
                timeToLive: Duration.infinity
              })

              // Cache the string
              yield* cache.set({ text: str }, `result-${str}`)

              // Query with identical string
              const results = yield* cache.get({ text: str })

              // Should always have score 1.0 for identical strings
              expect(results.length).toBeGreaterThan(0)
              expect(results[0]?.score).toBe(1.0)
            })
          )
        }),
        { numRuns: 100 }
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
          await Effect.runPromise(
            Effect.gen(function* () {
              const lookup = (params: { text: string }) =>
                Effect.succeed(`result-${params.text}`)

              const cache = yield* FuzzyCache.make({
                lookup,
                config: { text: Matchers.levenshtein(0.0) }, // Allow all scores
                capacity: 100,
                timeToLive: Duration.infinity
              })

              // Cache str1, query str2
              yield* cache.set({ text: str1 }, `result-${str1}`)
              const results1 = yield* cache.get({ text: str2 })
              const score1 = results1[0]?.score ?? 0

              // Clear and reverse
              yield* cache.invalidateAll

              // Cache str2, query str1
              yield* cache.set({ text: str2 }, `result-${str2}`)
              const results2 = yield* cache.get({ text: str1 })
              const score2 = results2[0]?.score ?? 0

              // Scores should be identical (symmetric property)
              expect(Math.abs(score1 - score2)).toBeLessThan(0.001)
            })
          )
        }),
        { numRuns: 50 }
      )
    })

    it("should have score in range [0, 1]", async () => {
      const arbPair = Arbitrary.make(
        Schema.Tuple(Schema.String, Schema.String)
      )

      await fc.assert(
        fc.asyncProperty(arbPair, async ([cached, query]) => {
          await Effect.runPromise(
            Effect.gen(function* () {
              const lookup = (params: { text: string }) =>
                Effect.succeed(`result-${params.text}`)

              const cache = yield* FuzzyCache.make({
                lookup,
                config: { text: Matchers.levenshtein(0.0) },
                capacity: 100,
                timeToLive: Duration.infinity
              })

              yield* cache.set({ text: cached }, `result-${cached}`)
              const results = yield* cache.get({ text: query })

              // Score must be in [0, 1]
              const score = results[0]?.score ?? 0
              expect(score).toBeGreaterThanOrEqual(0)
              expect(score).toBeLessThanOrEqual(1)
            })
          )
        }),
        { numRuns: 100 }
      )
    })
  })

  describe("Numeric Matcher Properties", () => {
    it("should return score 1.0 for values within tolerance", async () => {
      const arb = Arbitrary.make(Schema.Number.pipe(Schema.between(0, 1000)))

      await fc.assert(
        fc.asyncProperty(arb, async (baseValue) => {
          await Effect.runPromise(
            Effect.gen(function* () {
              const tolerance = 10
              const lookup = (params: { value: number }) =>
                Effect.succeed(`result-${params.value}`)

              const cache = yield* FuzzyCache.make({
                lookup,
                config: { value: Matchers.numeric(tolerance) },
                capacity: 100,
                timeToLive: Duration.infinity
              })

              // Cache base value
              yield* cache.set({ value: baseValue }, `result-${baseValue}`)

              // Query with value within tolerance (baseValue + 5)
              const queryValue = baseValue + 5
              const results = yield* cache.get({ value: queryValue })

              // Should have score 1.0 since within tolerance
              expect(results[0]?.score).toBe(1.0)
            })
          )
        }),
        { numRuns: 50 }
      )
    })

    it("should have score 0 for values at 2x tolerance", async () => {
      const arb = Arbitrary.make(Schema.Number.pipe(Schema.between(100, 1000)))

      await fc.assert(
        fc.asyncProperty(arb, async (baseValue) => {
          await Effect.runPromise(
            Effect.gen(function* () {
              const tolerance = 10
              const lookup = (params: { value: number }) =>
                Effect.succeed(`result-${params.value}`)

              const cache = yield* FuzzyCache.make({
                lookup,
                config: { value: Matchers.numeric(tolerance) },
                capacity: 100,
                timeToLive: Duration.infinity
              })

              // Cache base value
              yield* cache.set({ value: baseValue }, `result-${baseValue}`)

              // Query with value at 2x tolerance
              const queryValue = baseValue + (tolerance * 2)
              const results = yield* cache.get({ value: queryValue })

              // Should have score 0 at 2x tolerance
              expect(results[0]?.score).toBe(0.0)
            })
          )
        }),
        { numRuns: 50 }
      )
    })

    it("should decrease monotonically as distance increases", async () => {
      const arb = Arbitrary.make(Schema.Number.pipe(Schema.between(100, 500)))

      await fc.assert(
        fc.asyncProperty(arb, async (baseValue) => {
          await Effect.runPromise(
            Effect.gen(function* () {
              const tolerance = 20
              const lookup = (params: { value: number }) =>
                Effect.succeed(`result-${params.value}`)

              const cache = yield* FuzzyCache.make({
                lookup,
                config: { value: Matchers.numeric(tolerance) },
                capacity: 100,
                timeToLive: Duration.infinity
              })

              // Cache base value
              yield* cache.set({ value: baseValue }, `result-${baseValue}`)

              // Test increasing distances
              const results1 = yield* cache.get({ value: baseValue + 5 })
              const results2 = yield* cache.get({ value: baseValue + 15 })
              const results3 = yield* cache.get({ value: baseValue + 25 })

              const score1 = results1[0]?.score ?? 0
              const score2 = results2[0]?.score ?? 0
              const score3 = results3[0]?.score ?? 0

              // Scores should decrease as distance increases
              expect(score1).toBeGreaterThanOrEqual(score2)
              expect(score2).toBeGreaterThanOrEqual(score3)
            })
          )
        }),
        { numRuns: 30 }
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
          await Effect.runPromise(
            Effect.gen(function* () {
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
                capacity: 100,
                timeToLive: Duration.infinity
              })

              // Store in bucket for url1
              yield* cache.set({ url: url1, prompt: "test" }, "value1")

              // Query bucket for url2 (different exact param)
              const results = yield* cache.get({ url: url2, prompt: "test" })

              // Should trigger lookup (new bucket), score 1.0
              expect(results[0]?.score).toBe(1.0)
              expect(results[0]?.value).toBe(`answer-${url2}`)
            })
          )
        }),
        { numRuns: 50 }
      )
    })

    it("should return all entries in same bucket", async () => {
      const arb = Arbitrary.make(Schema.String.pipe(Schema.nonEmptyString()))

      await fc.assert(
        fc.asyncProperty(arb, async (url) => {
          await Effect.runPromise(
            Effect.gen(function* () {
              const lookup = (params: { url: string; prompt: string }) =>
                Effect.succeed(`result-${params.prompt}`)

              const cache = yield* FuzzyCache.make({
                lookup,
                config: {
                  url: Matchers.Exact(),
                  prompt: Matchers.levenshtein(0.0) // Return all
                },
                capacity: 100,
                timeToLive: Duration.infinity
              })

              // Add multiple entries to same bucket (same url)
              yield* cache.set({ url, prompt: "A" }, "resultA")
              yield* cache.set({ url, prompt: "B" }, "resultB")
              yield* cache.set({ url, prompt: "C" }, "resultC")

              // Query should return all 3
              const results = yield* cache.get({ url, prompt: "X" })
              expect(results.length).toBe(3)
            })
          )
        }),
        { numRuns: 30 }
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
          await Effect.runPromise(
            Effect.gen(function* () {
              const lookup = (params: { key: string }) =>
                Effect.succeed(`value-${params.key}`)

              const cache = yield* FuzzyCache.make({
                lookup,
                config: { key: Matchers.Exact() },
                capacity: 100,
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
              expect(size).toBe(0)
            })
          )
        }),
        { numRuns: 30 }
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
          await Effect.runPromise(
            Effect.gen(function* () {
              const lookup = (params: { key: string }) =>
                Effect.succeed(`value-${params.key}`)

              const cache = yield* FuzzyCache.make({
                lookup,
                config: { key: Matchers.Exact() },
                capacity: 100,
                timeToLive: Duration.infinity
              })

              // Add all keys
              for (const key of keys) {
                yield* cache.set({ key }, `value-${key}`)
              }

              // Size should equal number of unique keys
              const size = yield* cache.size
              const uniqueKeys = new Set(keys).size
              expect(size).toBe(uniqueKeys)
            })
          )
        }),
        { numRuns: 30 }
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
          await Effect.runPromise(
            Effect.gen(function* () {
              const lookup = (params: { url: string; prompt: string }) =>
                Effect.succeed(`result-${params.prompt}`)

              const cache = yield* FuzzyCache.make({
                lookup,
                config: {
                  url: Matchers.Exact(),
                  prompt: Matchers.levenshtein(0.0)
                },
                capacity: 100,
                timeToLive: Duration.infinity
              })

              // Add all prompts to same bucket
              for (const prompt of prompts) {
                yield* cache.set({ url, prompt }, `result-${prompt}`)
              }

              // Query
              const results = yield* cache.get({ url, prompt: "query" })

              // Verify descending order
              for (let i = 0; i < results.length - 1; i++) {
                expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score)
              }
            })
          )
        }),
        { numRuns: 30 }
      )
    })
  })
})
