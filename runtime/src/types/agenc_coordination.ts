/**
 * Thin runtime shim over the published protocol artifact package.
 *
 * Runtime code keeps this local module path to avoid broad import churn, but
 * canonical protocol ownership now lives in `@tetsuo-ai/protocol`.
 */

export type { AgencCoordination } from "@tetsuo-ai/protocol";
