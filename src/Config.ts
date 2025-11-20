/**
 * FuzzyConfig - Configuration for fuzzy cache parameter matching
 *
 * @since 1.0.0
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"

// Define a union type using TaggedEnum
export type InputConfig = Data.TaggedEnum<{
  CosineSimilar: {
    /** Model for embedding */
    model: string,
    /** Similarity threshold of the cosine sim between 0 and 1 */
    distanceThreshold?: number
  }
  /** Exactly matches what is in cache */
  ExactMatch: {
    /** No additional properties */
  }
  /** When the item in the cache for this input has a higher value it matches */
  MoreIsBetter: {
    /** No additional properties */
  }
}>

/**
 * @example
 * const conf1 = InputConfig.CosineSimilar({ model: "text-embedding-3-small", distanceThreshold: 0.8 })
 * const conf2 = InputConfig.ExactMatch({})
 * const conf3 = InputConfig.MoreIsBetter({})
 */
export const InputConfig = Data.taggedEnum<InputConfig>()

// FuzzyCache


/*
const cache = {
  previousValues: ReadonyArray<> ?
}

// FUTURE:
// Purpose: Checks the previous cached values and returns sats on the inoput cache for debugging.
// const sats = (cache: Cache) => CacheStats (Hit, miss, ...)
// NOW: Is using Tracer to annotate cache retrieval information (misses, approximate hits, etc)


// enum of methods that take in a cache and ops on it
// mutates over the cache
const MoreIsBetter = (cache, fnresult) => result
*/


type FuzzyCacheErrors = never;
class FuzzyCache { }

export const with_ = <Params extends Record<string, unknown>, A, E, R>(
  _fn: (params: Params) => Effect.Effect<A, E, R>,
  _config: {
    params: {
      [P in keyof Params]: InputConfig;
    },
    ttlMs: number,
  }
): (params: Params) => Effect.Effect<A, E | FuzzyCacheErrors, R | FuzzyCache> => {









  ///caching ogic
  throw new Error("Not implemented")
}