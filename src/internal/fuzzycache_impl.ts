import * as Cache from "effect/Cache"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Duration from "effect/Duration"
import * as Option from "effect/Option"
import * as Either from "effect/Either"
import * as Equal from "effect/Equal"
import * as Exit from "effect/Exit"
import * as Order from "effect/Order"
import * as Deferred from "effect/Deferred"
import * as Hash from "effect/Hash"
import * as Array from "effect/Array"
import * as Data from "effect/Data"
import * as Context from "effect/Context"
import { pipe } from "effect/Function"
import {
  type BucketKey,
  type FuzzyConfig,
  partitionParams,
  createBucketKey,
  scoreEntry,
  hasExpired,
  hasNotExpired
} from "./fuzzycache.js"
import * as Predicate from "effect/Predicate"

const EntryValueTypeId: unique symbol = Symbol.for("fuzzycache/entryValue")
type EntryValueTypeId = typeof EntryValueTypeId

export interface Complete<out Value> extends Equal.Equal {
  [EntryValueTypeId]: EntryValueTypeId
  readonly _tag: "Complete"
  readonly params: Record<string, unknown>
  readonly value: Value
  readonly timeToLiveMillis: number
  readonly loadedMillis: number
}

export interface Pending<in out Value, in out Error> extends Equal.Equal {
  [EntryValueTypeId]: EntryValueTypeId
  readonly _tag: "Pending"
  readonly params: Record<string, unknown>
  readonly deferred: Deferred.Deferred<Value, Error>
}

export type EntryValue<Value, Error> =
  | Complete<Value>
  | Pending<Value, Error>


export namespace EntryValue {

  const Proto = {
    [EntryValueTypeId]: EntryValueTypeId,
    [Hash.symbol](this: EntryValue<unknown, unknown>) {
      return Hash.cached(this, Hash.structure(this.params))
    },
    [Equal.symbol](this: EntryValue<unknown, unknown>, that: unknown) {
      isEntryValue(that) && this._tag === that._tag && Equal.equals(this, that)
    }
  }
  export const complete = <Value, Error = never>(
    params: Record<string, unknown>,
    value: Value,
    timeToLiveMillis: number,
    loadedMillis: number
  ): EntryValue<Value, Error> =>
    Object.assign({
      _tag: "Complete" as const,
      params,
      value,
      timeToLiveMillis,
      loadedMillis
    }, Proto) as any

  export const pending = <Value, Error>(
    params: Record<string, unknown>,
    deferred: Deferred.Deferred<Value, Error>
  ): EntryValue<Value, Error> => Object.assign(
    {
      _tag: "Pending" as const,
      params,
      deferred
    }, Proto) as any

  export const isEntryValue = (u: unknown): u is EntryValue<unknown, unknown> => Predicate.hasProperty(u, EntryValueTypeId)

  export const isComplete = <Value, Error>(entry: EntryValue<Value, Error>): entry is Complete<Value> =>
    entry._tag === "Complete"

  export const isPending = <Value, Error>(entry: EntryValue<Value, Error>): entry is Pending<Value, Error> =>
    entry._tag === "Pending"
}

interface StatsTracker {
  trackHit: () => void
  trackMiss: () => void
  get: () => { hits: number; misses: number }
}

const createStatsTracker = (): StatsTracker => {
  let hits = 0
  let misses = 0

  return {
    trackHit: () => { hits++ },
    trackMiss: () => { misses++ },
    get: () => ({ hits, misses })
  }
}

const addEntryWithEviction = <Value>(
  bucket: Array<EntryValue<Value, any>>,
  entry: EntryValue<Value, any>,
  capacity: number
): void => {
  if (bucket.length >= capacity) {
    const completeEntries = bucket.filter(EntryValue.isComplete)
    if (Array.isNonEmptyArray(completeEntries)) {
      const toEvict = Array.min(
        completeEntries,
        Order.mapInput(Order.number, (e) => e.timeToLiveMillis)
      )
      bucket.splice(bucket.indexOf(toEvict), 1)
    }
  }
  bucket.push(entry)
}

const findBestMatch = <Params extends Record<string, unknown>, Value>(
  bucket: Array<EntryValue<Value, any>>,
  params: Params,
  config: FuzzyConfig<Params>,
  now: number,
  minScore: number
): Option.Option<{ value: Value; score: number; params: Record<string, unknown> }> =>
  pipe(
    bucket,
    Array.filter(EntryValue.isComplete),
    Array.filter(hasNotExpired(now)),
    Array.map((entry) => ({
      value: entry.value,
      score: scoreEntry(
        entry,
        params,
        config
      ),
      params: entry.params
    })),
    Array.filter((result) => result.score >= minScore),
    Array.sortWith((entry) => entry.score, Order.number),
    Option.fromIterable
  )

const computeTTL = <Value, Error>(
  timeToLive: (exit: Exit.Exit<Value, Error>) => Duration.DurationInput
) => (exit: Exit.Exit<Value, Error>): number =>
    Duration.toMillis(timeToLive(exit))

const getBestMatchFromBucket = <Params extends Record<string, unknown>, Value, Error>(
  bucket: Array<EntryValue<Value, Error>>,
  params: Params,
  config: FuzzyConfig<Params>,
  now: number,
  minScore: number,
  fuzzyStatsTracker: StatsTracker
): Option.Option<Effect.Effect<Value, Error>> => pipe(
  findBestMatch(bucket, params, config, now, minScore),
  Option.map(({ value }) => {
    fuzzyStatsTracker.trackHit()
    return Effect.succeed(value)
  })
)



const lookupAndCache = <Params extends Record<string, unknown>, Value, Error, R>(
  params: Params,
  bucket: Array<EntryValue<Value, Error>>,
  now: number,
  lookup: (params: Params) => Effect.Effect<Value, Error, R>,
  context: Context.Context<R>,
  computeTTLFn: (exit: Exit.Exit<Value, Error>) => number,
  capacity: number,
  fuzzyStatsTracker: StatsTracker
): Effect.Effect<Value, Error> =>
  Effect.gen(function* () {
    const paramsHash = Hash.structure(params)

    const existingPending = bucket.find(
      (e) => EntryValue.isPending(e) && Hash.hash(e) === paramsHash
    )

    if (existingPending && EntryValue.isPending(existingPending)) {
      fuzzyStatsTracker.trackHit()
      return (yield* Deferred.await(existingPending.deferred)) as Value
    }

    fuzzyStatsTracker.trackMiss()

    const deferred = yield* Deferred.make<Value, Error>()
    const pendingEntry = EntryValue.pending<Value, Error>(params, deferred)
    bucket.push(pendingEntry)

    const exit = yield* Effect.exit(Effect.provide(lookup(params), context))

    const index = bucket.indexOf(pendingEntry)
    if (index !== -1) {
      bucket.splice(index, 1)
    }

    if (Exit.isSuccess(exit)) {
      const entry = EntryValue.complete<Value, Error>(
        params,
        exit.value,
        now + computeTTLFn(exit),
        now
      )
      addEntryWithEviction(bucket, entry, capacity)
    }

    yield* Deferred.done(deferred, exit)

    return yield* exit
  })

const getBucketAndMatch = <Params extends Record<string, unknown>, Value, Error>(
  params: Params,
  config: FuzzyConfig<Params>,
  minScore: number,
  getBucket: (key: BucketKey) => Effect.Effect<Option.Option<Array<EntryValue<Value, Error>>>>
): Effect.Effect<Option.Option<{ bucket: Array<EntryValue<Value, Error>>; best: { value: Value; score: number; params: Record<string, unknown> }; now: number }>> =>
  Effect.gen(function* () {
    const { exact } = partitionParams(params, config)
    const bucketKey = createBucketKey(exact)
    const maybeBucket = yield* getBucket(bucketKey)
    const now = yield* Clock.currentTimeMillis
    return Option.Do.pipe(
      Option.bind("bucket", () => maybeBucket),
      Option.bind("best", ({ bucket }) =>
        findBestMatch(bucket, params, config, now, minScore)
      ),
      Option.map(({ bucket, best }) => ({ bucket, best, now }))
    )
  })

const removeEntryByValue = <Value>(bucket: Array<EntryValue<Value, any>>, value: Value): void => {
  const index = bucket.findIndex((entry) =>
    EntryValue.isComplete(entry) && entry.value === value
  )
  if (index !== -1) {
    bucket.splice(index, 1)
  }
}

const computeBucketStats = <Value>(
  buckets: Array<Array<EntryValue<Value, any>>>,
  fuzzyStatsTracker: StatsTracker
): Cache.CacheStats => {
  const totalSize = pipe(
    buckets,
    Array.flatten,
    Array.filter(EntryValue.isComplete),
    (arr) => arr.length
  )
  const { hits, misses } = fuzzyStatsTracker.get()
  return Cache.makeCacheStats({ hits, misses, size: totalSize })
}

export const makeImpl = <Params extends Record<string, unknown>, Value, Error = never, R = never>(
  options: {
    readonly lookup: (params: Params) => Effect.Effect<Value, Error, R>
    readonly config: FuzzyConfig<Params>
    readonly capacity: { readonly bucket: number; readonly list: number }
    readonly timeToLive: (exit: Exit.Exit<Value, Error>) => Duration.DurationInput
    readonly minScore: number
  }
): Effect.Effect<any, never, R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    const fuzzyStatsTracker = createStatsTracker()

    const bucketCache = yield* Cache.make<BucketKey, Array<EntryValue<Value, Error>>>({
      capacity: options.capacity.bucket,
      timeToLive: Duration.infinity,
      lookup: () => Effect.succeed([])
    })

    const computeTTLFn = computeTTL(options.timeToLive)

    return {
      get: (params: Params): Effect.Effect<Value, Error> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)
          const now = yield* Clock.currentTimeMillis

          return yield* pipe(
            getBestMatchFromBucket(bucket, params, options.config, now, options.minScore, fuzzyStatsTracker),
            Option.getOrElse(() => lookupAndCache(params, bucket, now, options.lookup, context, computeTTLFn, options.capacity.list, fuzzyStatsTracker))
          )
        }),

      getEither: (params: Params): Effect.Effect<Either.Either<Value, Value>, Error> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)
          const now = yield* Clock.currentTimeMillis

          return yield* pipe(
            getBestMatchFromBucket(bucket, params, options.config, now, options.minScore, fuzzyStatsTracker),
            Option.match({
              onNone: () => pipe(
                lookupAndCache(params, bucket, now, options.lookup, context, computeTTLFn, options.capacity.list, fuzzyStatsTracker),
                Effect.map(Either.right)
              ),
              onSome: (effect) => pipe(effect, Effect.map(Either.left))
            })
          )
        }),

      getOption: (params: Params): Effect.Effect<Option.Option<Value>, Error> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucketOption = yield* bucketCache.getOption(bucketKey)

          return yield* pipe(
            bucketOption,
            Option.match({
              onNone: () => Effect.succeed(Option.none<Value>()),
              onSome: (bucket) => Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis
                const best = findBestMatch(bucket, params, options.config, now, options.minScore)

                if (Option.isSome(best)) {
                  return Option.some(best.value.value)
                }

                const paramsHash = Hash.structure(params)
                const pendingEntry = bucket.find(
                  (e) => EntryValue.isPending(e) && Hash.hash(e) === paramsHash
                )

                if (pendingEntry && EntryValue.isPending(pendingEntry)) {
                  const value = yield* Deferred.await(pendingEntry.deferred)
                  return Option.some(value)
                }

                return Option.none()
              })
            })
          )
        }),

      getOptionComplete: (params: Params): Effect.Effect<Option.Option<Value>> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucketOption = yield* bucketCache.getOptionComplete(bucketKey)
          const now = yield* Clock.currentTimeMillis

          return pipe(
            bucketOption,
            Option.flatMap((bucket) => {
              const paramsHash = Hash.structure(params)
              const hasPending = bucket.some(
                (e) => EntryValue.isPending(e) && Hash.hash(e) === paramsHash
              )

              if (hasPending) {
                return Option.none()
              }

              return pipe(
                findBestMatch(bucket, params, options.config, now, options.minScore),
                Option.map((scored) => scored.value)
              )
            })
          )
        }),

      getAll: (params: Params, threshold = 0.0): Effect.Effect<Array<any>, Error> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)
          const now = yield* Clock.currentTimeMillis

          for (let i = bucket.length - 1; i >= 0; i--) {
            const entry = bucket[i]
            if (entry && EntryValue.isComplete(entry) && hasExpired(now)(entry)) {
              bucket.splice(i, 1)
            }
          }

          if (bucket.length === 0) {
            const value: Value = yield* Effect.provide(options.lookup(params), context)
            const entry = EntryValue.complete<Value, Error>(
              params,
              value,
              now + computeTTLFn(Exit.succeed(value)),
              now
            )
            addEntryWithEviction(bucket, entry, options.capacity.list)
            return [{ value, score: 1.0, params }]
          }

          const effectiveThreshold = Math.max(threshold, options.minScore)
          return pipe(
            bucket,
            Array.filter(EntryValue.isComplete),
            Array.map((entry) => ({
              value: entry.value,
              score: scoreEntry(
                entry,
                params,
                options.config
              ),
              params: entry.params
            })),
            Array.filter((result) => result.score >= effectiveThreshold),
            Array.sortWith((entry) => entry.score, Order.number)
          )
        }),

      refresh: (params: Params): Effect.Effect<void, Error> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)
          const now = yield* Clock.currentTimeMillis

          const value: Value = yield* Effect.provide(options.lookup(params), context)
          const entry = EntryValue.complete<Value, Error>(
            params,
            value,
            now + computeTTLFn(Exit.succeed(value)),
            now
          )
          addEntryWithEviction(bucket, entry, options.capacity.list)
        }),

      set: (params: Params, value: Value): Effect.Effect<void> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucket = yield* bucketCache.get(bucketKey)
          const now = yield* Clock.currentTimeMillis

          const existingIndex = bucket.findIndex((entry) =>
            EntryValue.isComplete(entry) &&
            Object.keys(params).length === Object.keys(entry.params).length &&
            Object.keys(params).every((key) => Equal.equals(params[key], entry.params[key]))
          )

          if (existingIndex !== -1) {
            const existingEntry = bucket[existingIndex]!
            if (EntryValue.isComplete(existingEntry)) {
              bucket[existingIndex] = EntryValue.complete<Value, Error>(
                params,
                value,
                now + computeTTLFn(Exit.succeed(value)),
                now
              )
            }
          } else {
            const entry = EntryValue.complete<Value, Error>(
              params,
              value,
              now + computeTTLFn(Exit.succeed(value)),
              now
            )
            addEntryWithEviction(bucket, entry, options.capacity.list)
          }
        }),

      exactStats: Effect.map(bucketCache.cacheStats, (stats) => stats),

      fuzzyStats: Effect.map(
        bucketCache.values,
        (buckets) => computeBucketStats(buckets, fuzzyStatsTracker)
      ),

      cacheStats: Effect.map(
        bucketCache.values,
        (buckets) => computeBucketStats(buckets, fuzzyStatsTracker)
      ),

      contains: (params: Params): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const { exact } = partitionParams(params, options.config)
          const bucketKey = createBucketKey(exact)
          const bucketOption = yield* bucketCache.getOptionComplete(bucketKey)

          return pipe(
            bucketOption,
            Option.map((bucket) => bucket.some(EntryValue.isComplete)),
            Option.getOrElse(() => false)
          )
        }),

      entryStats: (params: Params): Effect.Effect<Option.Option<Cache.EntryStats>> =>
        pipe(
          getBucketAndMatch(params, options.config, options.minScore, (key) => bucketCache.getOptionComplete(key)),
          Effect.map(Option.flatMap(({ bucket, best }) =>
            pipe(
              bucket,
              Array.filter(EntryValue.isComplete),
              Array.findFirst((e) => e.value === best.value),
              Option.map((entry) => Cache.makeEntryStats(entry.loadedMillis))
            )
          ))
        ),

      invalidate: (params: Params): Effect.Effect<void> =>
        pipe(
          getBucketAndMatch(params, options.config, options.minScore, (key) => bucketCache.getOptionComplete(key)),
          Effect.map(Option.map(({ bucket, best }) => removeEntryByValue(bucket, best.value))),
          Effect.asVoid
        ),

      invalidateWhen: (params: Params, predicate: (value: Value) => boolean): Effect.Effect<void> =>
        pipe(
          getBucketAndMatch(params, options.config, options.minScore, (key) => bucketCache.getOptionComplete(key)),
          Effect.map(Option.map(({ bucket, best }) => {
            if (predicate(best.value)) {
              removeEntryByValue(bucket, best.value)
            }
          })),
          Effect.asVoid
        ),

      invalidateAll: bucketCache.invalidateAll,

      size: pipe(
        bucketCache.values,
        Effect.map((buckets) => pipe(
          buckets,
          Array.flatten,
          Array.filter(EntryValue.isComplete),
          (arr) => arr.length
        ))
      ),

      keys: pipe(
        bucketCache.values,
        Effect.map((buckets) => pipe(
          buckets,
          Array.flatten,
          Array.filterMap((entry) =>
            EntryValue.isComplete(entry) ? Option.some(entry.params as Params) : Option.none()
          )
        ))
      ),

      values: pipe(
        bucketCache.values,
        Effect.map((buckets) => pipe(
          buckets,
          Array.flatten,
          Array.filterMap((entry) =>
            EntryValue.isComplete(entry) ? Option.some(entry.value) : Option.none()
          )
        ))
      ),

      entries: pipe(
        bucketCache.values,
        Effect.map((buckets) => pipe(
          buckets,
          Array.flatten,
          Array.filterMap((entry) =>
            EntryValue.isComplete(entry)
              ? Option.some([entry.params as Params, entry.value] as [Params, Value])
              : Option.none()
          )
        ))
      )
    }
  })
