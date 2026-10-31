import type * as CF from "@cloudflare/workers-types";
import { createHash, timingSafeEqual } from "node:crypto";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import { HttpServerResponse } from "effect/http";

export class UpstreamFailure extends Data.TaggedError("UpstreamFailure")<{
  readonly cause: unknown;
}> {}

// Only calls into Cloudflare bindings turn Promise rejection into a recoverable
// upstream failure. Defects in the HTTP program are deliberately not caught.
const cloudflare = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => new UpstreamFailure({ cause }) });

// Fixed-size SHA-256 digests preserve timing-safe comparison for arbitrary
// credential lengths. Native crypto is required for timingSafeEqual.
export const credentialsMatch = (supplied: string, expected: string) =>
  timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(expected).digest(),
  );

export const uploaded = (object: CF.R2Object) => DateTime.fromDateUnsafe(object.uploaded);

// Effect has no HTTP IMF-fixdate formatter. Date conversion stays here, solely
// for the RFC 9110 wire representation, never for comparisons or parsing.
export const httpDate = (value: DateTime.Utc) => DateTime.toDateUtc(value).toUTCString();

// fromWeb converts bodies into Effect Streams. Workerd then loses the native
// fixed-length stream marker and drops Content-Length. Preserve the native body
// only at this adapter, with explicit Effect body metadata for header updates.
const contentLengthFromHeader = Schema.decodeUnknownOption(Schema.NumberFromString);

const fromCloudflare = (response: Response) =>
  HttpServerResponse.raw(response.body, {
    status: response.status,
    headers: response.headers,
    contentType: response.headers.get("content-type") ?? undefined,
    contentLength: Option.getOrUndefined(
      contentLengthFromHeader(response.headers.get("content-length")),
    ),
  });

export const makeStorage = (options: {
  readonly bucket: CF.R2Bucket;
  readonly cache: Pick<CF.Cache, "match" | "put">;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}) => ({
  head: (key: string) => cloudflare(() => options.bucket.head(key)),
  get: (key: string, getOptions: CF.R2GetOptions) =>
    cloudflare(() => options.bucket.get(key, getOptions)),
  match: (key: string) =>
    cloudflare(() => options.cache.match(key)).pipe(
      Effect.map((response) =>
        Option.fromNullishOr(response).pipe(
          Option.map((value) => fromCloudflare(value as unknown as Response)),
        ),
      ),
      Effect.catchTag("UpstreamFailure", () => Effect.succeed(Option.none())),
    ),
  // Cache API needs a cloneable native Response and waitUntil needs a Promise.
  // Tee only here, retaining streaming and the Effect response in the core.
  put: (key: string, response: HttpServerResponse.HttpServerResponse) =>
    Effect.sync(() => {
      const web = HttpServerResponse.toWeb(response);
      const cached = web.clone();
      options.waitUntil(
        Effect.runPromise(
          cloudflare(() => options.cache.put(key, cached as unknown as CF.Response)).pipe(
            Effect.catchTag("UpstreamFailure", () => Effect.logWarning("Nix cache write failed")),
          ),
        ),
      );
      return fromCloudflare(web);
    }),
  // R2 supplies a Web ReadableStream. HttpServerResponse.raw forwards it without
  // buffering, while all response construction and policy remain Effect HTTP.
  body: (
    object: CF.R2ObjectBody,
    headers: Readonly<Record<string, string>>,
    status: number,
    contentLength: number,
  ) =>
    HttpServerResponse.raw(object.body, {
      status,
      headers,
      contentLength,
      contentType: headers["Content-Type"],
    }),
});

export type Storage = ReturnType<typeof makeStorage>;
