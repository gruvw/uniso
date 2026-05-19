{
  description = "RP2040 Rust dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
  };

  outputs = { self, nixpkgs, rust-overlay }:
    let
      system = "x86_64-linux";

      pkgs = import nixpkgs {
        inherit system;
        overlays = [ (import rust-overlay) ];
      };

      rust = pkgs.rust-bin.stable.latest.default.override {
        targets = [ "thumbv6m-none-eabi" ];
      };

    in {
      devShells.${system}.default = pkgs.mkShell {
        buildInputs = [
          rust
          pkgs.probe-rs
          pkgs.flip-link
          pkgs.pkg-config
        ];

        shellHook = ''
          echo "Embassy RP2040 environment ready"
        '';
      };
    };
}
