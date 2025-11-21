# In-Flight Request Tracking Analysis for FuzzyCache

## Problem Confirmed

The tests demonstrate that FuzzyCache **does not properly deduplicate concurrent requests**, unlike Effect's Cache.

### Test Results

**Effect Cache (Correct Behavior):**
- 5 concurrent `get()` calls for same key
- Lookup function called: **1 time**
- All requests share the same in-flight computation

**FuzzyCache (Current Buggy Behavior):**
- 5 concurrent `get()` calls for same params
- Lookup function called: **5 times**
- Each request triggers its own lookup (no deduplication)

**getOption Behavior:**
- Effect Cache: `getOption()` during lookup returns `Some` (waits for pending)
- FuzzyCache: `getOption()` during lookup returns `None` (doesn't track pending)

## Root Cause Analysis

### How Effect's Cache Works

From `.context/effect/packages/effect/src/internal/cache.ts`:

```typescript
type MapValue<Key, Value, Error> =
  | Complete<Key, Value, Error>    // Lookup finished
  | Pending<Key, Value, Error>     // Lookup in progress
  | Refreshing<Key, Value, Error>  // Recomputing with old value available

interface Pending<Key, Value, Error> {
  _tag: "Pending"
  key: MapKey<Key>
  deferred: Deferred.Deferred<Value, Error>  // Shared promise
}
```

**Key mechanism in `getEither` (lines 394-423):**

1. Check if key exists in map
2. If not, create a Deferred and set `Pending` state
3. If found `Pending`, await the same Deferred
4. Multiple concurrent calls share the same Deferred

```typescript
let deferred: Deferred.Deferred<Value, Error> | undefined = undefined
let value = Option.getOrUndefined(MutableHashMap.get(this.cacheState.map, k))

if (value === undefined) {
  deferred = Deferred.unsafeMake<Value, Error>(this.fiberId)
  // ... atomically check and set Pending state
  MutableHashMap.set(this.cacheState.map, k, pending(mapKey, deferred))
}
```

### What FuzzyCache Currently Does

From `src/FuzzyCache.ts` lines 400-426:

```typescript
get: (params: Params): Effect.Effect<Value, Error> =>
  Effect.gen(function* () {
    const { exact } = partitionParams(params, options.config)
    const bucketKey = createBucketKey(exact)
    const bucket = yield* bucketCache.get(bucketKey)  // (1)
    const now = yield* Clock.currentTimeMillis

    // Try to find existing match
    const existing = findBestMatch(bucket, params, now)  // (2)
    if (Option.isSome(existing)) {
      return existing.value.value
    }

    // No match found, call lookup  // (3)
    const value: Value = yield* Effect.provide(options.lookup(params), context)
    // ... store entry
    return value
  })
```

**The problem:**

1. `bucketCache.get(bucketKey)` - The bucket-level cache DOES deduplicate (Effect's Cache)
2. `findBestMatch(bucket, params, now)` - Searches completed entries only
3. If no completed match found, **directly calls lookup** without checking if another fiber is already looking up the same params

**Two levels of caching:**
- **Bucket level** (handled by Effect's Cache): Deduplicates bucket creation ✓
- **Entry level** (our responsibility): No deduplication for same params ✗

## The Issue in Detail

### Scenario: 5 concurrent calls with `{ userId: "A", query: "test" }`

1. All 5 fibers execute `bucketCache.get(bucketKey)` concurrently
2. Effect's Cache deduplicates: only 1 bucket lookup occurs
3. All 5 fibers get the same (empty) bucket array
4. All 5 fibers call `findBestMatch` → no matches (bucket empty)
5. **All 5 fibers call `lookup(params)` independently** ← THE BUG
6. All 5 lookups complete and push entries to the same bucket
7. Result: 5 redundant lookups, 5 duplicate entries in bucket

### Why Effect's Cache doesn't have this problem

Effect's Cache has only ONE level of keys. The MapValue itself tracks Pending state:

```typescript
// Single key → Single MapValue (Pending/Complete/Refreshing)
map.get(key) → MapValue (with Deferred if Pending)
```

### Why FuzzyCache needs additional tracking

FuzzyCache has TWO levels:

```typescript
// Bucket key → Array of entries
bucketCache.get(bucketKey) → Array<CacheEntry>

// Entry-level matching (fuzzy)
findBestMatch(array, params) → best entry or None
```

The `bucketCache` only deduplicates bucket-level access, not entry-level access within the bucket.

## Solution: Entry-Level Deferred Tracking

We need to track in-flight lookups **per params** (not just per bucket).

### Approach 1: Separate Map for Pending Lookups

Add a `MutableHashMap<string, Deferred>` to track in-flight lookups:

```typescript
const pendingLookups: MutableHashMap<string, Deferred.Deferred<Value, Error>> =
  MutableHashMap.empty()

get: (params: Params) =>
  Effect.gen(function* () {
    const bucket = yield* bucketCache.get(bucketKey)
    const existing = findBestMatch(bucket, params, now)
    if (Option.isSome(existing)) {
      return existing.value.value
    }

    // Check if lookup already in-flight
    const paramsKey = JSON.stringify(params) // or use Hash.hash
    const pending = MutableHashMap.get(pendingLookups, paramsKey)

    if (Option.isSome(pending)) {
      // Wait for existing lookup
      return yield* Deferred.await(pending.value)
    }

    // Start new lookup
    const deferred = yield* Deferred.make<Value, Error>()
    MutableHashMap.set(pendingLookups, paramsKey, deferred)

    const value = yield* lookup(params)

    // Store in bucket and resolve deferred
    MutableHashMap.remove(pendingLookups, paramsKey)
    yield* Deferred.succeed(deferred, value)

    return value
  })
```

### Approach 2: Store Pending State in Bucket

Store pending lookups directly in the bucket array:

```typescript
type BucketEntry<Value> =
  | { _tag: "Complete"; entry: CacheEntry<Value> }
  | { _tag: "Pending"; params: Params; deferred: Deferred<Value> }

// Then in get():
const bucket: Array<BucketEntry<Value>> = yield* bucketCache.get(bucketKey)

// Check for pending or complete
const existing = findBestOrPending(bucket, params)
if (existing._tag === "Complete") return existing.entry.value
if (existing._tag === "Pending") return yield* Deferred.await(existing.deferred)

// Start new lookup
const deferred = yield* Deferred.make()
bucket.push({ _tag: "Pending", params, deferred })
// ... perform lookup, replace Pending with Complete
```

## Recommended Solution

**Use Approach 1** (separate Map) for these reasons:

1. **Cleaner separation**: Pending state separate from completed entries
2. **Simpler cleanup**: Remove from map when done (no array manipulation)
3. **Better performance**: Hash map lookup O(1) vs array scan O(n)
4. **Less mutation**: Don't need to find/replace Pending entries in array
5. **Matches Effect's pattern**: Effect uses map, not array, for state tracking

## Implementation Requirements

### Changes Needed

1. **Add pending lookups tracker**:
   ```typescript
   const pendingLookups = MutableHashMap.empty<string, Deferred.Deferred<Value, Error>>()
   ```

2. **Update `get()` method**:
   - Before calling lookup, check pendingLookups
   - If pending, await the Deferred
   - If not, create Deferred, add to map, perform lookup
   - After lookup completes, remove from map and resolve Deferred

3. **Update `getOption()` method**:
   - Check both pendingLookups and completed entries
   - If pending, return `Some(await deferred)` (not None)
   - This matches Effect's behavior

4. **Update `getOptionComplete()` method**:
   - Check pendingLookups
   - If pending, return `None` (not complete yet)
   - Only return `Some` for completed entries

5. **Update `getEither()` method**:
   - Similar logic to `get()`
   - Return `Left` if from cache (pending or complete)
   - Return `Right` if newly computed

6. **Handle errors**:
   - If lookup fails, remove from pendingLookups
   - Fail the Deferred with the error
   - Don't cache the Deferred in error case

### Key Considerations

1. **Params serialization**: Need consistent way to create map key from params
   - Use `Hash.hash(params)` from Effect
   - Or `JSON.stringify(params)` with sorted keys

2. **Cleanup**: Always remove from pendingLookups when done
   - Use `Effect.ensuring` for cleanup
   - Handle interruption case

3. **Race conditions**: Check map atomically
   - Between check and set, another fiber might insert
   - Re-check after setting (Effect's pattern)

4. **Error handling**: Don't leave orphaned Deferreds
   - If lookup fails, remove from map
   - Fail the Deferred so waiting fibers get the error

## Expected Behavior After Fix

### Concurrent Access Test
```
Effect Cache - Lookup count: 1 ✓
FuzzyCache - Lookup count: 1 ✓ (was 5)
```

### getOption During Lookup Test
```
Effect Cache getOption: Some ✓
FuzzyCache getOption: Some ✓ (was None)
```

### getOptionComplete During Lookup Test
```
Effect Cache getOptionComplete: None ✓
FuzzyCache getOptionComplete: None ✓ (already correct)
```

## Impact on Existing Tests

All 57 existing tests should pass because:
- We're only adding deduplication, not changing semantics
- Sequential calls already worked correctly
- We're maintaining the same return values
- Stats tracking remains unchanged

The fix is purely about **efficiency** (fewer lookups) and **correctness** (proper Pending state).
