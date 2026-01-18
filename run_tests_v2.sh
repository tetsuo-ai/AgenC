#!/bin/bash
export PATH="/home/tetsuo/.cargo/bin:/home/tetsuo/.local/share/solana/install/active_release/bin:$PATH"
cd /home/tetsuo/git/AgenC
rm -rf test-ledger 2>/dev/null
# Only skip build, but let anchor deploy the program
anchor test --skip-build 2>&1
