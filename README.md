# FuzzyCache

A high-performance fuzzy cache for Effect that extends Effect's Cache with approximate parameter matching and intelligent request deduplication.

## Features

- **Effect Cache Subtyping** - Drop-in replacement for Effect's Cache interface
- **Fuzzy Parameter Matching** - Score-based approximate matching with configurable thresholds
- **In-Flight Request Deduplication** - Automatically shares lookups across concurrent requests
- **Order-Agnostic Hashing** - Uses Effect's `Hash.structure()` for reliable parameter comparison
- **Two-Level Capacity Management** - Separate bucket and entry-level limits with expiration-based eviction
- **TTL-Based Expiration** - Automatic time-to-live management with per-exit customization
- **Granular Statistics** - Separate exact (bucket-level) and fuzzy (entry-level) stats tracking

## Installation

```bash
npm install @effect/platform effect
```

## Quick Start

```typescript
import * as FuzzyCache from "./FuzzyCache"
import * as Matchers from "./Matchers"
import { Effect, Duration } from "effect"

interface SearchParams {
  readonly userId: string
  readonly query: string
  readonly maxResults: number
}

const cache = FuzzyCache.make({
  lookup: (params: SearchParams) =>
    Effect.succeed(`Results for ${params.query}`),
  config: {
    userId: Matchers.Exact(),           // Exact match - defines buckets
    query: Matchers.levenshtein(0.3),   // Fuzzy match - 30% difference allowed
    maxResults: Matchers.numeric(5)     // Numeric match - within 5 units
  },
  capacity: { bucket: 100, list: 10 },  // 100 buckets, 10 entries per bucket
  timeToLive: Duration.minutes(5)
})

const program = Effect.gen(function* () {
  const fuzzyCache = yield* cache

  // First call invokes lookup
  const value1 = yield* fuzzyCache.get({
    userId: "user123",
    query: "hello world",
    maxResults: 10
  })

  // Similar query returns cached result (fuzzy match)
  const value2 = yield* fuzzyCache.get({
    userId: "user123",
    query: "hello earth",  // Similar to "hello world"
    maxResults: 12         // Within numeric tolerance of 10
  })

  // Get all matches above threshold
  const allMatches = yield* fuzzyCache.getAll(
    { userId: "user123", query: "hello", maxResults: 10 },
    0.7  // Minimum score threshold
  )

  allMatches.forEach(match => {
    console.log(`Score: ${match.score}, Value: ${match.value}`)
  })
})
```

## Core Concepts

### Bucket-Based Architecture

FuzzyCache organizes entries into buckets based on exact-match parameters:

1. **Exact Parameters**: Define bucket boundaries (must match exactly)
2. **Fuzzy Parameters**: Enable approximate matching within buckets
3. **Scored Results**: Each match receives a similarity score (0.0 to 1.0)

```typescript
const cache = yield* FuzzyCache.make({
  lookup: (params: { url: string; prompt: string }) =>
    Effect.succeed(`Answer for ${params.prompt}`),
  config: {
    url: Matchers.Exact(),           // Different URLs = different buckets
    prompt: Matchers.levenshtein(0.3) // Similar prompts share results
  },
  capacity: { bucket: 50, list: 5 },
  timeToLive: Duration.minutes(10)
})

// These go to different buckets (different URL)
yield* cache.get({ url: "docs.com", prompt: "what is Effect?" })
yield* cache.get({ url: "blog.com", prompt: "what is Effect?" })

// These share a bucket (same URL, fuzzy prompt matching)
yield* cache.get({ url: "docs.com", prompt: "what is Effect?" })
yield* cache.get({ url: "docs.com", prompt: "what is effect?" }) // May return cached result
```

### Fuzzy Matching

FuzzyCache scores entries based on parameter similarity:

```typescript
const cache = yield* FuzzyCache.make({
  lookup: (params: { text: string }) =>
    Effect.succeed(`Result for ${params.text}`),
  config: {
    text: Matchers.levenshtein(0.5) // Allow up to 50% difference
  },
  capacity: { bucket: 100, list: 10 },
  timeToLive: Duration.minutes(5),
  minScore: 0.7 // Global minimum score threshold
})

// Cache a value
yield* cache.set({ text: "hello" }, "greeting")

// Get all matches with scores
const results = yield* cache.getAll({ text: "hallo" })
// [{ value: "greeting", score: 0.8, params: { text: "hello" } }]

// Get best match only
const best = yield* cache.get({ text: "hallo" })
// Returns "greeting" if score >= 0.7
```

### In-Flight Request Deduplication

FuzzyCache automatically deduplicates concurrent requests for the same parameters:

```typescript
const cache = yield* FuzzyCache.make({
  lookup: (params: { key: string }) =>
    Effect.sync(() => {
      console.log("Lookup called!")
      return `value-${params.key}`
    }),
  config: { key: Matchers.Exact() },
  capacity: { bucket: 100, list: 10 },
  timeToLive: Duration.minutes(5)
})

// Launch 5 concurrent requests
const results = yield* Effect.all([
  cache.get({ key: "test" }),
  cache.get({ key: "test" }),
  cache.get({ key: "test" }),
  cache.get({ key: "test" }),
  cache.get({ key: "test" })
], { concurrency: "unbounded" })

// Output: "Lookup called!" (only once)
// All 5 requests share the same lookup
```

### Hash.structure for Parameter Hashing

FuzzyCache uses Effect's `Hash.structure()` for order-agnostic, deep parameter comparison:

```typescript
import * as Option from "effect/Option"

const cache = yield* FuzzyCache.make({
  lookup: (params: { userId: string; tags: Option.Option<Array<string>> }) =>
    Effect.succeed(`Result for ${params.userId}`),
  config: {
    userId: Matchers.Exact(),
    tags: Matchers.Exact()
  },
  capacity: { bucket: 100, list: 10 },
  timeToLive: Duration.minutes(5)
})

// These are considered identical due to Hash.structure
yield* cache.get({ userId: "A", tags: Option.some(["x", "y"]) })
yield* cache.get({ userId: "A", tags: Option.some(["x", "y"]) }) // Cache hit

// Hash.structure handles Effect types correctly
yield* cache.get({ userId: "A", tags: Option.none() })
yield* cache.get({ userId: "A", tags: Option.none() }) // Cache hit
```

## API Reference

### FuzzyCache.make

Creates a new FuzzyCache with fixed time-to-live.

```typescript
FuzzyCache.make<Params, Value, Error, R>(options: {
  readonly lookup: (params: Params) => Effect.Effect<Value, Error, R>
  readonly config: FuzzyConfig<Params>
  readonly capacity: { readonly bucket: number; readonly list: number }
  readonly timeToLive: Duration.DurationInput
  readonly minScore?: number
}): Effect.Effect<FuzzyCache<Params, Value, Error>, never, R>
```

**Parameters:**
- `lookup` - Function to compute values for cache misses
- `config` - Matcher configuration for each parameter
- `capacity.bucket` - Maximum number of buckets
- `capacity.list` - Maximum entries per bucket
- `timeToLive` - Time-to-live for cached entries
- `minScore` - Global minimum score threshold (default: 0.0)

### FuzzyCache.makeWith

Creates a new FuzzyCache with dynamic time-to-live based on lookup result.

```typescript
FuzzyCache.makeWith<Params, Value, Error, R>(options: {
  readonly lookup: (params: Params) => Effect.Effect<Value, Error, R>
  readonly config: FuzzyConfig<Params>
  readonly capacity: { readonly bucket: number; readonly list: number }
  readonly timeToLive: (exit: Exit.Exit<Value, Error>) => Duration.DurationInput
  readonly minScore?: number
}): Effect.Effect<FuzzyCache<Params, Value, Error>, never, R>
```

**Example:**

```typescript
const cache = FuzzyCache.makeWith({
  lookup: (params: { key: string }) =>
    Effect.succeed(`value-${params.key}`),
  config: { key: Matchers.Exact() },
  capacity: { bucket: 100, list: 10 },
  timeToLive: (exit) =>
    Exit.isSuccess(exit)
      ? Duration.minutes(10)  // Cache successes for 10 minutes
      : Duration.seconds(30)  // Cache failures for 30 seconds
})
```

### Methods

#### get

Retrieves the best-matching cached value or computes a new one.

```typescript
get(params: Params): Effect.Effect<Value, Error>
```

Returns the value with the highest fuzzy match score above `minScore`.

#### getEither

Returns `Either.Left` for cached values, `Either.Right` for newly computed values.

```typescript
getEither(params: Params): Effect.Effect<Either.Either<Value, Value>, Error>
```

**Example:**

```typescript
const result = yield* cache.getEither({ key: "test" })

if (Either.isLeft(result)) {
  console.log("From cache:", result.left)
} else {
  console.log("Newly computed:", result.right)
}
```

#### getOption

Returns cached value as `Option` without triggering lookup.

```typescript
getOption(params: Params): Effect.Effect<Option.Option<Value>, Error>
```

Waits for in-flight lookups but doesn't start new ones.

#### getOptionComplete

Returns cached value only if lookup is complete (doesn't wait for in-flight).

```typescript
getOptionComplete(params: Params): Effect.Effect<Option.Option<Value>>
```

#### getAll

Returns all matches above threshold, sorted by score (highest first).

```typescript
getAll(
  params: Params,
  threshold?: number
): Effect.Effect<Array<ScoredResult<Value>>, Error>
```

**Example:**

```typescript
const matches = yield* cache.getAll({ query: "hello" }, 0.8)

matches.forEach(match => {
  console.log(`Score: ${match.score}`)
  console.log(`Value: ${match.value}`)
  console.log(`Original params:`, match.params)
})
```

#### refresh

Forces recomputation without invalidating existing cache.

```typescript
refresh(params: Params): Effect.Effect<void, Error>
```

#### set

Manually adds or updates a cache entry.

```typescript
set(params: Params, value: Value): Effect.Effect<void>
```

#### invalidate

Removes the best-matching entry from cache.

```typescript
invalidate(params: Params): Effect.Effect<void>
```

#### invalidateWhen

Conditionally removes entry based on predicate.

```typescript
invalidateWhen(
  params: Params,
  predicate: Predicate.Predicate<Value>
): Effect.Effect<void>
```

#### invalidateAll

Clears all cache entries.

```typescript
readonly invalidateAll: Effect.Effect<void>
```

#### Statistics

FuzzyCache provides separate statistics for bucket and entry operations:

```typescript
// Bucket-level stats (when buckets are accessed/created)
readonly exactStats: Effect.Effect<Cache.CacheStats>

// Entry-level stats (when fuzzy matches succeed/fail)
readonly fuzzyStats: Effect.Effect<Cache.CacheStats>

// Backwards compatible (alias for fuzzyStats)
readonly cacheStats: Effect.Effect<Cache.CacheStats>
```

**Example:**

```typescript
const exactStats = yield* cache.exactStats
console.log(`Bucket hits: ${exactStats.hits}`)
console.log(`Bucket misses: ${exactStats.misses}`)

const fuzzyStats = yield* cache.fuzzyStats
console.log(`Entry hits: ${fuzzyStats.hits}`)
console.log(`Entry misses: ${fuzzyStats.misses}`)
console.log(`Total entries: ${fuzzyStats.size}`)
```

#### Other Methods

```typescript
contains(params: Params): Effect.Effect<boolean>
entryStats(params: Params): Effect.Effect<Option.Option<Cache.EntryStats>>
readonly size: Effect.Effect<number>
readonly keys: Effect.Effect<Array<Params>>
readonly values: Effect.Effect<Array<Value>>
readonly entries: Effect.Effect<Array<[Params, Value]>>
```

## Matchers

### Exact

Requires exact parameter match (defines bucket boundaries).

```typescript
Matchers.Exact()
```

### levenshtein

Fuzzy string matching using edit distance.

```typescript
Matchers.levenshtein(threshold: number)
```

**Parameters:**
- `threshold` - Maximum normalized distance (0.0 to 1.0)

**Score Calculation:**
- Edit distance / max(length) = normalized distance
- Score = 1.0 - normalized distance
- Returns 0.0 if beyond threshold

**Example:**

```typescript
const matcher = Matchers.levenshtein(0.3)

// "hello" vs "hallo": distance 1, length 5, normalized 0.2, score 0.8
// "hello" vs "world": distance 4, length 5, normalized 0.8, score 0.2
// "hello" vs "xyz": distance 5, length 5, normalized 1.0, score 0.0
```

### numeric

Fuzzy numeric matching with tolerance.

```typescript
Matchers.numeric(tolerance: number)
```

**Parameters:**
- `tolerance` - Maximum difference for perfect match

**Score Calculation:**
- Within tolerance: score = 1.0
- Beyond tolerance: score = 1.0 - (excess / tolerance)
- At 2x tolerance: score = 0.0

**Example:**

```typescript
const matcher = Matchers.numeric(10)

// Query: 100
// Cached: 105 -> diff 5, score 1.0 (within tolerance)
// Cached: 115 -> diff 15, score 0.5 (excess 5, score 1.0 - 5/10)
// Cached: 120 -> diff 20, score 0.0 (at 2x tolerance)
```

### Custom Matchers

Create custom fuzzy matchers with the `Fuzzy` constructor:

```typescript
import * as Matchers from "./Matchers"

const customMatcher = Matchers.Fuzzy<Date>((cached, query) => {
  const diff = Math.abs(cached.getTime() - query.getTime())
  const hourInMs = 3600000

  if (diff <= hourInMs) return 1.0
  if (diff >= hourInMs * 24) return 0.0

  return 1.0 - (diff - hourInMs) / (hourInMs * 23)
})
```

## Advanced Usage

### Custom Hashable Types

FuzzyCache works with any hashable Effect types:

```typescript
import * as Option from "effect/Option"
import * as Either from "effect/Either"
import * as Array from "effect/Array"

interface ComplexParams {
  readonly userId: string
  readonly tags: Option.Option<Array<string>>
  readonly result: Either.Either<string, number>
}

const cache = yield* FuzzyCache.make({
  lookup: (params: ComplexParams) =>
    Effect.succeed(`Result for ${params.userId}`),
  config: {
    userId: Matchers.Exact(),
    tags: Matchers.Exact(),
    result: Matchers.Exact()
  },
  capacity: { bucket: 100, list: 10 },
  timeToLive: Duration.minutes(5)
})

// Hash.structure handles Effect types correctly
yield* cache.get({
  userId: "user123",
  tags: Option.some(["a", "b"]),
  result: Either.right(42)
})
```

### Capacity Management

FuzzyCache uses two-level capacity with expiration-based eviction:

```typescript
const cache = yield* FuzzyCache.make({
  lookup: (params: { userId: string; query: string }) =>
    Effect.succeed(`result-${params.query}`),
  config: {
    userId: Matchers.Exact(),  // Defines buckets
    query: Matchers.Exact()
  },
  capacity: {
    bucket: 100,  // Max 100 buckets
    list: 10      // Max 10 entries per bucket
  },
  timeToLive: Duration.minutes(5)
})
```

**Eviction Strategy:**
1. When a bucket exceeds `list` capacity, the entry with the earliest expiration time is evicted
2. When total buckets exceed `bucket` capacity, Effect's underlying Cache handles bucket eviction
3. Expired entries are filtered out during `getAll` operations

**Example with Staggered TTLs:**

```typescript
const cache = yield* FuzzyCache.makeWith({
  lookup: (params: { bucket: string; key: string }) =>
    Effect.succeed(`value-${params.key}`),
  config: {
    bucket: Matchers.Exact(),
    key: Matchers.Exact()
  },
  capacity: { bucket: 5, list: 3 },
  timeToLive: (exit) => {
    if (Exit.isSuccess(exit)) {
      const value = exit.value
      // Assign different TTLs based on value
      if (value.includes("important")) return Duration.hours(1)
      if (value.includes("normal")) return Duration.minutes(30)
      return Duration.minutes(5)
    }
    return Duration.seconds(30)
  }
})

// When capacity is exceeded, entries with shortest remaining TTL are evicted first
```

### Effect Cache Compatibility

FuzzyCache is a full subtype of Effect's Cache:

```typescript
import * as Cache from "effect/Cache"

// Generic function accepting any Cache
const getCached = <K, V, E>(
  cache: Cache.Cache<K, V, E>,
  key: K
): Effect.Effect<V, E> => cache.get(key)

const fuzzyCache = yield* FuzzyCache.make({
  lookup: (params: { key: string }) => Effect.succeed(`value-${params.key}`),
  config: { key: Matchers.Exact() },
  capacity: { bucket: 100, list: 10 },
  timeToLive: Duration.minutes(5)
})

// Works seamlessly
const value = yield* getCached(fuzzyCache, { key: "test" })
```

## Performance

- **O(1) Parameter Hashing**: Uses Effect's `Hash.structure()` for constant-time lookups
- **In-Flight Deduplication**: Concurrent requests for identical parameters share single lookup
- **Expiration-Based Eviction**: Efficient memory management by evicting soon-to-expire entries first
- **Bucket Organization**: Exact parameters create isolated buckets for efficient fuzzy matching

## Examples

### API Response Caching with Fuzzy Matching

```typescript
interface APIParams {
  readonly endpoint: string
  readonly query: string
  readonly limit: number
}

const apiCache = yield* FuzzyCache.make({
  lookup: (params: APIParams) =>
    Effect.tryPromise(() =>
      fetch(`${params.endpoint}?q=${params.query}&limit=${params.limit}`)
        .then(r => r.json())
    ),
  config: {
    endpoint: Matchers.Exact(),          // Different endpoints = different buckets
    query: Matchers.levenshtein(0.2),    // Similar queries share results
    limit: Matchers.numeric(5)           // Nearby limits share results
  },
  capacity: { bucket: 50, list: 10 },
  timeToLive: Duration.minutes(5)
})

// First call hits API
const results1 = yield* apiCache.get({
  endpoint: "/api/search",
  query: "effect typescript",
  limit: 20
})

// Similar query may return cached results
const results2 = yield* apiCache.get({
  endpoint: "/api/search",
  query: "effect typescrpt", // Typo, but similar enough
  limit: 22                   // Close to 20
})
```

### User Session Caching

```typescript
import * as Option from "effect/Option"

interface SessionParams {
  readonly userId: string
  readonly roles: Array<string>
  readonly permissions: Option.Option<Array<string>>
}

const sessionCache = yield* FuzzyCache.make({
  lookup: (params: SessionParams) =>
    Effect.gen(function* () {
      const user = yield* UserService.loadUser(params.userId)
      return createSession(user, params.roles)
    }),
  config: {
    userId: Matchers.Exact(),
    roles: Matchers.Exact(),
    permissions: Matchers.Exact()
  },
  capacity: { bucket: 1000, list: 5 },
  timeToLive: Duration.hours(1)
})
```

### Rate-Limited API with Smart Caching

```typescript
const rateLimitedCache = yield* FuzzyCache.makeWith({
  lookup: (params: { endpoint: string; query: string }) =>
    Effect.gen(function* () {
      // Implement rate limiting
      yield* RateLimiter.acquire

      return yield* Effect.tryPromise(() =>
        fetch(`${params.endpoint}?q=${params.query}`).then(r => r.json())
      )
    }),
  config: {
    endpoint: Matchers.Exact(),
    query: Matchers.levenshtein(0.3)
  },
  capacity: { bucket: 20, list: 10 },
  timeToLive: (exit) =>
    Exit.isSuccess(exit)
      ? Duration.minutes(10)  // Cache successes longer
      : Duration.seconds(30)  // Retry failures sooner
})
```

## License

MIT
