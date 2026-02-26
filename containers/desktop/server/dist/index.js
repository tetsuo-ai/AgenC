import { createServer } from "node:http";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
const PORT = parseInt(process.env.PORT ?? "9990", 10);
const startTime = Date.now();
function json(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const maxSize = 1024 * 1024; // 1MB
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxSize) {
                req.destroy();
                reject(new Error("Request body too large"));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
        req.on("error", reject);
    });
}
async function handleRequest(req, res) {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const path = url.pathname;
    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }
    // GET /health
    if (req.method === "GET" && path === "/health") {
        const health = {
            status: "ok",
            display: process.env.DISPLAY ?? ":1",
            uptime: Math.floor((Date.now() - startTime) / 1000),
        };
        json(res, 200, health);
        return;
    }
    // GET /tools
    if (req.method === "GET" && path === "/tools") {
        json(res, 200, TOOL_DEFINITIONS);
        return;
    }
    // POST /tools/:name
    const toolMatch = path.match(/^\/tools\/([a-z_]+)$/);
    if (req.method === "POST" && toolMatch) {
        const toolName = toolMatch[1];
        let args = {};
        try {
            const body = await readBody(req);
            if (body.trim()) {
                args = JSON.parse(body);
            }
        }
        catch (e) {
            json(res, 400, {
                error: `Invalid JSON body: ${e instanceof Error ? e.message : e}`,
            });
            return;
        }
        const result = await executeTool(toolName, args);
        json(res, result.isError ? 400 : 200, result);
        return;
    }
    json(res, 404, { error: "Not found" });
}
const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
        console.error("Request handler error:", err);
        if (!res.headersSent) {
            json(res, 500, { error: "Internal server error" });
        }
    });
});
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Desktop REST server listening on port ${PORT}`);
});
