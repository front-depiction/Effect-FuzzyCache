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
  const answer1 = yield* cache.get({
    url: "https://wikipedia.org/wiki/France",
    prompt: "What is the capital of France?"
  })
  console.log(`   Answer: ${answer1.answer}\n`)

  // Same question - exact cache hit
  console.log("2. Same question (exact cache hit):")
  const answer2 = yield* cache.get({
    url: "https://wikipedia.org/wiki/France",
    prompt: "What is the capital of France?"
  })
  console.log(`   Answer: ${answer2.answer}`)
  console.log(`   (No fetch log - served from cache)\n`)

  // Similar question - fuzzy match
  console.log("3. Similar question (fuzzy match):")
  const answer3 = yield* cache.get({
    url: "https://wikipedia.org/wiki/France",
    prompt: "What is the capital city of France?"
  })
  console.log(`   Answer: ${answer3.answer}`)
  console.log(`   (Fuzzy matched to cached entry)\n`)

  // Get all matching entries with scores
  console.log("4. Get all matches with scores:")
  const allMatches = yield* cache.getAll({
    url: "https://wikipedia.org/wiki/France",
    prompt: "What is the capital city of France?"
  })
  console.log(`   Found ${allMatches.length} matches:`)
  allMatches.forEach((match, i) => {
    console.log(`   ${i + 1}. Score: ${match.score.toFixed(2)} - "${match.params.prompt}"`)
  })
  console.log()

  // Different URL - cache miss (URL is exact match)
  console.log("5. Different URL (cache miss):")
  const answer4 = yield* cache.get({
    url: "https://wikipedia.org/wiki/Germany",
    prompt: "What is the capital of France?"
  })
  console.log(`   Answer: ${answer4.answer}\n`)

  // Cache stats
  console.log("6. Cache statistics:")
  const stats = yield* cache.cacheStats
  console.log(`   Hits: ${stats.hits}`)
  console.log(`   Misses: ${stats.misses}`)
  console.log(`   Size: ${stats.size}\n`)

  console.log("=== Example Complete ===\n")
})

Effect.runPromise(program)
