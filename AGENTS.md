# Nix Cache contributor guidance

This file is for contributors and maintainers.
Read [README.md](README.md) for user setup and operational limits.

## Scope and commands

This project is one Alchemy Stack with a read-only Effect HTTP Worker and a private R2 bucket.
Publishers upload directly through the R2 S3 API.
Do not add a Worker S3 gateway or SigV4 verification without an explicit requirement.
Keep resource declarations in `alchemy.run.ts` and `src/entry.workers.ts`.
Keep the request implementation in `src/cache.ts` and runtime checks in `tests/`.
Do not modify sibling projects as part of this application's work.

Use the official Vite+ CLI and project-managed JavaScript tools.
Use `vp env install`, `vp env current`, and `vp install --frozen-lockfile` from the repository root.
Use the library-template Nix development shell for Nix tooling and formatting only.
Do not provision Vite+, Node.js, or pnpm through Nix.
Use `vp run dev`, `vp run check`, `vp run test`, and `vp run ci` for the configured tasks.
Keep task orchestration in `vite.config.ts` as the single entry point.
Do not duplicate task graphs in package scripts or independent orchestration scripts.
Keep small runtime adapters separate only when the task runner cannot express their behavior.

Follow the template CI policy: one `check` job on the standard GitHub-hosted `ubuntu-latest` runner for pull requests and pushes to `main`.
Assume a public repository and stay within free GitHub Actions execution.
Do not add an OS or CPU matrix, larger runners, deployment, or paid external services without an explicit requirement.
Use the template's shared Nix and TypeScript setup actions.
Prepare the `ci` development shell with the shared Nix action, load it with `nix print-dev-env`, and run `vp run ci`.
Keep the template Node pin, pnpm version, Vite+ catalog, strict TypeScript presets, and formatter/linter settings aligned.

## Effect-first implementation

Write Effect programs, not imperative TypeScript enclosed in Effect wrappers.
Use Effect Array, String, Record, Match, Schema, Clock, and collection APIs instead of equivalent JavaScript standard APIs.
Use Effect HTTP for routing and responses and Effect HttpClient for outbound HTTP.
Use Schema codecs at configuration and transport boundaries.
Keep domain values separate from their wire representations.
Use an existing parser or codec before writing a custom parser.
Do not validate URLs with regular expressions.
Use a regular expression only when no suitable API or simple string operation fits, and explain the specific reason beside the expression.
Use a simple `if` when clearer, but do not add `for` loops or `switch` statements.
Name non-obvious numeric constants in their owning module.
Represent distinct execution states with tagged unions rather than optional-property combinations.
Compose Context services and Layers at entry points.
Select infrastructure-specific dependencies at the final composition boundary.
Do not branch on development flags, deployment stages, or infrastructure phases in request authorization or feature logic.

Native Request, Response, Promise, URL, stream, crypto, and Cloudflare binding interfaces are permitted only in the smallest adapters required by the runtime or a typed library.
Document why each native interoperability boundary is necessary and keep feature logic outside it.
This policy defines the implementation target, not a claim that all existing standard API usage has already been removed.

## Security and validation

Authenticate before every cache lookup, including warm-cache requests.
Keep R2 write credentials, Nix signing secrets, and HTTP reader credentials separate.
Preserve Nix signature verification and the private response cache policy.
Treat Alchemy state and credential files as secrets, not only values displayed as Redacted.
Do not deploy, change remote resources, or publish artifacts without operator authorization.
Stop on missing authentication or permissions.

Test observable behavior with workerd, local R2, and real Nix where the boundary requires them.
Cover authentication, warm-cache isolation, conditional requests, ranges, malformed input, streaming, and failure responses when those paths change.
Include compiled Worker checks in the normal test task.
Do not equate local fixture tests or derivation evaluation with a deployed cloud roundtrip or a native Linux build.
Keep maintained documentation and regression tests in Git.
Keep temporary output under ignored `tmp/` and exclude credentials and generated artifacts from commits.
