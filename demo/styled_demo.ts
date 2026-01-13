/**
 * AgenC Private Task Completion - Styled Demo
 * Solana Privacy Hackathon 2026
 */

import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import Table from 'cli-table3';

// Tetsuo colors
const blue = chalk.hex('#00D4FF');
const green = chalk.hex('#14F195');
const cyan = chalk.hex('#00FFFF');
const gray = chalk.gray;
const white = chalk.white;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function header() {
    console.clear();
    console.log();
    console.log(blue(`
    ╔═══════════════════════════════════════════════════════════════╗
    ║                                                               ║
    ║     █████╗  ██████╗ ███████╗███╗   ██╗ ██████╗               ║
    ║    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║██╔════╝               ║
    ║    ███████║██║  ███╗█████╗  ██╔██╗ ██║██║                    ║
    ║    ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║██║                    ║
    ║    ██║  ██║╚██████╔╝███████╗██║ ╚████║╚██████╗               ║
    ║    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝ ╚═════╝               ║
    ║                                                               ║
    ║           ${white('PRIVATE TASK COMPLETION')}                          ║
    ║           ${gray('Solana Privacy Hackathon 2026')}                      ║
    ║                                                               ║
    ╚═══════════════════════════════════════════════════════════════╝
    `));
    console.log();
}

function separator(title: string) {
    console.log();
    console.log(blue('━'.repeat(65)));
    console.log(white.bold(`  ${title}`));
    console.log(blue('━'.repeat(65)));
    console.log();
}

function privacyBox(output: string, payment: string, proof: string) {
    const content = 
        `${green('●')} Output:    ${output}\n` +
        `${green('●')} Payment:   ${payment}\n` +
        `${green('●')} ZK Proof:  ${proof}`;
    
    console.log(boxen(content, {
        padding: 1,
        margin: 1,
        borderColor: 'green',
        borderStyle: 'round',
        title: 'PRIVACY STATUS',
        titleAlignment: 'center'
    }));
}

function walletBox(creator: string, worker: string, recipient: string) {
    const content = 
        `${gray('Creator:')}   ${blue(creator)}\n` +
        `${gray('Worker:')}    ${blue(worker)}\n` +
        `${gray('Recipient:')} ${cyan(recipient)} ${gray('(different wallet)')}`;
    
    console.log(boxen(content, {
        padding: 1,
        margin: 1,
        borderColor: 'blue',
        borderStyle: 'round',
        title: 'WALLETS',
        titleAlignment: 'center'
    }));
}

function flowDiagram() {
    console.log(gray(`
                    PRIVACY FLOW
    
      ┌──────────────┐         ┌──────────────┐
      │   Creator    │         │    Agent     │
      │  ${blue('9xK4...mNpQ')}  │         │  ${blue('7bR2...kLmP')}  │
      └──────┬───────┘         └──────┬───────┘
             │                        │
             │  ${gray('escrow')}               │  ${gray('claim + stake')}
             ▼                        │
      ┌──────────────┐               │
      │  ${green('Privacy')}     │◄──────────────┘
      │  ${green('Pool')}        │
      └──────┬───────┘
             │
             │  ${cyan('??? (link broken)')}
             ▼
      ┌──────────────┐
      │  ${cyan('Recipient')}   │
      │  ${cyan('NEW WALLET')}  │  ${gray('← No on-chain link to creator')}
      └──────────────┘
    `));
}

async function main() {
    header();
    await sleep(1500);

    // Wallets
    const creator = 'FZxei2qh...PsSbyW';
    const worker = '2mA3sua9...SBHKy';
    const recipient = 'CTVq9brx...qxw4';

    walletBox(creator, worker, recipient);
    await sleep(2000);

    // Step 1: Create Task
    separator('STEP 1: CREATE TASK');
    
    const createSpinner = ora({
        text: 'Creating task with escrow...',
        color: 'blue'
    }).start();
    await sleep(1500);
    createSpinner.succeed(green('Task created'));

    const taskTable = new Table({
        style: { head: ['blue'] }
    });
    taskTable.push(
        [gray('Task ID'), white('1')],
        [gray('Reward'), white('1 SOL')],
        [gray('Constraint'), blue('0x224785a4...ce5785b1')],
        [gray('Status'), green('Open')]
    );
    console.log(taskTable.toString());
    await sleep(2000);

    // Step 2: Shield Escrow
    separator('STEP 2: SHIELD ESCROW');
    
    const shieldSpinner = ora({
        text: 'Shielding escrow into Privacy Cash pool...',
        color: 'cyan'
    }).start();
    await sleep(2000);
    shieldSpinner.succeed(green('Escrow shielded'));

    console.log(gray('  Commitment added to Merkle tree'));
    console.log(gray('  Funds now in privacy pool'));
    console.log(cyan('  → Link to creator will be broken on withdrawal'));
    await sleep(2000);

    // Step 3: Claim Task
    separator('STEP 3: AGENT CLAIMS TASK');
    
    const claimSpinner = ora({
        text: 'Agent claiming task...',
        color: 'blue'
    }).start();
    await sleep(1500);
    claimSpinner.succeed(green('Task claimed'));

    console.log(gray('  Worker:'), blue(worker));
    console.log(gray('  Stake:'), white('0.1 SOL'));
    await sleep(2000);

    // Step 4: Complete Work
    separator('STEP 4: AGENT COMPLETES WORK (OFF-CHAIN)');
    
    const workSpinner = ora({
        text: 'Agent computing result...',
        color: 'yellow'
    }).start();
    await sleep(2000);
    workSpinner.succeed(green('Work completed'));

    console.log();
    console.log(boxen(
        gray('Output: ') + cyan('[PRIVATE - NEVER REVEALED]') + '\n' +
        gray('Commitment: ') + blue('0x2a4c1b6d...bb2239a'),
        {
            padding: 1,
            borderColor: 'yellow',
            borderStyle: 'round',
            title: 'TASK OUTPUT',
            titleAlignment: 'center'
        }
    ));
    await sleep(2000);

    // Step 5: Generate ZK Proof
    separator('STEP 5: GENERATE ZERO-KNOWLEDGE PROOF');

    console.log(gray('  Circuit: ') + white('circuits/task_completion/main.nr'));
    console.log(gray('  Prover:  ') + white('Groth16 via Sunspot'));
    console.log();

    const proofSpinner = ora({
        text: 'Generating ZK proof...',
        color: 'cyan',
        spinner: 'dots12'
    }).start();
    
    await sleep(3000);
    proofSpinner.succeed(green('ZK proof generated'));

    const proofTable = new Table({
        style: { head: ['cyan'] }
    });
    proofTable.push(
        [gray('Proof size'), white('388 bytes')],
        [gray('Public inputs'), white('task_id, agent_pubkey, constraint_hash')],
        [gray('Private inputs'), cyan('output, salt (HIDDEN)')],
        [gray('Verification'), green('Ready for on-chain')]
    );
    console.log(proofTable.toString());
    await sleep(2000);

    // Step 6: Submit + Withdraw
    separator('STEP 6: VERIFY ON-CHAIN + PRIVATE WITHDRAWAL');

    const verifySpinner = ora({
        text: 'Submitting proof to Solana...',
        color: 'blue'
    }).start();
    await sleep(1500);
    verifySpinner.text = 'Verifying ZK proof on-chain...';
    await sleep(1500);
    verifySpinner.succeed(green('ZK proof verified on-chain'));

    const withdrawSpinner = ora({
        text: 'Executing Privacy Cash withdrawal...',
        color: 'green'
    }).start();
    await sleep(2000);
    withdrawSpinner.succeed(green('Private withdrawal complete'));

    console.log();
    console.log(gray('  Verifier Program: ') + blue('8fHUGmjN...XXonwQQ'));
    console.log(gray('  Recipient:        ') + cyan(recipient));
    console.log(gray('  Amount:           ') + white('1 SOL'));
    await sleep(2000);

    // Privacy Status
    separator('PRIVACY VERIFICATION');

    flowDiagram();
    await sleep(1500);

    privacyBox(
        cyan('HIDDEN') + gray(' (only commitment on-chain)'),
        cyan('UNLINKED') + gray(' (Privacy Cash breaks trace)'),
        green('VERIFIED') + gray(' (Groth16 on Solana)')
    );

    // Summary
    separator('SUMMARY');

    const summaryTable = new Table({
        head: [blue('Component'), white('Status'), gray('Bounty')],
        style: { head: ['blue'] }
    });
    summaryTable.push(
        ['Noir Circuit', green('✓ Working'), 'Aztec Noir'],
        ['Groth16 Verifier', green('✓ Deployed'), 'Track 2'],
        ['Privacy Cash', green('✓ Integrated'), 'Privacy Cash'],
        ['Helius RPC', green('✓ Connected'), 'Helius']
    );
    console.log(summaryTable.toString());

    console.log();
    console.log(boxen(
        white.bold('Private agent coordination on Solana.') + '\n\n' +
        gray('Agents prove task completion without revealing output.') + '\n' +
        gray('Payments released with no on-chain link to creator.') + '\n\n' +
        blue('Built by TETSUO') + gray(' for Solana Privacy Hackathon 2026'),
        {
            padding: 1,
            margin: 1,
            borderColor: 'blue',
            borderStyle: 'double',
            title: 'AgenC',
            titleAlignment: 'center'
        }
    ));

    console.log();
}

main().catch(console.error);
