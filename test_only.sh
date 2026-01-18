#!/bin/bash
set -e
export PATH="/home/tetsuo/.cargo/bin:/home/tetsuo/.local/share/solana/install/active_release/bin:$PATH"
cd /home/tetsuo/git/AgenC

# Start fresh validator
pkill -f solana-test-validator 2>/dev/null || true
rm -rf test-ledger
sleep 2

# Start validator with the program
solana-test-validator \
  --bpf-program EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ target/deploy/agenc_coordination.so \
  --reset \
  --quiet &

VPID=$!
echo "Validator PID: $VPID"

# Wait for startup
sleep 10

# Configure solana
solana config set --url http://localhost:8899

# Create wallet if needed
if [ ! -f ~/.config/solana/id.json ]; then
    solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json
fi

# Airdrop
solana airdrop 100

# Run tests
npm test

# Cleanup
kill $VPID 2>/dev/null || true
