#!/bin/bash
export PATH="/home/tetsuo/.cargo/bin:/home/tetsuo/.local/share/solana/install/active_release/bin:$PATH"
cd /home/tetsuo/git/AgenC
rm -rf test-ledger 2>/dev/null

# Temporarily modify Anchor.toml to run only the focused test
cp Anchor.toml Anchor.toml.bak
sed -i 's|tests/\*\*/\*.ts|tests/complete_task_private.ts|' Anchor.toml

# Run the test
anchor test --skip-build
RESULT=$?

# Restore original Anchor.toml
mv Anchor.toml.bak Anchor.toml

exit $RESULT
