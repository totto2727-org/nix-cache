{
  lib,
  bun2nix,
  fetchFromGitHub,
}:
let
  version = "0.1.7";
in
bun2nix.mkDerivation {
  pname = "monid";
  inherit version;
  src = fetchFromGitHub {
    owner = "monid-ai";
    repo = "cli";
    rev = "v${version}";
    hash = "sha256-RW709N7sWfkitoTRP5WvWbVAsaQOOnLQ0khXaYF+Xm4=";
  };
  module = "src/index.ts";
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./monid-bun.nix;
  };
  extraBunBuildFlags = [
    "--format=esm"
    "--no-compile-autoload-dotenv"
    "--no-compile-autoload-bunfig"
    "--define"
    ''__PKG_VERSION__="${version}"''
  ];
  meta = {
    description = "Discover, inspect, and run Monid data endpoints";
    homepage = "https://github.com/monid-ai/cli";
    license = lib.licenses.mit;
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ];
  };
}
