#!/bin/bash
export PATH="/home/tetsuo/.avm/bin:/home/tetsuo/.cargo/bin:/home/tetsuo/.local/share/solana/install/active_release/bin:$PATH"
cd /home/tetsuo/git/AgenC
rm -rf test-ledger 2>/dev/null
anchor test --skip-build 2>&1
