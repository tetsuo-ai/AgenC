# AgenC Privacy Integration Build Commands

# Default recipe
default:
    @just --list

# Install all dependencies
install:
    @echo "Installing Noir..."
    noirup -v 1.0.0-beta.13
    @echo "Installing Sunspot..."
    cd ~ && git clone https://github.com/reilabs/sunspot.git || true
    cd ~/sunspot/go && go build -o sunspot .
    @echo "Add to PATH: export PATH=\"$HOME/sunspot/go:$PATH\""

# Test the Noir circuit
test-circuit:
    cd circuits/task_completion && nargo test

# Compile the Noir circuit to ACIR
compile-circuit:
    cd circuits/task_completion && nargo compile

# Execute circuit with test inputs (generates witness)
execute-circuit:
    cd circuits/task_completion && nargo execute

# Full proof generation pipeline
prove: compile-circuit
    @echo "Converting ACIR to Gnark constraint system..."
    cd circuits/task_completion && sunspot compile target/task_completion.json -o target/task_completion.ccs
    @echo "Running trusted setup..."
    cd circuits/task_completion && sunspot setup target/task_completion.ccs -o target/
    @echo "Generating proof..."
    cd circuits/task_completion && sunspot prove target/task_completion.ccs target/task_completion.pk target/task_completion.gz -o target/task_completion.proof

# Build Solana verifier program
build-verifier: prove
    @echo "Building Solana verifier..."
    cd circuits/task_completion && sunspot deploy target/task_completion.vk -o target/verifier.so

# Deploy verifier to devnet
deploy-verifier: build-verifier
    @echo "Deploying to devnet..."
    solana program deploy circuits/task_completion/target/verifier.so --url devnet

# Run all circuit tests and build
all: test-circuit prove build-verifier
    @echo "Circuit ready for integration"

# Clean build artifacts
clean:
    rm -rf circuits/task_completion/target

# Build Anchor program
build-anchor:
    cd programs/agenc-coordination && anchor build

# Test Anchor program
test-anchor:
    anchor test

# Deploy Anchor program to devnet
deploy-anchor:
    anchor deploy --provider.cluster devnet

# Full integration test
integration-test: test-circuit test-anchor
    @echo "Running integration tests..."
    npx ts-node tests/privacy_integration.ts
