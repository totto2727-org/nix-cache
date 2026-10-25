{
  description = "Private Nix cache Worker development environment";

  inputs.nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
    in
    {
      devShells = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          manifest = builtins.fromJSON (builtins.readFile ./package.json);
        in
        {
          default =
            assert manifest.packageManager == "pnpm@${pkgs.pnpm.version}";
            pkgs.mkShell {
              packages = [
                pkgs.nodejs_24
                pkgs.pnpm
              ];
            };
        }
      );
    };
}
