import { Array, DateTime, Number as Numeric, Option, Schema, String } from "effect";

// Object names are opaque to the reader. Constrain the public namespace, not
// Nix's current digest alphabet or compression formats.
const safeName = (name: string) =>
  name !== "" &&
  name !== "." &&
  name !== ".." &&
  Array.every(
    String.split(name, ""),
    (character) =>
      (character >= "a" && character <= "z") ||
      (character >= "A" && character <= "Z") ||
      (character >= "0" && character <= "9") ||
      character === "." ||
      character === "_" ||
      character === "-",
  );

export const objectKey = (pathname: string): Option.Option<string> => {
  const key = String.slice(1)(pathname);
  if (key === "nix-cache-info") return Option.some(key);
  if (safeName(key) && String.endsWith(".narinfo")(key) && key !== ".narinfo")
    return Option.some(key);
  if (String.startsWith("nar/")(key) && safeName(String.slice(4)(key))) return Option.some(key);
  return Option.none();
};

export const matchesEtag = (value: string, etag: string, weak = false) =>
  Array.some(String.split(value, ","), (part) => {
    const tag = String.trim(part);
    return (
      tag === "*" || (weak && String.startsWith("W/")(tag) ? String.slice(2)(tag) : tag) === etag
    );
  });

const uploadedSeconds = (uploaded: DateTime.Utc) => DateTime.toEpochSeconds(uploaded);

const dateSeconds = (value: string) => Option.map(DateTime.make(value), DateTime.toEpochSeconds);

export const dateAtLeast = (value: string, uploaded: DateTime.Utc) =>
  Option.exists(dateSeconds(value), (seconds) => seconds >= uploadedSeconds(uploaded));

export const dateBefore = (value: string, uploaded: DateTime.Utc) =>
  Option.exists(dateSeconds(value), (seconds) => seconds < uploadedSeconds(uploaded));

export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

const rangeInteger = Schema.decodeUnknownOption(Schema.NumberFromString.check(Schema.isInt()));

export const parseRange = (value: string, size: number): Option.Option<ByteRange> => {
  // HTTP's decimal-only single byte-range grammar needs lexical validation:
  // Number alone also accepts whitespace, signs, exponents and hex literals.
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || size === 0) return Option.none();
  const [, start, end] = match;
  if (start === "" && end !== "") {
    const suffix = rangeInteger(end);
    if (Option.isNone(suffix) || suffix.value <= 0) return Option.none();
    return Option.some({
      offset: Numeric.max(0, size - suffix.value),
      length: Numeric.min(size, suffix.value),
    });
  }
  const offset = rangeInteger(start);
  const last = end === "" ? Option.some(size - 1) : rangeInteger(end);
  if (
    Option.isNone(offset) ||
    Option.isNone(last) ||
    offset.value >= size ||
    last.value < offset.value
  )
    return Option.none();
  return Option.some({
    offset: offset.value,
    length: Numeric.min(last.value, size - 1) - offset.value + 1,
  });
};
