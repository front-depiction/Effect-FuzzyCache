import * as Cache from "effect/Cache"
import * as Array from "effect/Array"
import { pipe } from "effect/Function"
import type { EntryValue } from "./entry.js"
import { EntryValue as EntryValueNS } from "./entry.js"

export interface StatsTracker {
  trackHit: () => void
  trackMiss: () => void
  get: () => { hits: number; misses: number }
}

export const createStatsTracker = (): StatsTracker => {
  let hits = 0
  let misses = 0

  return {
    trackHit: () => { hits++ },
    trackMiss: () => { misses++ },
    get: () => ({ hits, misses })
  }
}

export const computeBucketStats = <Value>(
  buckets: Array<Array<EntryValue<Value, any>>>,
  fuzzyStatsTracker: StatsTracker
): Cache.CacheStats => {
  const totalSize = pipe(
    buckets,
    Array.flatten,
    Array.filter(EntryValueNS.isComplete),
    (arr) => arr.length
  )
  const { hits, misses } = fuzzyStatsTracker.get()
  return Cache.makeCacheStats({ hits, misses, size: totalSize })
}
