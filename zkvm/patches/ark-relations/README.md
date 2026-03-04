# ark-relations 0.5.1 local patch

This directory vendors `ark-relations` `0.5.1` from crates.io with a single
security backport:

- `tracing-subscriber` dependency moved from `0.2` to `0.3`.

Why:

- `CVE-2025-58160` (`GHSA-xwfj-jgwm-7wp5`) is fixed in `tracing-subscriber >= 0.3.20`.
- Upstream `ark-relations` 0.5.1 on crates.io still depends on `0.2.x`.
- This keeps the `ark-relations` API/version line stable while removing the
  vulnerable transitive dependency from `zkvm/Cargo.lock`.

Source used:

- `https://static.crates.io/crates/ark-relations/ark-relations-0.5.1.crate`

Configured via:

- `zkvm/Cargo.toml` `[patch.crates-io] ark-relations = { path = "patches/ark-relations" }`
