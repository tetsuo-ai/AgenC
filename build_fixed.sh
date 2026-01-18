#!/bin/bash
set -e
export PATH="/home/tetsuo/.cargo/bin:/home/tetsuo/.local/share/solana/install/active_release/bin:$PATH"
export SBF_SDK_PATH="/home/tetsuo/.local/share/solana/install/active_release/bin/platform-tools-sdk/sbf"
export CARGO_BUILD_SBF_RUSTFLAGS=""
cd /home/tetsuo/git/AgenC

# Link the toolchain with a valid name
rustup toolchain link solana-sbf /home/tetsuo/.cache/solana/v1.51/platform-tools/rust/ 2>/dev/null || true

# Try with RUSTUP_TOOLCHAIN override
export RUSTUP_TOOLCHAIN=solana-sbf
cargo build --release --target sbf-solana-solana
