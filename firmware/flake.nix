{
  description = "RP2040 Rust Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
  };

  outputs = { self, nixpkgs, rust-overlay }:
    let
      system = "x86_64-linux";
      overlays = [ (import rust-overlay) ];
      pkgs = import nixpkgs { inherit system overlays; };

      rust-toolchain = pkgs.rust-bin.stable.latest.default.override {
        extensions = [ "rust-src" "rust-analyzer" ];
        targets = [ "thumbv8m.main-none-eabihf" ];
      };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        buildInputs = [
          rust-toolchain
          pkgs.flip-link
          pkgs.picotool    # Replaces elf2uf2-rs
          pkgs.pkg-config  # Needed for USB compilation helpers
          pkgs.libusb1     # USB library
          pkgs.probe-rs-tools
        ];
      };
    };
}
