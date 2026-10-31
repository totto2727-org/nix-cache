import type * as CF from "@cloudflare/workers-types";
import { Array, Context, Effect, Layer, Option, Record, Redacted, String } from "effect";
import { Base64 } from "effect/encoding";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  credentialsMatch,
  httpDate,
  makeStorage,
  uploaded,
  type Storage,
  type UpstreamFailure,
} from "./cloudflare-storage";
import {
  dateAtLeast,
  dateBefore,
  matchesEtag,
  objectKey,
  parseRange,
  type ByteRange,
} from "./http-policy";

export interface CacheOptions {
  readonly bucket: CF.R2Bucket;
  readonly cache: Pick<CF.Cache, "match" | "put">;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly username: Redacted.Redacted<string>;
  readonly cacheNamespace: string;
  readonly password: Redacted.Redacted<string>;
}

const maxCacheBytes = 128 * 1024 * 1024;
class CacheStorage extends Context.Service<CacheStorage, Storage>()("nix-cache/Storage") {}

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
    const storage = yield* CacheStorage;
    const headers = { "Accept-Ranges": "bytes" };
    if (request.method !== "HEAD" && !conditional && rangeHeader === undefined)
      return {
        _tag: "Read",
        plan: { headers, range: Option.none(), expectedEtag: Option.none() },
      } satisfies Preparation;
    const metadata = yield* storage.head(key);
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
): Effect.Effect<HttpServerResponse.HttpServerResponse, UpstreamFailure, CacheStorage> =>
  Effect.gen(function* () {
    const storage = yield* CacheStorage;
    const prepared: Preparation = yield* prepare(request, key, conditional, rangeHeader);
    if (prepared._tag === "Reply") return prepared.response;
    const { plan } = prepared;
    const object = yield* storage.get(key, {
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
    const ttl = String.startsWith("nar/")(key) ? 31536000 : key === "nix-cache-info" ? 60 : 300;
    const contentLength = Option.match(plan.range, {
      onNone: () => object.size,
      onSome: (range) => range.length,
    });
    let response = storage.body(
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
    if (
      !conditional &&
      rangeHeader === undefined &&
      request.method === "GET" &&
      object.size <= maxCacheBytes
    )
      response = yield* storage.put(cacheKey, response);
    return privateResponse(response, request.method);
  });

const serve = (options: CacheOptions) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const username = Redacted.value(options.username);
    const password = Redacted.value(options.password);
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
    // URI component encoding is the serialization boundary for the opaque cache
    // namespace. Fixed origin prevents Host or credentials entering cache keys.
    const cacheKey = `https://nix-cache.internal/${encodeURIComponent(options.cacheNamespace)}/${key.value}`;
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
  });

/** Effect HTTP composition root, also used by local workerd acceptance tests. */
export const makeCacheHttpEffect = (options: CacheOptions) =>
  serve(options).pipe(
    Effect.provide(Layer.succeed(CacheStorage, makeStorage(options))),
    Effect.catchTag("UpstreamFailure", () => Effect.succeed(reply(502))),
  );
