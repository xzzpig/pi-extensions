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
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.git
              pkgs.jq
              pkgs.nodejs_24
              pkgs.pnpm
            ];

            shellHook = ''
              export PI_EXTENSIONS_ROOT="$PWD"
            '';
          };
        }
      );
    };
}
