import { localState, Stack } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import workerLayer, { Worker } from "./src/entry.workers";

export default Stack(
  "nix-cache",
  { state: localState(), providers: Cloudflare.providers() },
  Effect.gen(function* () {
    const worker = yield* Worker.pipe(Effect.provide(workerLayer));
    return { url: worker.url };
  }),
);
