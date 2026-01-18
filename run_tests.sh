#!/bin/bash
export PATH="$HOME/.cargo/bin:/home/tetsuo/.local/share/solana/install/active_release/bin:$PATH"
cd /home/tetsuo/git/AgenC
anchor test
