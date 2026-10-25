{
  description = "Locally packaged applications not available in nixpkgs";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      bun2nix,
    }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      overlays.default = final: _prev: {
        monid = final.callPackage ./monid.nix {
          bun2nix = bun2nix.packages.${final.stdenv.buildPlatform.system}.default;
        };
        oo-cli = final.callPackage ./oo-cli.nix {
          bun2nix = bun2nix.packages.${final.stdenv.buildPlatform.system}.default;
        };
        pass-cli = final.callPackage ./pass-cli.nix { };
      };

      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ self.overlays.default ];
          };
        in
        {
          inherit (pkgs) monid oo-cli pass-cli;
          inherit (bun2nix.packages.${system}) bun2nix;
        }
      );
    };
}
