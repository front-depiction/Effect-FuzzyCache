import * as Hash from "effect/Hash"
import * as Equal from "effect/Equal"

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

export function createBucketKey(exactParams: Record<string, unknown>): BucketKey {
  return makeBucketKey(exactParams)
}
