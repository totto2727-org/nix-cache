import type { GetOptions, ObjectBody, R2Error, R2Object } from "alchemy/Cloudflare/R2";
import { Array, Context, Effect, Option, Record, Redacted, String } from "effect";
import { Base64 } from "effect/encoding";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  credentialsMatch,
  httpDate,
  objectResponse,
  uploaded,
  type ResponseCache,
} from "./cloudflare-storage";
import {
  dateAtLeast,
  dateBefore,
  matchesEtag,
  objectKey,
  parseRange,
  type ByteRange,
} from "./http-policy";

export class CacheReader extends Context.Service<
  CacheReader,
  {
    readonly username: Redacted.Redacted<string>;
    readonly cacheNamespace: string;
    readonly password: Redacted.Redacted<string>;
  }
>()("nix-cache/Reader") {}

const narTtlSeconds = 365 * 24 * 60 * 60;
const cacheInfoTtlSeconds = 60;
const narinfoTtlSeconds = 5 * 60;
export class CacheStorage extends Context.Service<CacheStorage, ResponseCache>()(
  "nix-cache/ResponseCache",
) {}

type CacheObject = Pick<R2Object, "size" | "etag" | "httpEtag" | "uploaded">;
type CacheObjectBody = CacheObject & Pick<ObjectBody, "body" | "readable">;

export class CacheBucket extends Context.Service<
  CacheBucket,
  {
    readonly head: (key: string) => Effect.Effect<CacheObject | null, R2Error>;
    readonly get: (
      key: string,
      options: GetOptions,
    ) => Effect.Effect<CacheObjectBody | CacheObject | null, R2Error>;
  }
>()("nix-cache/Bucket") {}

const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Authorization" };
const reply = (status: number, headers?: Readonly<Record<string, string>>) =>
  HttpServerResponse.empty({ status, headers: { ...headers, ...privateHeaders } });

// Only the explicit Worker Cache API may cache private objects. All responses,
// including failures and cache hits, are private to the authenticated caller.
const privateResponse = (response: HttpServerResponse.HttpServerResponse, method: string) =>
  method === "HEAD"
    ? reply(response.status, response.headers)
    : HttpServerResponse.setHeaders(response, privateHeaders);

interface ReadPlan {
  readonly range: Option.Option<ByteRange>;
  readonly expectedEtag: Option.Option<string>;
  readonly headers: Readonly<Record<string, string>>;
}
type Preparation =
  | { readonly _tag: "Reply"; readonly response: HttpServerResponse.HttpServerResponse }
  | { readonly _tag: "Read"; readonly plan: ReadPlan };

const prepare = (
  request: HttpServerRequest.HttpServerRequest,
  key: string,
  conditional: boolean,
  rangeHeader: string | undefined,
) =>
  Effect.gen(function* () {
    const bucket = yield* CacheBucket;
    const headers = { "Accept-Ranges": "bytes" };
    if (request.method !== "HEAD" && !conditional && rangeHeader === undefined)
      return {
        _tag: "Read",
        plan: { headers, range: Option.none(), expectedEtag: Option.none() },
      } satisfies Preparation;
    const metadata = yield* bucket.head(key);
    if (!metadata) return { _tag: "Reply", response: reply(404) } satisfies Preparation;
    const validators = {
      ...headers,
      ETag: metadata.httpEtag,
      "Last-Modified": httpDate(uploaded(metadata)),
    };
    const ifMatch = request.headers["if-match"];
    if (ifMatch !== undefined && !matchesEtag(ifMatch, metadata.httpEtag))
      return { _tag: "Reply", response: reply(412) } satisfies Preparation;
    const unmodifiedSince = request.headers["if-unmodified-since"];
    if (
      ifMatch === undefined &&
      unmodifiedSince !== undefined &&
      dateBefore(unmodifiedSince, uploaded(metadata))
    )
      return { _tag: "Reply", response: reply(412) } satisfies Preparation;
    const ifNoneMatch = request.headers["if-none-match"];
    const modifiedSince = request.headers["if-modified-since"];
    if (
      ifNoneMatch !== undefined
        ? matchesEtag(ifNoneMatch, metadata.httpEtag, true)
        : modifiedSince !== undefined && dateAtLeast(modifiedSince, uploaded(metadata))
    )
      return { _tag: "Reply", response: reply(304, validators) } satisfies Preparation;
    if (request.method === "HEAD")
      return {
        _tag: "Reply",
        response: reply(200, {
          ...validators,
          "Content-Length": `${metadata.size}`,
          "Content-Type": contentType(key),
        }),
      } satisfies Preparation;
    const ifRange = request.headers["if-range"];
    const rangeMatches =
      ifRange === undefined ||
      ifRange === metadata.httpEtag ||
      dateAtLeast(ifRange, uploaded(metadata));
    if (rangeHeader !== undefined && rangeMatches) {
      const range = parseRange(rangeHeader, metadata.size);
      if (Option.isNone(range))
        return {
          _tag: "Reply",
          response: reply(416, { "Content-Range": `bytes */${metadata.size}` }),
        } satisfies Preparation;
      return {
        _tag: "Read",
        plan: {
          expectedEtag: Option.some(metadata.etag),
          range,
          headers: {
            ...validators,
            "Content-Range": `bytes ${range.value.offset}-${range.value.offset + range.value.length - 1}/${metadata.size}`,
          },
        },
      } satisfies Preparation;
    }
    return {
      _tag: "Read",
      plan: { headers: validators, range: Option.none(), expectedEtag: Option.some(metadata.etag) },
    } satisfies Preparation;
  });

const contentType = (key: string) =>
  String.startsWith("nar/")(key) ? "application/octet-stream" : "text/plain";

const readObject = (
  request: HttpServerRequest.HttpServerRequest,
  key: string,
  cacheKey: string,
  conditional: boolean,
  rangeHeader: string | undefined,
  attempt = 0,
): Effect.Effect<HttpServerResponse.HttpServerResponse, R2Error, CacheBucket | CacheStorage> =>
  Effect.gen(function* () {
    const bucket = yield* CacheBucket;
    const prepared: Preparation = yield* prepare(request, key, conditional, rangeHeader);
    if (prepared._tag === "Reply") return prepared.response;
    const { plan } = prepared;
    const object = yield* bucket.get(key, {
      ...(Option.isSome(plan.range) ? { range: plan.range.value } : {}),
      ...(Option.isSome(plan.expectedEtag)
        ? { onlyIf: { etagMatches: plan.expectedEtag.value } }
        : {}),
    });
    if (!object) return reply(404);
    // A HEAD/GET replacement must not mix old validators or ranges with new
    // bytes. Re-evaluate exactly once, then fail closed under repeated writes.
    if (!("body" in object))
      return attempt === 0
        ? yield* readObject(request, key, cacheKey, conditional, rangeHeader, 1)
        : reply(503);
    const ttl = String.startsWith("nar/")(key)
      ? narTtlSeconds
      : key === "nix-cache-info"
        ? cacheInfoTtlSeconds
        : narinfoTtlSeconds;
    const contentLength = Option.match(plan.range, {
      onNone: () => object.size,
      onSome: (range) => range.length,
    });
    let response = objectResponse(
      object,
      {
        ...plan.headers,
        ETag: object.httpEtag,
        "Last-Modified": httpDate(uploaded(object)),
        "Content-Length": `${contentLength}`,
        "Content-Type": contentType(key),
        "Cache-Control": `public, max-age=${ttl}`,
      },
      Option.isSome(plan.range) ? 206 : 200,
      contentLength,
    );
    if (!conditional && rangeHeader === undefined && request.method === "GET") {
      const cache = yield* CacheStorage;
      response = yield* cache.put(cacheKey, response);
    }
    return privateResponse(response, request.method);
  });

const cacheObject = Effect.gen(function* () {
  const reader = yield* CacheReader;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const username = Redacted.value(reader.username);
  const password = Redacted.value(reader.password);
  if (!username || !password || String.includes(":")(username)) return reply(503);
  const expected = `Basic ${Base64.encode(`${username}:${password}`)}`;
  if (!credentialsMatch(request.headers["authorization"] ?? "", expected))
    return reply(401, { "WWW-Authenticate": 'Basic realm="nix-cache", charset="UTF-8"' });
  if (request.method !== "GET" && request.method !== "HEAD")
    return reply(405, { Allow: "GET, HEAD" });
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url) || url.value.search !== "") return reply(404);
  const key = objectKey(url.value.pathname);
  if (Option.isNone(key)) return reply(404);
  // Native URL pathname preserves opaque R2 percent-encoded keys rather than
  // decoded router parameters. Component encoding serializes both namespace
  // and object key without URL canonicalization aliases at the Cache API boundary.
  const cacheKey = `https://nix-cache.internal/${encodeURIComponent(reader.cacheNamespace)}/${encodeURIComponent(key.value)}`;
  const conditional = Array.some(
    Record.keys<string, string>(request.headers),
    String.startsWith("if-"),
  );
  const rangeHeader = request.method === "GET" ? request.headers["range"] : undefined;
  if (!conditional && rangeHeader === undefined) {
    const storage = yield* CacheStorage;
    const cached = yield* storage.match(cacheKey);
    if (Option.isSome(cached)) return privateResponse(cached.value, request.method);
  }
  return yield* readObject(request, key.value, cacheKey, conditional, rangeHeader);
}).pipe(Effect.catchTag("R2Error", () => Effect.succeed(reply(502))));

/** Concrete read endpoints, with storage and reader settings supplied by the entry point. */
export const CacheRoutes = HttpRouter.addAll([
  HttpRouter.route("*", "/nix-cache-info", cacheObject),
  HttpRouter.route("*", "/:narinfo", cacheObject),
  HttpRouter.route("*", "/nar/:nar", cacheObject),
  HttpRouter.route("*", "/*", reply(404)),
]);
