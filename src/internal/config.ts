import * as Data from "effect/Data"
import * as Record from "effect/Record"
import * as Either from "effect/Either"
import * as Option from "effect/Option"


export type ParamMatcher<A> = Data.TaggedEnum<{
  Exact: {},
  Fuzzy: { readonly scorer: (cached: A, query: A) => Option.Option<number> }
}>

interface ParamMatcherDefinitionn extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: ParamMatcher<this["A"]>
}

export const ParamMatcher = Data.taggedEnum<ParamMatcherDefinitionn>()

export type FuzzyConfig<Params extends Record<string, unknown>> = {
  readonly [K in keyof Params]: ParamMatcher<Params[K]>
}

export function partitionParams<Params extends Record<string, unknown>>(
  params: Params,
  config: FuzzyConfig<Params>
): {
  exact: Partial<Params>
  fuzzy: Partial<Params>
} {
  const [exact, fuzzy] = Record.partitionMap(params, (value, key) =>
    ParamMatcher.$is("Exact")(config[key])
      ? Either.left(value)
      : Either.right(value)
  )

  return {
    exact: exact,
    fuzzy: fuzzy
  } as any
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
