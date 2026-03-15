export const FRAME_SNAPSHOT_EXPECTATIONS = Object.freeze({
  widePlanner: `A G E N / C https://agenc.tech                                                                      live 12345678 0m 01s
grok-4 via grok
RUN:delegating  ROUTE:fallback  PROVIDER:grok  MODEL:grok-4  FAILOVER:active  RUNTIME:degraded  DURABLE:offline
MODE:follow
Ship operator console polish
child probe failed · retrying validation

CORE Working through the planner graph.                                   15:47:00  CONTROL
──────────────────────────────────────────────────────────────────────────────────  RUN:delegating           LINK:live
RETURN done                                                               15:47:01  PROVIDER:grok      FAILOVER:active
│ Edited runtime/src/index.ts                                                       grok-4 via grok             0m 01s
                                                                                    RUNTIME:degraded   DURABLE:offline
                                                                                    TOOL:system.writeFile      QUEUE:1
                                                                                    AGENTS:2          USAGE:3.4K total
                                                                                    OBJECTIVE                 12345678
                                                                                    Ship operator console polish

                                                                                    child probe failed · retrying val…

                                                                                    LIVE DAG           3 nodes  00:00:00
                                                                                    LIVE:1  DONE:1                FAIL:1
* Working delegating 0m 01s  fallback active  runtime degraded  live follow  usage 3.4K total                       idle
/ commands  ctrl+o detail  ctrl+y copy  /export save  pgup/pgdn scroll  ctrl+l clear                            12345678
>`,
  diffDetail: `A G E N / C https://agenc.tech                                                  live 12345678 0m 01s
grok-4 via grok
RUN:running
Edited runtime/src/index.ts

RETURN Edited runtime/src/index.ts                                                          15:48:00
return  ctrl+o close  ctrl+p prev hunk  ctrl+n next hunk
│ /home/tetsuo/git/AgenC/runtime/src/index.ts

--- before
- const oldValue = 1;
+++ after
+ const newValue = 2;
@@ lines 8-12 @@
--- before
- return oldValue;
+++ after
+ return newValue;
9 of 11 lines  2 above  hunk 1/2  /home/tetsuo/git/AgenC/runtime/src/index.ts
Awaiting operator prompt  detail  usage 1.2K total                                              idle
pgup pgdn scroll  ctrl+p prev hunk  ctrl+n next hunk  ctrl+o close detail  ct…                  live
>`,
  narrowReconnect: `A G E N / C https://agenc.tech                                reconnecting 12345678 0m 01s
routing pending
RUN:idle  RUNTIME:reconnecting
Awaiting operator prompt

CORE Reconnecting to the daemon.                                                  15:49:00









Awaiting operator prompt  runtime reconnecting  live follow                           idle
/ commands  ctrl+o detail  ctrl+y copy  /export save  pgup/pgdn scr…              12345678
>`,
});
