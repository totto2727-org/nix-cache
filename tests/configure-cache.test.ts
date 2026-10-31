import type { NodeServices } from "@effect/platform-node/NodeServices";
import { Array, Effect, FileSystem, Path, String } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { command, runTest } from "./support";

const reader = { CACHE_USERNAME: "fixture-reader", CACHE_PASSWORD: "fixture-secret" };
const configured = {
  CACHE_URL: "https://cache.example.test",
  CACHE_PUBLIC_KEY: "opaque:not-a-nix-key",
};

interface Fixture {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly root: string;
  readonly runner: string;
  readonly config: string;
  readonly run: (
    settings?: Readonly<Record<string, string>>,
    trace?: boolean,
  ) => Effect.Effect<
    {
      readonly status: number;
      readonly stdout: string;
      readonly stderr: string;
    },
    unknown,
    NodeServices
  >;
}

const withFixture = (test: (fixture: Fixture) => Effect.Effect<void, unknown, NodeServices>) =>
  runTest(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = path.resolve("tmp");
      yield* fs.makeDirectory(temporary, { recursive: true });
      const root = yield* fs.makeTempDirectoryScoped({
        directory: temporary,
        prefix: "configure-cache-test.",
      });
      const runner = path.join(root, "runner");
      yield* fs.makeDirectory(runner);
      const config = path.join(root, "config", "nix", "nix.conf");
      yield* test({
        fs,
        path,
        root,
        runner,
        config,
        run: (settings = {}, trace = false) =>
          command("bash", [...(trace ? ["-x"] : []), "nix/configure-cache.sh"], {
            extendEnv: false,
            env: {
              // process.execPath selects the actual Node24 runtime used by Vitest.
              // The shell needs its directory in POSIX PATH, not ambient secrets.
              PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
              HOME: root,
              XDG_CONFIG_HOME: path.join(root, "config"),
              RUNNER_TEMP: runner,
              ...settings,
            },
          }).pipe(
            Effect.map(({ exitCode, stdout, stderr }) => ({ status: exitCode, stdout, stderr })),
            Effect.timeout("15 seconds"),
          ),
      });
    }),
  );

const expectNoSecrets = (output: { stdout: string; stderr: string }) => {
  expect(output.stdout).toBe("");
  expect(output.stderr).not.toContain(reader.CACHE_USERNAME);
  expect(output.stderr).not.toContain(reader.CACHE_PASSWORD);
};

describe("Nix cache configuration CLI", () => {
  it("leaves an empty configuration untouched", () =>
    withFixture(({ fs, root, run }) =>
      Effect.gen(function* () {
        expect(yield* run()).toEqual({ status: 0, stdout: "", stderr: "" });
        expect(yield* fs.readDirectory(root)).toEqual(["runner"]);
      }),
    ));

  it.each([
    [
      "uppercase host and default port",
      "HTTPS://CACHE.Example.Test:443/a/../prefix",
      "https://cache.example.test/prefix",
    ],
    ["implicit root path", "https://cache.example.test", "https://cache.example.test/"],
    [
      "IPv6 and nondefault port",
      "https://[2001:db8::1]:8443/prefix",
      "https://[2001:db8::1]:8443/prefix",
    ],
    ["encoded path", "https://cache.example.test/a%20b", "https://cache.example.test/a%20b"],
    ["empty userinfo", "https://@cache.example.test", "https://cache.example.test/"],
    [
      "at sign in path",
      "https://cache.example.test/releases@2026",
      "https://cache.example.test/releases@2026",
    ],
    [
      "backslash normalization",
      "https://cache.example.test/prefix\\child",
      "https://cache.example.test/prefix/child",
    ],
  ])("uses the parsed normalized URL: %s", (_name, url, normalized) =>
    withFixture(({ fs, config, runner, run }) =>
      Effect.gen(function* () {
        const result = yield* run({ ...configured, CACHE_URL: url });
        expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
        expect(yield* fs.readFileString(config)).toBe(
          `\nextra-substituters = ${normalized}\nextra-trusted-public-keys = ${configured.CACHE_PUBLIC_KEY}\n`,
        );
        expect(yield* fs.readDirectory(runner)).toEqual([]);
      }),
    ),
  );

  const invalid: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
    ["URL without key", { CACHE_URL: configured.CACHE_URL }],
    ["key without URL", { CACHE_PUBLIC_KEY: configured.CACHE_PUBLIC_KEY }],
    ["invalid syntax", { ...configured, CACHE_URL: "https://[invalid" }],
    ["invalid port", { ...configured, CACHE_URL: "https://cache.example.test:99999" }],
    ["HTTP", { ...configured, CACHE_URL: "http://cache.example.test" }],
    [
      "URL credentials",
      { ...configured, CACHE_URL: "https://fixture-reader:fixture-secret@cache.example.test" },
    ],
    ["query", { ...configured, CACHE_URL: "https://cache.example.test?token=fixture-secret" }],
    ["empty query", { ...configured, CACHE_URL: "https://cache.example.test?" }],
    ["fragment", { ...configured, CACHE_URL: "https://cache.example.test#fixture-secret" }],
    ["URL newline", { ...configured, CACHE_URL: "https://cache.example.test\nrequire-sigs=false" }],
    [
      "URL carriage return",
      { ...configured, CACHE_URL: "https://cache.example.test\rrequire-sigs=false" },
    ],
    ["URL tab normalized by parser", { ...configured, CACHE_URL: "https://cache.ex\tample.test" }],
    ["key newline", { ...configured, CACHE_PUBLIC_KEY: "opaque:key\nrequire-sigs = false" }],
    ["key comment", { ...configured, CACHE_PUBLIC_KEY: "opaque:key#comment" }],
    ["key line continuation", { ...configured, CACHE_PUBLIC_KEY: "opaque:key\\" }],
    ["password without username", { ...configured, CACHE_PASSWORD: reader.CACHE_PASSWORD }],
    ["username without password", { ...configured, CACHE_USERNAME: reader.CACHE_USERNAME }],
    ["reader without cache", reader],
    ["username newline", { ...configured, ...reader, CACHE_USERNAME: "reader\nother" }],
    ["username colon", { ...configured, ...reader, CACHE_USERNAME: "reader:other" }],
    ["password newline", { ...configured, ...reader, CACHE_PASSWORD: "fixture-secret\nother" }],
    ["password tab", { ...configured, ...reader, CACHE_PASSWORD: "fixture-secret\tother" }],
    ["password quote", { ...configured, ...reader, CACHE_PASSWORD: 'fixture-secret"other' }],
    ["password comment", { ...configured, ...reader, CACHE_PASSWORD: "#fixture-secret" }],
    ["password backslash", { ...configured, ...reader, CACHE_PASSWORD: "fixture-secret\\other" }],
    ["missing temp directory setting", { ...configured, ...reader, RUNNER_TEMP: "" }],
    ["missing config location", { ...configured, HOME: "", XDG_CONFIG_HOME: "" }],
  ];
  it.each(invalid)(
    "rejects %s before filesystem changes without exposing secrets",
    (_name, settings) =>
      withFixture(({ fs, root, runner, run }) =>
        Effect.gen(function* () {
          const result = yield* run(settings, true);
          expect(result.status).toBe(1);
          expectNoSecrets(result);
          expect(yield* fs.readDirectory(root)).toEqual(["runner"]);
          expect(yield* fs.readDirectory(runner)).toEqual([]);
        }),
      ),
  );

  it.each(["missing", "file", "newline", "comment", "space"])(
    "rejects a %s runner temp path before creating config",
    (kind) =>
      withFixture(({ fs, path, root, run }) =>
        Effect.gen(function* () {
          const temp = path.join(
            root,
            kind === "newline"
              ? "bad\npath"
              : kind === "comment"
                ? "bad#path"
                : kind === "space"
                  ? "bad path"
                  : kind,
          );
          if (kind === "file") yield* fs.writeFileString(temp, "not a directory");
          else if (kind !== "missing") yield* fs.makeDirectory(temp);
          const before = yield* fs.readDirectory(root);
          const result = yield* run({ ...configured, ...reader, RUNNER_TEMP: temp });
          expect(result.status).toBe(1);
          expectNoSecrets(result);
          expect(yield* fs.readDirectory(root)).toEqual(before);
        }),
      ),
  );

  it.each([
    ["DNS", "https://CACHE.example.test:443/prefix", "cache.example.test"],
    ["IPv6", "https://[2001:db8::1]:8443/prefix", "2001:db8::1"],
  ])(
    "writes unique private netrc files using parsed %s hostname and hides secrets even under bash -x",
    (_name, url, host) =>
      withFixture(({ fs, path, config, runner, run }) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(config), { recursive: true });
          const existing =
            "substituters = https://cache.nixos.org/\ntrusted-public-keys = public:key\nrequire-sigs = true\n";
          yield* fs.writeFileString(config, existing);
          const result = yield* run({ ...configured, ...reader, CACHE_URL: url }, true);
          expect(result.status).toBe(0);
          expectNoSecrets(result);
          const contents = yield* fs.readFileString(config);
          expect(contents).toContain(existing);
          expect(contents).not.toContain(reader.CACHE_USERNAME);
          expect(contents).not.toContain(reader.CACHE_PASSWORD);
          expect(contents).not.toContain("require-sigs = false");
          const line = Array.findFirst(
            String.split(contents, "\n"),
            String.startsWith("netrc-file = "),
          );
          expect(line).toMatchObject({ _tag: "Some" });
          if (line._tag !== "Some") return;
          const netrc = String.slice("netrc-file = ".length)(line.value);
          expect(path.relative(runner, netrc)).not.toContain("..");
          expect((yield* fs.stat(netrc)).mode & 0o777).toBe(0o600);
          expect((yield* fs.stat(path.dirname(netrc))).mode & 0o777).toBe(0o700);
          expect((yield* fs.lstat(netrc)).type).toBe("File");
          expect(yield* fs.readFileString(netrc)).toBe(
            `machine ${host}\nlogin ${reader.CACHE_USERNAME}\npassword ${reader.CACHE_PASSWORD}\n`,
          );
          const second = yield* run({ ...configured, ...reader });
          expect(second.status).toBe(0);
          expect(yield* fs.readDirectory(runner)).toHaveLength(2);
        }),
      ),
  );

  it("removes only its own credential artifacts when config writing fails", () =>
    withFixture(({ fs, path, config, runner, run }) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(config, { recursive: true });
        const unrelated = path.join(runner, "unrelated");
        yield* fs.writeFileString(unrelated, "keep me");
        const result = yield* run({ ...configured, ...reader }, true);
        expect(result.status).toBe(1);
        expectNoSecrets(result);
        expect(yield* fs.readDirectory(runner)).toEqual(["unrelated"]);
        expect(yield* fs.readFileString(unrelated)).toBe("keep me");
        expect((yield* fs.stat(config)).type).toBe("Directory");
      }),
    ));

  it("uses HOME when XDG_CONFIG_HOME is empty", () =>
    withFixture(({ fs, path, root, run }) =>
      Effect.gen(function* () {
        expect((yield* run({ ...configured, XDG_CONFIG_HOME: "" })).status).toBe(0);
        expect(yield* fs.readFileString(path.join(root, ".config", "nix", "nix.conf"))).toContain(
          "extra-substituters = https://cache.example.test/",
        );
      }),
    ));
});
