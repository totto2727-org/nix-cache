import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

// Load the actual production output, not the test-only HTTP entrypoint.
const root = new URL("../dist/ssr/", import.meta.url);
const files = (await readdir(root, { recursive: true })).filter((name) => name.endsWith(".js"));
const modules = Object.fromEntries(
  await Promise.all(
    files.map(async (name) => [
      name,
      { type: "esm", contents: await readFile(new URL(name, root), "utf8") },
    ]),
  ),
);
const env = Object.fromEntries(
  Object.entries({
    ALCHEMY_STACK_NAME: "nix-cache",
    ALCHEMY_STAGE: "test",
    NIX_CACHE_USERNAME: "test",
    NIX_CACHE_PASSWORD: "test",
  }).map(([name, value]) => [name, { type: "text", value }]),
);
const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: "built-worker",
        compatibilityDate: "2026-09-25",
        compatibilityFlags: ["nodejs_compat"],
        manifest: { mainModule: "index.js", modules },
        env: { ...env, "nix-cache-objects": { type: "r2", name: "built-smoke" } },
      },
    },
  ],
});

try {
  await runtime.ready;
  const unauthorized = await runtime.dispatchFetch("https://cache.test/nix-cache-info");
  assert.equal(unauthorized.status, 401, "built Worker must reject unauthenticated requests");
  const authorized = await runtime.dispatchFetch("https://cache.test/nix-cache-info", {
    headers: { authorization: `Basic ${Buffer.from("test:test").toString("base64")}` },
  });
  assert.equal(authorized.status, 404, "built Worker must query the bound empty R2 bucket");
  console.log("Built Worker smoke passed: startup, authentication, and R2 binding");
} finally {
  await runtime.dispose();
}
