export const FRAME_SNAPSHOT_EXPECTATIONS = Object.freeze({
  widePlanner: {
    exact:
      "A G E N / C https://agenc.tech                                                                      live 12345678 0m 01s\ngrok-4 via grok\nRUN:delegating  ROUTE:fallback  PROVIDER:grok  MODEL:grok-4  FAILOVER:active  RUNTIME:degraded  DURABLE:offline\nMODE:follow\nShip operator console polish\nchild probe failed · retrying validation\n\nCORE Working through the planner graph.                                   15:47:00  OBJ Ship operator console polish\n──────────────────────────────────────────────────────────────────────────────────  child probe failed · retrying val…\nRETURN done                                                               15:47:01\n│ Edited runtime/src/index.ts                                                       LIVE DAG           3 nodes  00:00:00\n                                                                                    LIVE:1  DONE:1                FAIL:1\n                                                                                     *──┼  1> Plan         done\n                                                                                        ┼──*─┼  2> Inspect ru…  live\n                                                                                             ┼──*  3> Patch frame  fail\n                                                                                    running acceptance probe\n\n                                                                                    TOOLS\n                                                                                    LATEST:system.writeFile     PLAN:4\n                                                                                    AGENTS:2          RUNTIME:degraded\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n* Working delegating 0m 01s  fallback active  runtime degraded  live follow  usage 3.4K total                       idle\n/ commands  ctrl+o detail  ctrl+y copy  /export save  pgup/pgdn scroll  ctrl+l clear                            12345678\n>",
  },
  diffDetail: {
    containsInOrder: [
      "A G E N / C https://agenc.tech                                                  live 12345678 0m 01s",
      "RUN:running",
      "RETURN Edited runtime/src/index.ts",
      "return  ctrl+o close  ctrl+p prev hunk  ctrl+n next hunk",
      "│ /home/tetsuo/git/AgenC/runtime/src/index.ts",
      "- const oldValue = 1;",
      "+ const newValue = 2;",
      "8 of 11 lines  3 above  hunk 1/2  /home/tetsuo/git/AgenC/runtime/src/index.ts",
      "Awaiting operator prompt  detail  usage 1.2K total",
    ],
  },
  narrowReconnect: {
    containsInOrder: [
      "A G E N / C https://agenc.tech                                reconnecting 12345678 0m 01s",
      "routing pending",
      "RUN:idle  RUNTIME:reconnecting",
      "CORE Reconnecting to the daemon.",
      "Awaiting operator prompt  runtime reconnecting  live follow",
    ],
  },
});
