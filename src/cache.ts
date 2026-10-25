import type * as CF from "@cloudflare/workers-types";
import { createHash, timingSafeEqual } from "node:crypto";
import { Effect, Redacted } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

export interface CacheOptions {
  readonly bucket: CF.R2Bucket;
  readonly cache: Pick<CF.Cache, "match" | "put">;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly username: Redacted.Redacted<string>;
  readonly cacheNamespace: string;
  readonly password: Redacted.Redacted<string>;
}

const maxCacheBytes = 128 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest();
const nixHash = "[0-9abcdfghijklmnpqrsvwxyz]";
const objectPath = new RegExp(
  `^/(?:nix-cache-info|${nixHash}{32}\\.narinfo|nar/${nixHash}{52}\\.nar(?:\\.(?:xz|zst|bz2|gz|br))?)$`,
);

const reply = (status: number, headers?: Record<string, string>) =>
  new Response(null, { status, headers: { "Cache-Control": "private, no-store", ...headers } });

// Only the explicit Worker Cache API may cache private objects. Never expose a
// cacheable response to a downstream shared proxy that does not authenticate.
const privateResponse = (response: Response, method: string) => {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Vary", "Authorization");
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    headers,
  });
};

const matchesEtag = (value: string, etag: string) =>
  value.split(",").some((part) => part.trim() === "*" || part.trim().replace(/^W\//, "") === etag);

const notModified = (headers: Readonly<Record<string, string>>, object: CF.R2Object) => {
  const etag = headers["if-none-match"];
  if (etag !== undefined) return matchesEtag(etag, object.httpEtag);
  const since = headers["if-modified-since"];
  return (
    since !== undefined && Math.floor(object.uploaded.getTime() / 1000) <= Date.parse(since) / 1000
  );
};

const parseRange = (value: string, size: number) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || size === 0) return undefined;
  const [, start, end] = match;
  if (start === "" && end !== "") {
    const suffix = Number(end);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    return { offset: Math.max(0, size - suffix), length: Math.min(size, suffix) };
  }
  const offset = Number(start);
  const last = end === "" ? size - 1 : Number(end);
  if (
    start === "" ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(last) ||
    offset >= size ||
    last < offset
  )
    return undefined;
  return { offset, length: Math.min(last, size - 1) - offset + 1 };
};

async function serve(
  options: CacheOptions,
  request: HttpServerRequest.HttpServerRequest,
  attempt = 0,
): Promise<Response> {
  const username = Redacted.value(options.username);
  const password = Redacted.value(options.password);
  if (!username || !password || username.includes(":")) return reply(503);
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const supplied = request.headers["authorization"] ?? "";
  if (!timingSafeEqual(hash(supplied), hash(expected))) {
    return reply(401, { "WWW-Authenticate": 'Basic realm="nix-cache", charset="UTF-8"' });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return reply(405, { Allow: "GET, HEAD" });
  }

  // Reject queries instead of letting arbitrary cache-busting URLs hit R2.
  const url = new URL(request.url, "https://nix-cache.invalid");
  if (url.search || !objectPath.test(url.pathname)) return reply(404);
  const key = url.pathname.slice(1);
  // Fixed synthetic origin makes the key independent of Host and credentials.
  const cacheKey = `https://nix-cache.internal/${encodeURIComponent(options.cacheNamespace)}/${key}`;
  const conditional = Object.keys(request.headers).some((name) => name.startsWith("if-"));
  const rangeHeader = request.method === "GET" ? request.headers["range"] : undefined;
  const canUseCache = !conditional && rangeHeader === undefined;
  if (canUseCache) {
    const cached = await options.cache.match(cacheKey).catch(() => undefined);
    if (cached) {
      return privateResponse(cached as unknown as Response, request.method);
    }
  }

  const headers = new Headers({ "Accept-Ranges": "bytes" });
  let range: { offset: number; length: number } | undefined;
  let expectedEtag: string | undefined;
  if (request.method === "HEAD" || conditional || rangeHeader !== undefined) {
    const metadata = await options.bucket.head(key);
    if (!metadata) return reply(404);
    expectedEtag = metadata.etag;
    headers.set("ETag", metadata.httpEtag);
    headers.set("Last-Modified", metadata.uploaded.toUTCString());
    const ifMatch = request.headers["if-match"];
    if (
      ifMatch !== undefined &&
      !ifMatch
        .split(",")
        .some((value) => value.trim() === "*" || value.trim() === metadata.httpEtag)
    ) {
      return reply(412);
    }
    const unmodifiedSince = request.headers["if-unmodified-since"];
    if (
      ifMatch === undefined &&
      unmodifiedSince !== undefined &&
      Math.floor(metadata.uploaded.getTime() / 1000) > Date.parse(unmodifiedSince) / 1000
    ) {
      return reply(412);
    }
    if (notModified(request.headers, metadata)) return reply(304, Object.fromEntries(headers));
    if (request.method === "HEAD") {
      headers.set("Content-Length", String(metadata.size));
      return privateResponse(new Response(null, { headers }), "HEAD");
    }
    const ifRange = request.headers["if-range"];
    const rangeMatches =
      ifRange === undefined ||
      ifRange === metadata.httpEtag ||
      Date.parse(ifRange) >= Math.floor(metadata.uploaded.getTime() / 1000) * 1000;
    if (rangeHeader !== undefined && rangeMatches) {
      range = parseRange(rangeHeader, metadata.size);
      if (!range) return reply(416, { "Content-Range": `bytes */${metadata.size}` });
      headers.set(
        "Content-Range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`,
      );
    }
  }

  const object = await options.bucket.get(key, {
    ...(range ? { range } : {}),
    ...(expectedEtag ? { onlyIf: { etagMatches: expectedEtag } } : {}),
  });
  if (!object) return reply(404);
  // A replacement between HEAD and GET must not mix old validators/ranges
  // with new bytes. Re-evaluate once, then fail closed under repeated writes.
  if (!("body" in object)) return attempt === 0 ? serve(options, request, 1) : reply(503);
  headers.set("ETag", object.httpEtag);
  headers.set("Last-Modified", object.uploaded.toUTCString());
  headers.set("Content-Length", String(range?.length ?? object.size));
  headers.set("Content-Type", key.startsWith("nar/") ? "application/octet-stream" : "text/plain");
  const ttl = key.startsWith("nar/") ? 31536000 : key === "nix-cache-info" ? 60 : 300;
  headers.set("Cache-Control", `public, max-age=${ttl}`);
  const response = new Response(object.body as unknown as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers,
  });
  if (canUseCache && request.method === "GET" && object.size <= maxCacheBytes) {
    options.waitUntil(
      options.cache.put(cacheKey, response.clone() as unknown as CF.Response).catch(() => {
        console.warn("Nix cache write failed");
      }),
    );
  }
  return privateResponse(response, request.method);
}

/** Native Effect HTTP boundary, also used by local workerd acceptance tests. */
export const makeCacheHttpEffect = (options: CacheOptions) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.tryPromise(() => serve(options, request)).pipe(
      Effect.map(HttpServerResponse.fromWeb),
      Effect.catch(() => Effect.succeed(HttpServerResponse.fromWeb(reply(502)))),
    );
  });
