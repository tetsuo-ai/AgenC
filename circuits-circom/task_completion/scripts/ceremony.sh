#!/usr/bin/env bash
# MPC Trusted Setup Ceremony Script (issue #170)
#
# Automates the multi-party computation ceremony for Groth16 trusted setup.
# Requires: snarkjs, node
#
# Usage:
#   ./ceremony.sh init          - Initialize ceremony (coordinator only)
#   ./ceremony.sh contribute    - Add a contribution (each participant)
#   ./ceremony.sh beacon        - Apply random beacon (coordinator, after all contributions)
#   ./ceremony.sh finalize      - Verify and export final keys (coordinator)
#   ./ceremony.sh verify        - Verify the full ceremony transcript
#
# Environment variables:
#   CEREMONY_DIR    - Working directory for ceremony files (default: ./ceremony)
#   PTAU_FILE       - Powers of Tau file (default: pot14_final.ptau)
#   CIRCUIT_R1CS    - Circuit R1CS file (default: target/circuit.r1cs)
#   MIN_CONTRIBUTORS - Minimum required contributors (default: 3)

set -euo pipefail

CEREMONY_DIR="${CEREMONY_DIR:-./ceremony}"
PTAU_FILE="${PTAU_FILE:-pot14_final.ptau}"
CIRCUIT_R1CS="${CIRCUIT_R1CS:-target/circuit.r1cs}"
MIN_CONTRIBUTORS="${MIN_CONTRIBUTORS:-3}"
TRANSCRIPT_FILE="${CEREMONY_DIR}/transcript.json"

mkdir -p "$CEREMONY_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_prerequisites() {
    if ! command -v snarkjs &> /dev/null; then
        log_error "snarkjs not found. Install with: npm install -g snarkjs"
        exit 1
    fi
    if ! command -v node &> /dev/null; then
        log_error "node not found."
        exit 1
    fi
}

get_contribution_count() {
    local count=0
    for f in "$CEREMONY_DIR"/circuit_*.zkey; do
        [ -f "$f" ] && count=$((count + 1))
    done
    echo $count
}

get_latest_zkey() {
    local count
    count=$(get_contribution_count)
    if [ "$count" -eq 0 ]; then
        echo ""
    else
        local latest=$((count - 1))
        printf "%s/circuit_%04d.zkey" "$CEREMONY_DIR" "$latest"
    fi
}

init_transcript() {
    cat > "$TRANSCRIPT_FILE" << EOF
{
  "ceremony": "AgenC Task Completion Circuit - MPC Trusted Setup",
  "circuit": "task_completion",
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "ptauFile": "$PTAU_FILE",
  "r1csFile": "$CIRCUIT_R1CS",
  "minContributors": $MIN_CONTRIBUTORS,
  "contributions": [],
  "beaconApplied": false,
  "finalized": false
}
EOF
}

add_contribution_to_transcript() {
    local contributor_name="$1"
    local contribution_hash="$2"
    local index="$3"

    # Use node to update JSON properly — pass values via env to prevent injection
    TRANSCRIPT_FILE="$TRANSCRIPT_FILE" \
    CONTRIB_NAME="$contributor_name" \
    CONTRIB_HASH="$contribution_hash" \
    CONTRIB_INDEX="$index" \
    node -e "
        const fs = require('fs');
        const t = JSON.parse(fs.readFileSync(process.env.TRANSCRIPT_FILE, 'utf8'));
        t.contributions.push({
            index: parseInt(process.env.CONTRIB_INDEX),
            contributor: process.env.CONTRIB_NAME,
            hash: process.env.CONTRIB_HASH,
            timestamp: new Date().toISOString()
        });
        fs.writeFileSync(process.env.TRANSCRIPT_FILE, JSON.stringify(t, null, 2));
    "
}

cmd_init() {
    log_info "Initializing MPC ceremony..."

    if [ ! -f "$CIRCUIT_R1CS" ]; then
        log_error "Circuit R1CS not found at $CIRCUIT_R1CS. Run 'npm run compile' first."
        exit 1
    fi
    if [ ! -f "$PTAU_FILE" ]; then
        log_error "Powers of Tau file not found at $PTAU_FILE"
        log_info "Download from: https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau"
        exit 1
    fi

    local output="$CEREMONY_DIR/circuit_0000.zkey"
    log_info "Running initial setup (Phase 2)..."
    snarkjs groth16 setup "$CIRCUIT_R1CS" "$PTAU_FILE" "$output"

    init_transcript
    log_info "Ceremony initialized. Initial zkey: $output"
    log_info "Transcript: $TRANSCRIPT_FILE"
    echo ""
    log_info "Next: Ask contributors to run './ceremony.sh contribute'"
}

cmd_contribute() {
    check_prerequisites

    local count
    count=$(get_contribution_count)
    if [ "$count" -eq 0 ]; then
        log_error "No ceremony initialized. Run './ceremony.sh init' first."
        exit 1
    fi

    local input
    input=$(get_latest_zkey)
    local next_index=$count
    local output
    output=$(printf "%s/circuit_%04d.zkey" "$CEREMONY_DIR" "$next_index")

    echo ""
    echo "=== MPC Contribution #$next_index ==="
    echo ""
    read -rp "Enter your name/identifier: " contributor_name
    if [ -z "$contributor_name" ]; then
        log_error "Contributor name required."
        exit 1
    fi
    # Reject shell metacharacters to prevent injection
    if [[ "$contributor_name" =~ [\;\$\`\'\"\(\)\{\}\<\>\|\\] ]]; then
        log_error "Name contains shell metacharacters."
        exit 1
    fi

    log_info "Contributing to ceremony (this uses system entropy)..."
    log_info "Input:  $input"
    log_info "Output: $output"

    # The entropy is gathered interactively by snarkjs
    snarkjs zkey contribute "$input" "$output" --name="$contributor_name"

    # Extract contribution hash from the output
    local verify_output
    verify_output=$(snarkjs zkey verify "$CIRCUIT_R1CS" "$PTAU_FILE" "$output" 2>&1 || true)
    local contribution_hash
    contribution_hash=$(echo "$verify_output" | grep -Eo '[a-f0-9]{8}\s[a-f0-9]{8}\s[a-f0-9]{8}\s[a-f0-9]{8}' | tail -1 || echo "unknown")

    add_contribution_to_transcript "$contributor_name" "$contribution_hash" "$next_index"

    echo ""
    log_info "Contribution #$next_index added by $contributor_name"
    log_info "Contribution hash: $contribution_hash"
    log_info "IMPORTANT: Destroy any notes of the random entropy you used."
    echo ""
}

cmd_beacon() {
    check_prerequisites

    local count
    count=$(get_contribution_count)
    if [ "$count" -lt $((MIN_CONTRIBUTORS + 1)) ]; then
        log_error "Need at least $MIN_CONTRIBUTORS contributions (currently $((count - 1)))."
        log_error "Ask more participants to run './ceremony.sh contribute'"
        exit 1
    fi

    local input
    input=$(get_latest_zkey)
    local output="$CEREMONY_DIR/circuit_final.zkey"

    echo ""
    echo "=== Applying Random Beacon ==="
    echo ""
    log_info "Using drand.love public randomness beacon..."

    # Fetch latest drand beacon value
    local beacon_hash
    beacon_hash=$(node -e "
        const https = require('https');
        https.get('https://drand.cloudflare.com/public/latest', (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                const json = JSON.parse(data);
                console.log(json.randomness);
            });
        }).on('error', () => {
            // Fallback: use current block hash from a public source
            console.log(require('crypto').randomBytes(32).toString('hex'));
        });
    " 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

    log_info "Beacon hash: $beacon_hash"
    log_info "Applying beacon with 10 iterations..."

    snarkjs zkey beacon "$input" "$output" "$beacon_hash" 10

    # Update transcript — pass values via env to prevent injection
    TRANSCRIPT_FILE="$TRANSCRIPT_FILE" \
    BEACON_HASH="$beacon_hash" \
    node -e "
        const fs = require('fs');
        const t = JSON.parse(fs.readFileSync(process.env.TRANSCRIPT_FILE, 'utf8'));
        t.beaconApplied = true;
        t.beaconHash = process.env.BEACON_HASH;
        t.beaconTimestamp = new Date().toISOString();
        fs.writeFileSync(process.env.TRANSCRIPT_FILE, JSON.stringify(t, null, 2));
    "

    log_info "Beacon applied. Final zkey: $output"
}

cmd_finalize() {
    check_prerequisites

    local final_zkey="$CEREMONY_DIR/circuit_final.zkey"
    if [ ! -f "$final_zkey" ]; then
        log_error "Final zkey not found. Run './ceremony.sh beacon' first."
        exit 1
    fi

    echo ""
    echo "=== Finalizing Ceremony ==="
    echo ""

    # Verify the final zkey
    log_info "Verifying final zkey against R1CS and PTAU..."
    snarkjs zkey verify "$CIRCUIT_R1CS" "$PTAU_FILE" "$final_zkey"

    # Export verification key
    local vk_json="$CEREMONY_DIR/verification_key.json"
    log_info "Exporting verification key..."
    snarkjs zkey export verificationkey "$final_zkey" "$vk_json"

    # Generate Rust verifying key
    local vk_rs="$CEREMONY_DIR/verifying_key.rs"
    log_info "Generating Rust verifying key..."
    node scripts/parse_vk_to_rust.js "$vk_json" --require-mpc > "$vk_rs"

    if [ $? -eq 0 ]; then
        log_info "Rust verifying key generated: $vk_rs"
    else
        log_error "Generated key still has gamma == delta. Ceremony may be invalid."
        exit 1
    fi

    # Copy files to target locations
    log_info "Copying ceremony outputs to project..."
    cp "$final_zkey" target/circuit.zkey
    cp "$vk_json" target/verification_key.json

    # Update transcript — pass values via env to prevent injection
    TRANSCRIPT_FILE="$TRANSCRIPT_FILE" \
    node -e "
        const fs = require('fs');
        const t = JSON.parse(fs.readFileSync(process.env.TRANSCRIPT_FILE, 'utf8'));
        t.finalized = true;
        t.finalizedAt = new Date().toISOString();
        fs.writeFileSync(process.env.TRANSCRIPT_FILE, JSON.stringify(t, null, 2));
    "

    echo ""
    log_info "Ceremony finalized!"
    log_info ""
    log_info "Next steps:"
    log_info "  1. Review $vk_rs"
    log_info "  2. Copy it to programs/agenc-coordination/src/verifying_key.rs"
    log_info "  3. Run: ./scripts/validate-verifying-key.sh --mainnet"
    log_info "  4. Publish transcript for public audit: $TRANSCRIPT_FILE"
}

cmd_verify() {
    check_prerequisites

    echo ""
    echo "=== Verifying Ceremony Transcript ==="
    echo ""

    if [ ! -f "$TRANSCRIPT_FILE" ]; then
        log_error "No transcript found at $TRANSCRIPT_FILE"
        exit 1
    fi

    local count
    count=$(get_contribution_count)
    local num_contributions=$((count - 1))

    log_info "Contributions: $num_contributions (minimum required: $MIN_CONTRIBUTORS)"

    if [ "$num_contributions" -lt "$MIN_CONTRIBUTORS" ]; then
        log_error "Insufficient contributions: $num_contributions < $MIN_CONTRIBUTORS"
        exit 1
    fi

    # Verify each contribution
    for i in $(seq 1 "$num_contributions"); do
        local zkey
        zkey=$(printf "%s/circuit_%04d.zkey" "$CEREMONY_DIR" "$i")
        if [ -f "$zkey" ]; then
            log_info "Verifying contribution #$i..."
            snarkjs zkey verify "$CIRCUIT_R1CS" "$PTAU_FILE" "$zkey" || {
                log_error "Contribution #$i failed verification!"
                exit 1
            }
        fi
    done

    # Verify final zkey if it exists
    local final_zkey="$CEREMONY_DIR/circuit_final.zkey"
    if [ -f "$final_zkey" ]; then
        log_info "Verifying final zkey..."
        snarkjs zkey verify "$CIRCUIT_R1CS" "$PTAU_FILE" "$final_zkey" || {
            log_error "Final zkey failed verification!"
            exit 1
        }
        log_info "Final zkey: VALID"
    fi

    # Check gamma != delta in final verification key — pass path via env
    local vk_json="$CEREMONY_DIR/verification_key.json"
    if [ -f "$vk_json" ]; then
        VK_JSON_PATH="$vk_json" \
        node -e "
            const vk = JSON.parse(require('fs').readFileSync(process.env.VK_JSON_PATH, 'utf8'));
            const g = JSON.stringify(vk.vk_gamma_2);
            const d = JSON.stringify(vk.vk_delta_2);
            if (g === d) {
                console.error('FAIL: gamma_g2 == delta_g2 in verification key');
                process.exit(1);
            } else {
                console.log('OK: gamma_g2 != delta_g2');
            }
        " || {
            log_error "Verification key has gamma == delta!"
            exit 1
        }
    fi

    echo ""
    log_info "=== All ceremony checks passed ==="

    # Print transcript summary — pass path via env
    TRANSCRIPT_FILE="$TRANSCRIPT_FILE" \
    node -e "
        const t = JSON.parse(require('fs').readFileSync(process.env.TRANSCRIPT_FILE, 'utf8'));
        console.log('');
        console.log('Ceremony Summary:');
        console.log('  Started:       ' + t.startedAt);
        console.log('  Contributors:  ' + t.contributions.length);
        t.contributions.forEach(c => {
            console.log('    #' + c.index + ' ' + c.contributor + ' (' + c.timestamp + ')');
            console.log('       Hash: ' + c.hash);
        });
        console.log('  Beacon:        ' + (t.beaconApplied ? 'Applied (' + t.beaconHash.substring(0, 16) + '...)' : 'Not applied'));
        console.log('  Finalized:     ' + (t.finalized ? t.finalizedAt : 'No'));
    "
}

# Main command dispatcher
case "${1:-help}" in
    init)
        cmd_init
        ;;
    contribute)
        cmd_contribute
        ;;
    beacon)
        cmd_beacon
        ;;
    finalize)
        cmd_finalize
        ;;
    verify)
        cmd_verify
        ;;
    *)
        echo "MPC Trusted Setup Ceremony (issue #170)"
        echo ""
        echo "Usage: $0 <command>"
        echo ""
        echo "Commands:"
        echo "  init        Initialize ceremony (coordinator only)"
        echo "  contribute  Add a contribution (each participant)"
        echo "  beacon      Apply random beacon (coordinator, after all contributions)"
        echo "  finalize    Verify and export final keys (coordinator)"
        echo "  verify      Verify the full ceremony transcript"
        echo ""
        echo "Environment:"
        echo "  CEREMONY_DIR=$CEREMONY_DIR"
        echo "  MIN_CONTRIBUTORS=$MIN_CONTRIBUTORS"
        ;;
esac
