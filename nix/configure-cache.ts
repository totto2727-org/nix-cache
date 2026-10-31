import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Array,
  Config,
  Console,
  Data,
  Effect,
  FileSystem,
  Path,
  Redacted,
  Schema,
  String,
} from "effect";

class CacheConfigurationError extends Data.TaggedError("CacheConfigurationError")<{
  readonly message: string;
}> {}

const reject = (message: string) => Effect.fail(new CacheConfigurationError({ message }));
const setting = (name: string) => Config.String(name).pipe(Config.withDefault(""));
const secret = (name: string) => Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")));

// Nix config values and unquoted netrc tokens must not contain separators or
// controls. String.trim also recognizes Unicode whitespace without a DNS regex.
const singleToken = (value: string) =>
  value !== "" &&
  Array.every(
    String.split(value, ""),
    (character) => character > " " && character !== "\u007f" && String.trim(character) !== "",
  );
const configToken = (value: string) =>
  singleToken(value) && !String.includes("#")(value) && !String.includes("\\")(value);
const netrcToken = (value: string) => configToken(value) && !String.includes('"')(value);

const configure = Effect.gen(function* () {
  const rawUrl = yield* setting("CACHE_URL");
  const publicKey = yield* setting("CACHE_PUBLIC_KEY");
  const username = yield* secret("CACHE_USERNAME");
  const password = yield* secret("CACHE_PASSWORD");
  const login = Redacted.value(username);
  const credential = Redacted.value(password);
  const authenticated = login !== "" || credential !== "";

  if (rawUrl === "" && publicKey === "" && !authenticated) return;
  if (rawUrl === "" || publicKey === "") {
    return yield* reject("Set both CACHE_URL and CACHE_PUBLIC_KEY.");
  }
  if (!singleToken(rawUrl) || !configToken(publicKey)) {
    return yield* reject("Cache settings must be single safe configuration tokens.");
  }
  // Schema owns URL parsing. The returned platform URL is the sole source of
  // normalized serialization and hostname, including bracketed IPv6 literals.
  const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(rawUrl).pipe(
    Effect.mapError(
      () => new CacheConfigurationError({ message: "CACHE_URL must be a valid HTTPS URL." }),
    ),
  );
  if (
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    String.includes("?")(rawUrl) ||
    String.includes("#")(rawUrl)
  ) {
    return yield* reject("CACHE_URL must use HTTPS without credentials, query, or fragment.");
  }
  if (!configToken(url.href)) {
    return yield* reject("CACHE_URL must not contain unsafe configuration text.");
  }
  if (authenticated && (login === "" || credential === "")) {
    return yield* reject("Cache authentication requires both reader credentials.");
  }
  if (
    authenticated &&
    (!netrcToken(login) || !netrcToken(credential) || String.includes(":")(login))
  ) {
    return yield* reject(
      "Cache credentials must be safe netrc tokens and username must not contain a colon.",
    );
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runnerTemp = yield* setting("RUNNER_TEMP");
  // Validate the actual resolved path before any write. Its value is serialized
  // into nix.conf, unlike the location of nix.conf itself.
  const temp = path.resolve(runnerTemp);
  if (authenticated) {
    if (runnerTemp === "" || !configToken(temp)) {
      return yield* reject(
        "RUNNER_TEMP must be an existing directory with a safe configuration path.",
      );
    }
    const info = yield* fs
      .stat(temp)
      .pipe(
        Effect.mapError(
          () =>
            new CacheConfigurationError({ message: "RUNNER_TEMP must be an existing directory." }),
        ),
      );
    if (info.type !== "Directory")
      return yield* reject("RUNNER_TEMP must be an existing directory.");
  }
  const xdg = yield* setting("XDG_CONFIG_HOME");
  const home = yield* setting("HOME");
  if (xdg === "" && home === "")
    return yield* reject("Set XDG_CONFIG_HOME or HOME for Nix configuration.");
  const directory = path.join(xdg === "" ? path.join(home, ".config") : xdg, "nix");
  const config = path.join(directory, "nix.conf");
  yield* fs.makeDirectory(directory, { recursive: true });
  const publicConfig = `\nextra-substituters = ${url.href}\nextra-trusted-public-keys = ${publicKey}\n`;
  if (!authenticated) return yield* fs.writeFileString(config, publicConfig, { flag: "a" });

  // libcurl netrc machine names omit IPv6 brackets. URL parsing has already
  // validated the literal, so this is serialization, not hostname validation.
  const machine =
    String.startsWith("[")(url.hostname) && String.endsWith("]")(url.hostname)
      ? String.slice(1, -1)(url.hostname)
      : url.hostname;
  // mkdtemp creates a unique private directory. Exclusive creation (wx) rejects
  // a pre-existing file or symlink and sets 0600 before any secret is written.
  const owned = yield* fs.makeTempDirectory({ directory: temp, prefix: "nix-cache." });
  const netrc = path.join(owned, "netrc");
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(
      netrc,
      `machine ${machine}\nlogin ${login}\npassword ${credential}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    yield* fs.writeFileString(config, `\nnetrc-file = ${netrc}\n${publicConfig}`, { flag: "a" });
  }).pipe(Effect.onError(() => fs.remove(owned, { recursive: true }).pipe(Effect.ignore)));
});

// Only safe authored messages cross the CLI boundary. Do not print platform or
// configuration causes, which can contain credential values or sensitive paths.
const main = configure.pipe(
  Effect.catchTag("CacheConfigurationError", (error) =>
    Console.error(error.message).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
  Effect.catchCause(() =>
    Console.error("Could not configure the Nix cache.").pipe(
      // process.exitCode is the unavoidable Node CLI status interoperability.
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
  Effect.provide(NodeServices.layer),
);
NodeRuntime.runMain(main, { disableErrorReporting: true });
