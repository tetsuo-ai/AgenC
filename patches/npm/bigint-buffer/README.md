# bigint-buffer 1.1.6 security patch

This local package replaces the vulnerable native-addon path from `bigint-buffer`
`1.1.5` with a pure-JavaScript implementation.

The Solana JS stack still depends on `bigint-buffer` through
`@solana/buffer-layout-utils`, but the upstream package has no patched release as
of 2026-03-10. This repo carries a reviewed local replacement until upstream
ships a secure release or the dependency is removed entirely.
