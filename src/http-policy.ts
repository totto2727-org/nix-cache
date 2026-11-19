import { Array, DateTime, Number, Option, Schema, String } from 'effect'

const leadingSlashWidth = 1
const weakEtagPrefixWidth = 2
const emptySize = 0
const inclusiveEndpointWidth = 1

export const objectKey = (pathname: string): Option.Option<string> => {
  const key = String.slice(leadingSlashWidth)(pathname)
  if (key === 'nix-cache-info') {
    return Option.some(key)
  }
  if (!String.includes('/')(key) && String.endsWith('.narinfo')(key)) {
    return Option.some(key)
  }
  if (/^nar\/[^/]+$/u.test(key)) {
    return Option.some(key)
  }
  return Option.none()
}

export const matchesEtag = (value: string, etag: string, weak = false): boolean =>
  Array.some(String.split(value, ','), (part) => {
    const tag = String.trim(part)
    return tag === '*' || (weak && String.startsWith('W/')(tag) ? String.slice(weakEtagPrefixWidth)(tag) : tag) === etag
  })

const uploadedSeconds = (uploaded: DateTime.Utc): number => DateTime.toEpochSeconds(uploaded)

const dateSeconds = (value: string): Option.Option<number> => Option.map(DateTime.make(value), DateTime.toEpochSeconds)

export const dateAtLeast = (value: string, uploaded: DateTime.Utc): boolean =>
  Option.exists(dateSeconds(value), (seconds) => seconds >= uploadedSeconds(uploaded))

export const dateBefore = (value: string, uploaded: DateTime.Utc): boolean =>
  Option.exists(dateSeconds(value), (seconds) => seconds < uploadedSeconds(uploaded))

const byteRangeSchema = Schema.Struct({ length: Schema.Number, offset: Schema.Number })

export type ByteRange = typeof byteRangeSchema.Type

const rangeInteger = Schema.decodeUnknownOption(Schema.NumberFromString.check(Schema.isInt()))

const suffixRange = (end: string, size: number): Option.Option<ByteRange> => {
  const suffix = rangeInteger(end)
  if (Option.isNone(suffix) || suffix.value <= emptySize) {
    return Option.none()
  }
  return Option.some({ length: Number.min(size, suffix.value), offset: Number.max(emptySize, size - suffix.value) })
}

const offsetRange = (start: string, end: string, size: number): Option.Option<ByteRange> => {
  const endOfObject = size - inclusiveEndpointWidth
  const offset = rangeInteger(start)
  const last = String.isEmpty(end) ? Option.some(endOfObject) : rangeInteger(end)
  if (Option.isNone(offset) || Option.isNone(last) || offset.value >= size || last.value < offset.value) {
    return Option.none()
  }
  return Option.some({
    length: Number.min(last.value, endOfObject) - offset.value + inclusiveEndpointWidth,
    offset: offset.value,
  })
}

export const parseRange = (value: string, size: number): Option.Option<ByteRange> => {
  // HTTP's decimal-only single byte-range grammar needs lexical validation:
  // Number alone also accepts whitespace, signs, exponents and hex literals.
  const match = String.match(/^bytes=(?<start>\d*)-(?<end>\d*)$/u)(value)
  if (Option.isNone(match) || size === emptySize) {
    return Option.none()
  }
  const [, start = '', end = ''] = match.value
  return String.isEmpty(start) && String.isNonEmpty(end) ? suffixRange(end, size) : offsetRange(start, end, size)
}
