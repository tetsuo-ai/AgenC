import http from "node:http";
import https from "node:https";

const listenHost = process.env.RPC_PROXY_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.RPC_PROXY_PORT ?? "8899");
const targetHost = process.env.RPC_TARGET_HOST ?? "api.devnet.solana.com";
const targetIp = process.env.RPC_TARGET_IP ?? "74.63.203.93";
const targetPort = Number(process.env.RPC_TARGET_PORT ?? "443");

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  lookup(_hostname, optionsOrCallback, maybeCallback) {
    const options =
      typeof optionsOrCallback === "function" ? {} : optionsOrCallback ?? {};
    const callback =
      typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;

    if (typeof callback !== "function") {
      throw new Error("lookup callback missing");
    }

    if (options.all) {
      callback(null, [{ address: targetIp, family: 4 }]);
      return;
    }

    callback(null, targetIp, 4);
  },
});

const server = http.createServer((req, res) => {
  const chunks = [];

  req.on("data", (chunk) => {
    chunks.push(chunk);
  });

  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const upstream = https.request(
      {
        host: targetHost,
        port: targetPort,
        path: req.url ?? "/",
        method: req.method,
        headers: {
          ...req.headers,
          host: targetHost,
          connection: "keep-alive",
        },
        servername: targetHost,
        agent,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstream.on("error", (error) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          proxy: "devnet-rpc-proxy",
          error: error.message,
        }),
      );
    });

    if (body.length > 0) {
      upstream.write(body);
    }

    upstream.end();
  });

  req.on("error", (error) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ proxy: "devnet-rpc-proxy", error: error.message }));
  });
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(
    `devnet-rpc-proxy listening on http://${listenHost}:${listenPort} -> https://${targetHost} (${targetIp})\n`,
  );
});

const shutdown = () => {
  server.close(() => {
    agent.destroy();
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
