# ZK Admin Tools

This workspace owns verifier-localnet helpers, private-proof benchmarking, and zk config administration.

Current Gate 11 status:

- the `admin bootstrap slice` (`zk-config-admin*`, `devnet-preflight`, `protocol-program`, and the supporting package/test/typecheck files) is being mirrored into the private `agenc-prover` repo
- the `shared proof-harness/localnet slice` remains authoritative here in AgenC for now:
  - `verifier-localnet`
  - private-proof benchmark entrypoints/helpers
  - root verifier/bootstrap scripts/tests
  - local proof fixtures
- protocol-owned `scripts/idl/**` artifacts remain outside this workspace and stay with `agenc-protocol`

The commands below are workspace-local and do not require AgenC root scripts.
If you are running inside the full AgenC monorepo, root wrappers may exist as
convenience entrypoints, but they are not the package contract.

Commands:

```bash
npm run benchmark:private:e2e -- --help
npm run zk:config -- --help
npm run zk:devnet:preflight -- --help
```

Direct workspace commands:

```bash
npm run benchmark:e2e --workspace=@tetsuo-ai/zk-admin-tools -- --help
npm run zk:config --workspace=@tetsuo-ai/zk-admin-tools -- --help
npm run devnet:preflight --workspace=@tetsuo-ai/zk-admin-tools -- --help
```
