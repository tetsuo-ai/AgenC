\# Audit and Extension of Program Events for Observability



\## Current Events

All events defined in `events.rs`. They provide comprehensive coverage of the agent/task/dispute lifecycle.



| Event Name            | When Emitted                               | Key Fields                                                                 | Observability Use Case                                      |

|-----------------------|--------------------------------------------|----------------------------------------------------------------------------|------------------------------------------------------------|

| ProtocolInitialized   | After `initialize\_protocol` succeeds       | authority, treasury, dispute\_threshold, protocol\_fee\_bps, timestamp        | Track protocol launch and global config                     |

| AgentRegistered       | After `register\_agent` succeeds            | agent\_id, authority, capabilities, endpoint, timestamp                     | Monitor agent onboarding and capability distribution       |

| AgentUpdated          | After `update\_agent` succeeds              | agent\_id, capabilities, status, timestamp                                  | Track agent metadata/capability changes                     |

| AgentDeregistered     | After `deregister\_agent` succeeds          | agent\_id, authority, timestamp                                             | Monitor agent offboarding                                  |

| TaskCreated           | After `create\_task` succeeds               | task\_id, creator, required\_capabilities, reward\_amount, task\_type, deadline, timestamp | Analytics on task volume, rewards, types                   |

| TaskClaimed           | After `claim\_task` succeeds                | task\_id, worker, current\_workers, max\_workers, timestamp                   | Monitor worker participation and task fill rates           |

| TaskCompleted         | After `complete\_task` succeeds             | task\_id, worker, proof\_hash, reward\_paid, timestamp                        | Track completions, earnings, proof submission              |

| TaskCancelled         | After `cancel\_task` succeeds               | task\_id, creator, refund\_amount, timestamp                                 | Monitor abandoned tasks and refunds                        |

| StateUpdated          | After `update\_state` succeeds              | state\_key, updater, version, timestamp                                     | Real-time coordination state synchronization               |

| DisputeInitiated      | After `initiate\_dispute` succeeds          | dispute\_id, task\_id, initiator, resolution\_type, voting\_deadline, timestamp| Alert on disputes and measure quality/issues               |

| DisputeVoteCast       | After `vote\_dispute` succeeds              | dispute\_id, voter, approved, votes\_for, votes\_against, timestamp           | Monitor arbiter participation and vote progression         |

| DisputeResolved       | After `resolve\_dispute` succeeds           | dispute\_id, resolution\_type, votes\_for, votes\_against, timestamp           | Track dispute outcomes and final resolutions               |

| RewardDistributed     | During completion/resolution (reward payout)| task\_id, recipient, amount, protocol\_fee, timestamp                        | Treasury analytics, fee collection, reward flows           |



\## Missing Events / Recommendations

Current coverage is excellent for core flows. Suggested additions for enhanced debugging/analytics:



1\. \*\*FailedClaimAttempt\*\* – On claim failures (e.g., capability mismatch, already claimed). Fields: task\_id, worker, reason.  

&nbsp;  → Detect contention or client errors.



2\. \*\*FailedCompletionAttempt\*\* – On invalid completion submissions.  

&nbsp;  → Identify spam/malformed proofs.



3\. \*\*DisputeVoteRejected\*\* – If vote validation fails (e.g., insufficient stake).  

&nbsp;  → Monitor arbiter eligibility issues.



4\. \*\*ProtocolFeeCollected\*\* – Aggregate event for fees (if not covered via RewardDistributed).

These are recommendations only – no implementation needed now.
