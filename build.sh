#!/bin/bash
set -e
export PATH="/home/tetsuo/.cargo/bin:/home/tetsuo/.local/share/solana/install/active_release/bin:$PATH"
cd /home/tetsuo/git/AgenC
echo "Using:"
solana --version
anchor --version
echo "Building..."
anchor build
