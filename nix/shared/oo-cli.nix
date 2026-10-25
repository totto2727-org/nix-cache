{
  lib,
  bun2nix,
  fetchFromGitHub,
}:
let
  version = "1.9.8";
in
bun2nix.mkDerivation {
  pname = "oo";
  inherit version;
  src = fetchFromGitHub {
    owner = "oomol-lab";
    repo = "oo-cli";
    rev = "v${version}";
    hash = "sha256-rLwndZ4faA3F14BDIz7KkRVzFGCtJZLrrltzqbKWTJA=";
  };
  module = "index.ts";
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./oo-cli-bun.nix;
  };
  extraBunBuildFlags = [
    "--format=esm"
    "--no-compile-autoload-dotenv"
    "--no-compile-autoload-bunfig"
    "--define"
    ''BUILD_VERSION="${version}"''
  ];
  meta = {
    description = "OOMOL CLI for hosted capabilities and connected accounts";
    homepage = "https://github.com/oomol-lab/oo-cli";
    license = lib.licenses.mit;
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ];
  };
}
