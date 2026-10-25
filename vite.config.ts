import { defineConfig } from "vite-plus";

const entry = "virtual:nix-cache/worker";
const resolvedEntry = `\0${entry}`;

export default defineConfig({
  plugins: [
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
  build: {
    ssr: true,
    target: "esnext",
    rolldownOptions: { input: { index: entry }, external: ["cloudflare:workers"] },
  },
  fmt: { ignorePatterns: ["pnpm-lock.yaml", "dist/**", "tmp/**"] },
  lint: {
    ignorePatterns: ["dist/**", "tmp/**"],
    options: { typeAware: true, typeCheck: true },
  },
  test: { include: ["src/**/*.test.ts", "tests/**/*.test.ts"] },
});
