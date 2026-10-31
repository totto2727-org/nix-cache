import type * as CF from "@cloudflare/workers-types";
import type { ObjectBody, R2Object } from "alchemy/Cloudflare/R2";
import { createHash, timingSafeEqual } from "node:crypto";
import { DateTime, Effect, Option, Schema } from "effect";
import { HttpServerResponse } from "effect/http";

// Fixed-size SHA-256 digests preserve timing-safe comparison for arbitrary
// credential lengths. Native crypto is required for timingSafeEqual.
export const credentialsMatch = (supplied: string, expected: string) =>
  timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(expected).digest(),
  );

export const uploaded = (object: Pick<R2Object, "uploaded">) =>
  DateTime.fromDateUnsafe(object.uploaded);

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

export const makeResponseCache = (options: {
  readonly cache: Pick<CF.Cache, "match" | "put">;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}) => ({
  match: (key: string) =>
    Effect.tryPromise(() => options.cache.match(key)).pipe(
      Effect.map((response) =>
        Option.fromNullishOr(response).pipe(
          Option.map((value) => fromCloudflare(value as unknown as Response)),
        ),
      ),
      Effect.orElseSucceed(() => Option.none()),
    ),
  // Cache API needs a cloneable native Response and waitUntil needs a Promise.
  // Tee only here, retaining streaming and the Effect response in the core.
  put: (key: string, response: HttpServerResponse.HttpServerResponse) =>
    Effect.sync(() => {
      const web = HttpServerResponse.toWeb(response);
      const cached = web.clone();
      options.waitUntil(
        Effect.runPromise(
          Effect.tryPromise(() => options.cache.put(key, cached as unknown as CF.Response)).pipe(
            Effect.catch(() => Effect.logWarning("Nix cache write failed")),
          ),
        ),
      );
      return fromCloudflare(web);
    }),
});

// Alchemy exposes the original R2 readable for zero-copy native HTTP forwarding.
// Effect stream fallback supports clients without a native stream, without buffering.
export const objectResponse = (
  object: Pick<ObjectBody, "readable" | "body">,
  headers: Readonly<Record<string, string>>,
  status: number,
  contentLength: number,
) => {
  const options = { status, headers, contentLength, contentType: headers["Content-Type"] };
  return object.readable === undefined
    ? HttpServerResponse.stream(object.body, options)
    : HttpServerResponse.raw(object.readable, options);
};

export type ResponseCache = ReturnType<typeof makeResponseCache>;
