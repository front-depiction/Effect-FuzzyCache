# FuzzyCache: Bucketing System Implementation Plan

## Phase 1: Implement Bucketing System

Start small, build foundation for fuzzy matching later.

## 1. Core Data Structures (src/FuzzyConfig.ts)

```typescript
// Cache entry - what gets stored
type CacheEntry<A> = {
  params: Record<string, unknown>    // Original params
  value: A                           // Cached result
  timestamp: number                  // For TTL
  lastAccessTime: number             // For LRU
  hitCount: number                   // Statistics
}

// Storage with index
type CacheStorage = {
  entries: Map<string, CacheEntry<unknown>>  // entryId -> entry
  index: Map<string, Set<string>>            // bucketKey -> Set<entryId>
  reverseIndex: Map<string, string>          // entryId -> bucketKey
}
```

## 2. Bucketing Logic

**Key function**: Partition params into exact vs fuzzy
```typescript
function partitionParams<Params>(
  params: Params,
  config: { params: { [P in keyof Params]: InputConfig } }
): {
  exactParams: Partial<Params>
  fuzzyParams: Partial<Params>
} {
  const exact = {}
  const fuzzy = {}

  for (const [key, value] of Object.entries(params)) {
    if (config.params[key]._tag === "ExactMatch") {
      exact[key] = value
    } else {
      fuzzy[key] = value
    }
  }

  return { exactParams: exact, fuzzyParams: fuzzy }
}
```

**Bucket key**: Serialize exact params only
```typescript
function makeBucketKey(exactParams: Record<string, unknown>): string {
  // Sort keys for determinism
  const sorted = Object.keys(exactParams).sort()
  return sorted
    .map(key => `${key}:${JSON.stringify(exactParams[key])}`)
    .join("|")
}
```

## 3. Storage Operations

**Set (store entry)**:
```typescript
function set<A, Params>(
  storage: CacheStorage,
  params: Params,
  value: A,
  config: FuzzyCacheConfig<Params>
): void {
  const entryId = generateId()
  const { exactParams } = partitionParams(params, config)
  const bucketKey = makeBucketKey(exactParams)

  // Create entry
  const entry: CacheEntry<A> = {
    params,
    value,
    timestamp: Date.now(),
    lastAccessTime: Date.now(),
    hitCount: 0
  }

  // Store entry
  storage.entries.set(entryId, entry)

  // Add to bucket
  if (!storage.index.has(bucketKey)) {
    storage.index.set(bucketKey, new Set())
  }
  storage.index.get(bucketKey)!.add(entryId)

  // Track reverse mapping
  storage.reverseIndex.set(entryId, bucketKey)
}
```

**Get (retrieve bucket)**:
```typescript
function getBucket<Params>(
  storage: CacheStorage,
  params: Params,
  config: FuzzyCacheConfig<Params>
): Array<CacheEntry<unknown>> {
  const { exactParams } = partitionParams(params, config)
  const bucketKey = makeBucketKey(exactParams)

  // Get entry IDs in this bucket
  const entryIds = storage.index.get(bucketKey) ?? new Set()

  // Retrieve actual entries
  return Array.from(entryIds)
    .map(id => storage.entries.get(id)!)
    .filter(entry => entry !== undefined)
}
```

## 4. FuzzyCache Service (minimal)

```typescript
class FuzzyCache extends Context.Tag("@effect/FuzzyCache")<
  FuzzyCache,
  {
    readonly getBucket: <A, Params>(
      params: Params,
      config: FuzzyCacheConfig<Params>
    ) => Effect.Effect<Array<CacheEntry<A>>, never>

    readonly set: <A, Params>(
      params: Params,
      value: A,
      config: FuzzyCacheConfig<Params>
    ) => Effect.Effect<void, never>

    readonly size: Effect.Effect<number, never>
    readonly invalidateAll: Effect.Effect<void, never>
  }
>() {
  static Live = Layer.sync(this, () => {
    // Closure-based storage
    const storage: CacheStorage = {
      entries: new Map(),
      index: new Map(),
      reverseIndex: new Map()
    }

    return {
      getBucket: (params, config) =>
        Effect.sync(() => getBucket(storage, params, config)),

      set: (params, value, config) =>
        Effect.sync(() => set(storage, params, value, config)),

      size: Effect.sync(() => storage.entries.size),

      invalidateAll: Effect.sync(() => {
        storage.entries.clear()
        storage.index.clear()
        storage.reverseIndex.clear()
      })
    }
  })
}
```

## 5. Placeholder for Scoring

**Leave hook for scoring function**:
```typescript
// FUTURE: Score an entry against query params
type ScoreFn<Params> = (
  entry: CacheEntry<unknown>,
  queryParams: Params,
  config: FuzzyCacheConfig<Params>
) => number  // Returns 0.0 to 1.0

// For now: exact match only (score 1.0 if in bucket, 0.0 otherwise)
function scoreEntry<Params>(
  entry: CacheEntry<unknown>,
  queryParams: Params,
  config: FuzzyCacheConfig<Params>
): number {
  // TODO: Implement fuzzy scoring for non-exact params
  // For now: if we're in the bucket, all exact params match
  // Return 1.0 if fuzzy params also match exactly, else 0.0

  const { fuzzyParams } = partitionParams(queryParams, config)

  // Check if fuzzy params are exact matches too
  for (const key of Object.keys(fuzzyParams)) {
    if (entry.params[key] !== queryParams[key]) {
      return 0.0  // Not an exact match
    }
  }

  return 1.0  // Perfect match
}
```

## 6. Implement with_ function

```typescript
export const with_ = <Params extends Record<string, unknown>, A, E, R>(
  fn: (params: Params) => Effect.Effect<A, E, R>,
  config: {
    params: { [P in keyof Params]: InputConfig }
    ttlMs: number
  }
): (params: Params) => Effect.Effect<A, E | FuzzyCacheErrors, R | FuzzyCache> => {

  return (params: Params) =>
    Effect.gen(function* () {
      const cache = yield* FuzzyCache

      // Get bucket of candidates
      const bucket = yield* cache.getBucket<A, Params>(params, config)

      // Score each candidate (placeholder: exact match only for now)
      const scored = bucket.map(entry => ({
        entry,
        score: scoreEntry(entry, params, config)
      }))

      // Find best match
      const bestMatch = scored
        .filter(s => s.score === 1.0)  // Only perfect matches for now
        .sort((a, b) => b.score - a.score)[0]

      if (bestMatch) {
        // Cache hit!
        return bestMatch.entry.value as A
      }

      // Cache miss - execute original function
      const result = yield* fn(params)

      // Store result
      yield* cache.set(params, result, config)

      return result
    })
}
```

## 7. What This Achieves

✅ **Bucketing system** - entries partitioned by exact-match params
✅ **O(K) lookup** - only scan entries in the same bucket
✅ **Storage structure** - entries, index, reverse index
✅ **Clean separation** - bucketing logic separate from scoring
✅ **Placeholder scoring** - easy to extend later
✅ **Working with exact match** - fully functional for all-exact configs

## 8. What's Left for Later

⏳ Fuzzy scoring (Levenshtein, cosine similarity, MoreIsBetter)
⏳ TTL expiration checking
⏳ LRU capacity management
⏳ EmbeddingService integration
⏳ withMany function (return array of matches)

## 9. Implementation Steps

1. Add types (CacheEntry, CacheStorage) to FuzzyConfig.ts
2. Implement helper functions (partitionParams, makeBucketKey, generateId)
3. Implement storage operations (set, getBucket)
4. Create FuzzyCache service with Layer.sync
5. Implement with_ function using getBucket + placeholder scoring
6. Write simple test: exact match caching works

This gives us the architecture without complexity - ready to add scoring logic later.
