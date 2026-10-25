{
  lib,
  buildGoModule,
  fetchFromGitHub,
}:
let
  version = "0.20.0";
  rev = "f42ade35716d6faa4ebeea1c426a307d386a2b77";
in
buildGoModule {
  pname = "pass-cli";
  inherit version;

  src = fetchFromGitHub {
    owner = "reyamira";
    repo = "pass-cli";
    rev = "v${version}";
    hash = "sha256-1kDKxToQJrWc9VYjaVH0ow10ccUE+VHG0NfsCyanrKQ=";
  };

  vendorHash = "sha256-+EjavJi8uNIjcDaTEZpmR7ssZQ17HLv3HdoOGXzzGzA=";

  env.CGO_ENABLED = "0";
  subPackages = [ "." ];
  tags = [ "netgo" ];
  ldflags = [
    "-s"
    "-w"
    "-X=github.com/arimxyer/pass-cli/cmd.version=${version}"
    "-X=github.com/arimxyer/pass-cli/cmd.commit=${builtins.substring 0 7 rev}"
    "-X=github.com/arimxyer/pass-cli/cmd.date=2026-07-02T04:23:34Z"
  ];

  preCheck = ''
    export CI=true
    export HOME="$TMPDIR"
  '';

  meta = {
    description = "Secure, cross-platform CLI password and API key manager for developers";
    homepage = "https://github.com/reyamira/pass-cli";
    changelog = "https://github.com/reyamira/pass-cli/blob/v${version}/CHANGELOG.md";
    license = lib.licenses.mit;
    mainProgram = "pass-cli";
    platforms = lib.platforms.linux ++ [ "aarch64-darwin" ];
  };
}
