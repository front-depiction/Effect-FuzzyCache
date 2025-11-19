import * as Effect from "effect/Effect"
import * as Duration from "effect/Duration"
import * as FuzzyCache from "./FuzzyCache.js"
import * as Matchers from "./Matchers.js"

// Example: Website Q&A with fuzzy prompt matching

const askWebsite = (params: { url: string; prompt: string }) =>
  Effect.gen(function* () {
    console.log(`[FETCH] Answering "${params.prompt}" for ${params.url}`)
    yield* Effect.sleep("100 millis")
    return {
      answer: `Answer to "${params.prompt}" from ${params.url}`,
      confidence: 0.95
    }
  })

const program = Effect.gen(function* () {
  console.log("\n=== FuzzyCache Example ===\n")

  // Create fuzzy cache
  const cache = yield* FuzzyCache.make({
    lookup: askWebsite,
    config: {
      url: Matchers.Exact(),
      prompt: Matchers.levenshtein(0.7)
    },
    capacity: 100,
    timeToLive: Duration.minutes(30)
  })

  // First question - cache miss
  console.log("1. First question (cache miss):")
  const result1 = yield* cache.get({
    url: "https://wikipedia.org/wiki/France",
    prompt: "What is the capital of France?"
  })
  console.log(`   Score: ${result1[0]?.score}`)
  console.log(`   Answer: ${result1[0]?.value.answer}\n`)

  // Same question - exact cache hit
  console.log("2. Same question (exact hit, score = 1.0):")
  const result2 = yield* cache.get({
    url: "https://wikipedia.org/wiki/France",
    prompt: "What is the capital of France?"
  })
  console.log(`   Score: ${result2[0]?.score}`)
  console.log(`   Results: ${result2.length}\n`)

  // Similar question - fuzzy match
  console.log("3. Similar question (fuzzy match):")
  const result3 = yield* cache.get({
    url: "https://wikipedia.org/wiki/France",
    prompt: "What is the capital city of France?"
  })
  console.log(`   Score: ${result3[0]?.score}`)
  console.log(`   Results: ${result3.length}\n`)

  // Different URL - cache miss (URL is exact match)
  console.log("4. Different URL (cache miss):")
  const result4 = yield* cache.get({
    url: "https://wikipedia.org/wiki/Germany",
    prompt: "What is the capital of France?"
  })
  console.log(`   Score: ${result4[0]?.score}\n`)

  console.log("=== Example Complete ===\n")
})

Effect.runPromise(program)
