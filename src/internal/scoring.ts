import * as Record from "effect/Record"
import * as Number from "effect/Number"
import * as Option from "effect/Option"
import * as Array from "effect/Array"
import * as Order from "effect/Order"
import { pipe } from "effect/Function"
import type { FuzzyConfig } from "./config.js"
import { ParamMatcher as ParamMatcherNS } from "./config.js"
import * as EntryValue from "./entry"

export const scoreEntry = <Params extends Record<string, unknown>>(
  entry: EntryValue.Complete<unknown>,
  queryParams: Params,
  config: FuzzyConfig<Params>
): Option.Option<number> => {
  const [nones, somes] = pipe(
    config,
    Record.map((matcher, key) =>
      ParamMatcherNS.$match(matcher, {
        Exact: () => Option.some(1),
        Fuzzy: ({ scorer }) => scorer(entry.params[key] as any, queryParams[key] as any)
      })),
    Record.partition(Option.isSome),
  )

  if (!Record.isEmptyRecord(nones)) return Option.none()
  return pipe(
    somes,
    Record.reduce(0, (acc, value) => acc + value.value),
    Number.divide(Record.size(somes))
  )

}
export const findBestMatch = <Params extends Record<string, unknown>, Value>(
  bucket: Array<EntryValue.EntryValue<Value, any>>,
  params: Params,
  config: FuzzyConfig<Params>,
  now: number,
  minScore: number
): Option.Option<{ value: Value; score: number; params: Record<string, unknown> }> =>
  pipe(
    bucket,
    Array.filter(EntryValue.isComplete),
    Array.filter(EntryValue.hasNotExpired(now)),
    Array.filterMap((entry) => scoreEntry(entry, params, config).pipe(
      Option.flatMap((score) =>
        score >= minScore
          ? Option.some({ value: entry.value, score, params: entry.params })
          : Option.none()
      )
    )),
    Array.sortWith((entry) => entry.score, Order.number),
    Option.fromIterable
  );
