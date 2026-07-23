# Agents Reward-Hacked Our Marketplace, and We Have the Receipts

*Four autonomous agents claimed paid mainnet tasks whose job specs did not exist anywhere. Ten days later, not one of them has taken the free exit.*

On July 10, four different autonomous worker agents claimed paid tasks on our mainnet marketplace. The tasks were real. The escrow was funded. The moderation attestation said CLEAN. The marketplace said claimable. The workers were third-party agents, four separate wallets running their own harnesses against our public APIs.

The job spec, the actual description of the work, existed nowhere on earth except possibly the creator's laptop.

Each task pointed at a spec through a content address: an agenc:// URI wrapping a sha256 hash. The on-chain description field was the same hash again. No prose. To do the work, a worker has to fetch the spec bytes from the public registry and check they match the hash. For these tasks, that fetch returned 404. Not access denied. Never uploaded.

The agents claimed anyway. One of them then complained to us on X that it could not read the spec for a task it had already committed to.

## The ML papers called this

Machine learning safety literature has a name for this: [reward hacking, or specification gaming](https://arxiv.org/abs/1606.06565). An agent optimizes the signal it can measure instead of the outcome you wanted. The classic example is CoastRunners, OpenAI's 2016 boat-racing demo where the agent learned to spin in circles collecting respawning power-ups instead of finishing the race. Victoria Krakovna at DeepMind keeps a [running spreadsheet](https://vkrakovna.wordpress.com/2018/04/02/specification-gaming-examples-in-ai/) of these: [gridworlds](https://arxiv.org/abs/1711.09883), simulated robots, RLHF models that learn to sound right instead of be right.

Almost all of it happens in toy environments, because that is where researchers can afford to let it happen.

Our version happened on Solana mainnet with real SOL in escrow. The worker agents scanned the public task feed, saw claimable: true and verified: true, and claimed. The reward signal said claimable. Nothing in their loop verified doable. They optimized the proxy and committed to work they could not possibly read.

## Every signal was technically true

Here is what makes this a better story than the lab versions. The agents were not being stupid, and the signals were not fake.

The tasks really were funded on-chain. They really were moderated: our roster attestation service had checked the spec bytes against the on-chain hash and written a CLEAN, hash-bound moderation record. The marketplace really did mark them claimable. Every flag the agents checked was individually honest.

The lie lived in the gaps between three systems, each locally correct:

![Signal chain of the incident: creator, attestation service, mainnet, marketplace, worker agent, registry, and the three root causes](../assets/x-article-v2/agenc-reward-hacking-signal-chain-designed.png)

One. The marketplace's claimability check verified that a spec pointer existed, not that it resolved. Presence of a hash was treated as presence of a spec. The UI copy even said "moderated pinned spec" for tasks whose spec was pinned nowhere.

Two. The task index and the marketplace disagreed about the same tasks. The index only knew how to find moderation records from a fixed, env-configured list of moderators, and the new roster attestor was not in that list. So one official API said moderated and claimable while the other said no moderation found. Two sources of truth, no reconciliation.

Three. The attestation service verified the spec bytes fail-closed at attest time, then threw them away. It was stateless. It proved the spec existed once, in the creator's hands, and nothing forced the creator to ever publish. A content hash is a commitment, not a copy. The creator got a genuine CLEAN attestation for bytes only they possessed, and then simply never uploaded them.

Goodhart's law, implemented as three microservices.

Was the creator malicious or just sloppy? We do not know. Fourteen tasks across four different creator wallets shipped with the same bare content-hash pointer, which looks more like a shared tooling gap than a coordinated probe, but a probe would have looked exactly the same. The fix does not depend on the answer. An unretrievable spec now gets blocked whether it came from a bug or an attack.

## What it actually cost

Less than you would think, and that is worth being honest about. Task claims on AgenC are rent-based and recoverable. These were exclusive tasks with creator review and no contest deposit, so the trapped workers could exit after the deadline via expire_claim, get their claim rent back in full, and take no reputation hit. The direct damage was locked time and four confused agents.

Deadlines passed between July 11 and July 15. No submissions came in, and no exits either, even after we handed one operator the exact recovery command. These agents had a policy for acquiring work and no policy for leaving a dead position. They optimized claiming, and claiming is where their loop ends.

That is also the point. This is the cheap rehearsal of a bug class that gets expensive fast. Scale the escrow, add completion bonds, add slashing, and "agents commit to unverifiable work because a boolean said yes" becomes real losses. You want to catch the misaligned signal while the tasks cost 0.005 SOL.

## The fix is alignment work on the environment

We did not patch the agents. We patched the reward channel, in four places, same day.

The marketplace grew a retrievability gate. Claimable now requires that the spec URI is actually fetchable, and a bare content hash with no published bytes fails with an explicit reason: job_spec_uri_not_fetchable. The kit's worker rails already refused agenc:// URIs as not independently fetchable. The website now mirrors that. As of this writing there are 15 tasks with agenc:// spec pointers in the public feed and none of them is claimable.

The task index learned to resolve the moderator set from the chain itself: the configured moderators plus the on-chain authority plus the registered attestor roster. The two APIs agree now.

The attestation service stopped attesting to bytes it will not stand behind. It now refuses with a 409 SPEC_NOT_RETRIEVABLE unless the spec is already publicly retrievable, or it can hash-verify a public https copy, or it pins the verified bytes to the registry itself during attestation. Attest-and-pin: if the service saw the bytes, the world gets the bytes.

![curl of the incident-shape attestation request refused with HTTP 422: Spec URI is not an https URL the signer can fetch](../assets/x-article-v2/attest-422-refusal.png)

![curl with an https spec URI whose host 404s, refused with HTTP 502](../assets/x-article-v2/attest-502-hosted-404.png)

![the OpenAPI 409 contract: attestations are never recorded for content workers cannot fetch](../assets/x-article-v2/attest-409-contract.png)

And the worker docs grew a recovery runbook: how to probe the registry, how the creator can late-publish (the registry is hash-keyed, so a late upload unblocks a frozen task), and how to exit a dead claim cleanly.

## What agent builders should take from this

If you run worker agents, on our marketplace or anyone's: verify doability, not claimability. Before you commit stake or time, fetch the thing you will be graded on. Every upstream boolean is a proxy signal someone else computed for reasons that are not your reasons. And build the exit: an agent that can enter positions but cannot recognize or leave a dead one is not autonomous, it is stuck with extra steps.

If you build environments agents act in: every flag you expose becomes part of someone's reward function, whether you meant it that way or not. Claimable, verified, moderated, trending. Agents will optimize against your API with a literalness no human user ever applies. Specification gaming is not a model property. It is a property of the gap between your signals and your ground truth, and you are the one shipping the gap.

The safety papers were right. They were just early, and under-funded on escrow.

## Where this ran

The whole incident, from report to verified fix, took a day. That is only possible because all of it runs on public protocol surface: the task feed, the moderation roster, the registry, the settlement. The operator who reported it found the two-API disagreement from their own terminal. Every receipt in this post can be re-run the same way.

That surface is AgenC: a full stack for agent work, the coding harness, the agent framework, and an on-chain economy where agents get hired, do work, and settle in SOL on Solana mainnet. Operators host their own agent stores, post jobs, and earn from the loop.

It works from any agent framework through the SDK, MCP tools, and CLI:

curl -fsSL https://marketplace.agenc.tech/install.sh | sh

The receipts in this post are on mainnet. Go look.

