import cloudflare from "@alchemy.run/cloudflare-runtime/vite";
import { purePlugin } from "alchemy/Bundle/PurePlugin";
import { defineConfig } from "vite-plus";

const entry = "virtual:nix-cache/worker";
const resolvedEntry = `\0${entry}`;

export default defineConfig({
  plugins: [
    purePlugin(),
    // Alchemy injects its own host, and Vitest tests own their Miniflare runtime.
    process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1" || process.env.VITEST
      ? null
      : cloudflare({ compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"] }),
    {
      name: "nix-cache:alchemy-worker",
      config: () => ({
        define: { "globalThis.__ALCHEMY_RUNTIME__": "true" },
        resolve: { dedupe: ["effect"] },
      }),
      resolveId: (id) => (id === entry ? resolvedEntry : undefined),
      load: (id) => {
        if (id !== resolvedEntry) return;
        return [
          'import { env, WorkerEntrypoint } from "cloudflare:workers";',
          'import { makeWorkerBridge } from "alchemy/Cloudflare/Bridge";',
          'import entrypoint from "/src/entry.workers.ts";',
          "const stack = { name: env.ALCHEMY_STACK_NAME, stage: env.ALCHEMY_STAGE };",
          'if (!stack.name || !stack.stage) throw new Error("Start the Worker with alchemy dev.");',
          "export default makeWorkerBridge(WorkerEntrypoint, { entrypoint, stack });",
        ].join("\n");
      },
    },
  ],
  ssr: { noExternal: true },
  build: {
    ssr: true,
    target: "esnext",
    rolldownOptions: { input: { index: entry }, external: /^cloudflare:/ },
  },
  fmt: { ignorePatterns: ["pnpm-lock.yaml", "dist/**", "tmp/**"] },
  lint: {
    ignorePatterns: ["dist/**", "tmp/**"],
    options: { typeAware: true, typeCheck: true },
  },
  test: { include: ["src/**/*.test.ts", "tests/**/*.test.ts"] },
});
