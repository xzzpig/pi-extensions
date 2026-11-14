{
  description = "Reproducible development shell for pi extensions.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          isLinux = pkgs.stdenv.hostPlatform.isLinux;
          # The release gate builds sandbox-runtime's ignored apply-seccomp helper
          # with `gcc -static ... -lseccomp`. A NixOS host glibc is dynamic-only,
          # so that link needs a static libc and a static libseccomp on the
          # compiler's search path: the static package set is where both live
          # (headers in `.dev`, `libseccomp.a` in `.lib`, `libc.a` in
          # glibc.static). It exists only for Linux, hence the optionalAttrs;
          # CI installs libseccomp-dev instead and needs none of this.
          staticLibseccomp = pkgs.pkgsStatic.libseccomp;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.asciinema
              pkgs.git
              pkgs.jq
              pkgs.nodejs_24
              pkgs.pnpm
            ] ++ pkgs.lib.optionals isLinux [
              # Sandbox runtime gate: seccomp helper build, bwrap/socat/ripgrep
              # and python for the suite that scripts/ci-sandbox-setup.sh drives
              # on CI.
              pkgs.binutils
              pkgs.bubblewrap
              pkgs.bun
              pkgs.gcc
              pkgs.python3
              pkgs.ripgrep
              pkgs.socat
            ];

            env = pkgs.lib.optionalAttrs isLinux {
              CPATH = "${staticLibseccomp.dev}/include";
              LIBRARY_PATH = "${staticLibseccomp.lib}/lib:${pkgs.glibc.static}/lib";
            };

            shellHook = ''
              export PI_EXTENSIONS_ROOT="$PWD"
            '';
          };
        }
      );
    };
}
