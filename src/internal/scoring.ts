import * as Record from "effect/Record"
import * as Number from "effect/Number"
import * as Option from "effect/Option"
import * as Array from "effect/Array"
import * as Order from "effect/Order"
import { pipe } from "effect/Function"
import type { FuzzyConfig } from "./config.js"
import type { Complete, EntryValue } from "./entry.js"
import { EntryValue as EntryValueNS, hasNotExpired } from "./entry.js"
import { ParamMatcher as ParamMatcherNS } from "./config.js"

export const scoreEntry = <Params extends Record<string, unknown>>(
  entry: Complete<unknown>,
  queryParams: Params,
  config: FuzzyConfig<Params>
): number => pipe(
  config,
  Record.map((matcher, key) =>
    ParamMatcherNS.$match(matcher, {
      Exact: () => 1,
      Fuzzy: ({ scorer }) => scorer(entry.params[key] as any, queryParams[key] as any)
    })),
  Record.values,
  Number.sumAll,
  Number.divide(Record.size(config)),
  Option.getOrElse(() => 0)
)

export const findBestMatch = <Params extends Record<string, unknown>, Value>(
  bucket: Array<EntryValue<Value, any>>,
  params: Params,
  config: FuzzyConfig<Params>,
  now: number,
  minScore: number
): Option.Option<{ value: Value; score: number; params: Record<string, unknown> }> =>
  pipe(
    bucket,
    Array.filter(EntryValueNS.isComplete),
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
