import * as Hash from "effect/Hash"
import * as Equal from "effect/Equal"
import * as Data from "effect/Data"
import * as Record from "effect/Record"
import * as Either from "effect/Either"
import * as Number from "effect/Number"
import * as Option from "effect/Option"
import { pipe } from "effect/Function"

export type ParamMatcher<A> = Data.TaggedEnum<{
  Exact: {},
  Fuzzy: { readonly scorer: (cached: A, query: A) => number }
}>

interface ParamMatcherDefinitionn extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: ParamMatcher<this["A"]>
}

export const ParamMatcher = Data.taggedEnum<ParamMatcherDefinitionn>()

export type FuzzyConfig<Params extends Record<string, unknown>> = {
  readonly [K in keyof Params]: ParamMatcher<Params[K]>
}

export interface BucketKey extends Equal.Equal {
  readonly exactParams: Record<string, unknown>
}

const BucketKeyProto: Omit<BucketKey, "exactParams"> = {
  [Hash.symbol](this: BucketKey): number {
    return Hash.cached(this, Hash.structure(this.exactParams))
  },

  [Equal.symbol](this: BucketKey, that: BucketKey): boolean {
    const thisKeys = Object.keys(this.exactParams)
    const thatKeys = Object.keys(that.exactParams)

    if (thisKeys.length !== thatKeys.length) return false

    for (const key of thisKeys) {
      if (!(key in that.exactParams)) return false
      if (!Equal.equals(this.exactParams[key], that.exactParams[key])) return false
    }

    return true
  }
}

export const makeBucketKey = (exactParams: Record<string, unknown>): BucketKey => {
  return Object.create(BucketKeyProto, {
    exactParams: {
      value: exactParams,
      enumerable: true,
      writable: false
    }
  })
}

export interface CacheEntry<Value> {
  readonly id: string
  readonly params: Record<string, unknown>
  readonly value: Value
  readonly timeToLiveMillis: number
  readonly loadedMillis: number
}

export const hasExpired = (now: number) => <Value>(entry: CacheEntry<Value>): boolean =>
  now >= entry.timeToLiveMillis

export const hasNotExpired = (now: number) => <Value>(entry: CacheEntry<Value>): boolean =>
  now < entry.timeToLiveMillis

export function partitionParams<Params extends Record<string, unknown>>(
  params: Params,
  config: FuzzyConfig<Params>
): {
  exact: Partial<Params>
  fuzzy: Partial<Params>
} {
  const [exact, fuzzy] = Record.partitionMap(params, (value, key) => {
    const matcher = config[key as keyof Params]
    return ParamMatcher.$is("Exact")(matcher) ? Either.left(value) : Either.right(value)
  })

  return { exact: exact as Partial<Params>, fuzzy: fuzzy as Partial<Params> }
}

export function createBucketKey(exactParams: Record<string, unknown>): BucketKey {
  return makeBucketKey(exactParams)
}

export const scoreEntry = <Params extends Record<string, unknown>>(
  entry: CacheEntry<unknown>,
  queryParams: Params,
  config: FuzzyConfig<Params>
): number => pipe(
  config,
  Record.map((matcher, key) =>
    ParamMatcher.$match(matcher, {
      Exact: () => 1,
      Fuzzy: ({ scorer }) => scorer(entry.params[key] as any, queryParams[key] as any)
    })),
  Record.values,
  Number.sumAll,
  Number.divide(Record.size(config)),
  Option.getOrElse(() => 0)
)

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
}

export const cacheVariance = {
  _Key: (_: any) => _,
  _Error: (_: never) => _,
  _Value: (_: any) => _
}

export const consumerCacheVariance = {
  _Key: (_: any) => _,
  _Error: (_: never) => _,
  _Value: (_: never) => _
}
