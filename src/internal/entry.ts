import * as Hash from "effect/Hash"
import * as Equal from "effect/Equal"
import * as Deferred from "effect/Deferred"
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

const Proto = {
  [EntryValueTypeId]: EntryValueTypeId,
  [Hash.symbol](this: EntryValue<unknown, unknown>) {
    return Hash.cached(this, Hash.structure(this.params))
  },
  [Equal.symbol](this: EntryValue<unknown, unknown>, that: unknown) {
    isEntryValue(that) && this._tag === that._tag && Equal.equals(this, that)
  }
}

/**
 * A scored result containing the cached value, its relevance score, and original parameters
 *
 * @since 1.0.0
 * @category models
 */
export interface ScoredResult<Value> {
  readonly value: Value
  readonly score: number
  readonly params: Record<string, unknown>
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

export const isEntryValue = (u: unknown): u is EntryValue<unknown, unknown> =>
  Predicate.hasProperty(u, EntryValueTypeId)
export const isComplete = <Value, Error>(entry: EntryValue<Value, Error>): entry is Complete<Value> =>
  entry._tag === "Complete"

export const isPending = <Value, Error>(entry: EntryValue<Value, Error>): entry is Pending<Value, Error> =>
  entry._tag === "Pending"

export const hasExpired = (now: number) => <Value>(entry: Complete<Value>): boolean =>
  now >= entry.timeToLiveMillis

export const hasNotExpired = (now: number) => <Value>(entry: Complete<Value>): boolean =>
  now < entry.timeToLiveMillis
