import * as Array from "effect/Array"
import * as Order from "effect/Order"
import type { EntryValue } from "./entry.js"
import { EntryValue as EntryValueNS } from "./entry.js"

export const addEntryWithEviction = <Value>(
  bucket: Array<EntryValue<Value, any>>,
  entry: EntryValue<Value, any>,
  capacity: number
): void => {
  if (bucket.length >= capacity) {
    const completeEntries = bucket.filter(EntryValueNS.isComplete)
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

export const removeEntryByValue = <Value>(bucket: Array<EntryValue<Value, any>>, value: Value): void => {
  const index = bucket.findIndex((entry) =>
    EntryValueNS.isComplete(entry) && entry.value === value
  )
  if (index !== -1) {
    bucket.splice(index, 1)
  }
}
