import * as Hash from "effect/Hash"
import * as Equal from "effect/Equal"
import * as  Predicate from "effect/Predicate"
import * as Data from "effect/Data"

export const BucketKeyTypeId: unique symbol = Symbol.for("FuzzyCache/BucketKey")
export type BucketKeyTypeId = typeof BucketKeyTypeId
export const isBucketKey = (u: unknown): u is BucketKey => Predicate.hasProperty(u, BucketKeyTypeId)

export interface BucketKey extends Equal.Equal {
  [BucketKeyTypeId]: BucketKeyTypeId
  readonly exactParams: Record<string, unknown>
}

const BucketKeyProto = {
  [BucketKeyTypeId]: BucketKeyTypeId,
  [Hash.symbol](this: BucketKey): number {
    return Hash.cached(this, Hash.structure(this.exactParams))
  },
  [Equal.symbol](this: BucketKey, that: unknown): boolean {
    return isBucketKey(that) && Equal.equals(this.exactParams, that.exactParams)
  }
}
export const makeBucketKey = (exactParams: Record<string, unknown>): BucketKey => {
  return Object.assign({ exactParams: Data.struct(exactParams) }, BucketKeyProto) as any
}

