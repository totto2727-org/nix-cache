{
  description = "Native validation of the monorepo shared CLI overlay";

  # Verbatim upstream snapshot, provenance in ../docs/nix-validation.md.
  inputs.shared.url = "path:./shared";

  outputs = { shared, ... }: {
    # Reuse the upstream package set and its lock without replacing dependencies.
    packages = builtins.mapAttrs (_: packages: {
      inherit (packages) pass-cli monid oo-cli;
    }) shared.packages;
    overlays.default = shared.overlays.default;
  };
}
