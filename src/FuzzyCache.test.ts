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
import * as TestClock from "effect/TestClock"
import { Arbitrary, Exit, FastCheck as fc } from "effect"
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
              capacity: 100,
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
              capacity: 100,
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
              capacity: 100,
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
              capacity: 100,
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
              capacity: 100,
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
              capacity: 100,
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
              capacity: 100,
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
              capacity: 100,
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
              capacity: 100,
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
              capacity: 100,
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
              capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
        const lookup = (params: { key: string }) =>
          Effect.sync(() => {
            counter++
            return `value-${counter}`
          })

        const cache = yield* FuzzyCache.make({
          lookup,
          config: { key: Matchers.Exact() },
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
          capacity: 100,
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
        capacity: 100,
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
        capacity: 100,
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
        capacity: 100,
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
        capacity: 100,
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
        capacity: 100,
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
        capacity: 100,
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
        capacity: 100,
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
        capacity: 100,
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
