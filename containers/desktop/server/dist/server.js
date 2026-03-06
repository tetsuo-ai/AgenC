import { createServer } from "node:http";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { isAuthorizedRequest, resolveAllowedOrigin } from "./auth.js";
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
        const maxSize = 1024 * 1024;
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
function applyCorsHeaders(req, res) {
    const allowedOrigin = resolveAllowedOrigin(req.headers.origin);
    if (allowedOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.setHeader("Vary", "Origin");
    }
    return allowedOrigin;
}
export function createDesktopServer(options) {
    const startTime = options.startTime ?? Date.now();
    const authToken = options.authToken;
    return createServer((req, res) => {
        void handleRequest(req, res, authToken, startTime).catch((err) => {
            console.error("Request handler error:", err);
            if (!res.headersSent) {
                json(res, 500, { error: "Internal server error" });
            }
        });
    });
}
async function handleRequest(req, res, authToken, startTime) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const allowedOrigin = applyCorsHeaders(req, res);
    if (req.method === "OPTIONS") {
        if (req.headers.origin && !allowedOrigin) {
            json(res, 403, { error: "Origin not allowed" });
            return;
        }
        res.writeHead(204);
        res.end();
        return;
    }
    if (!isAuthorizedRequest(req.headers.authorization, authToken)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        json(res, 401, { error: "Unauthorized" });
        return;
    }
    if (req.method === "GET" && path === "/health") {
        const health = {
            status: "ok",
            display: process.env.DISPLAY ?? ":1",
            uptime: Math.floor((Date.now() - startTime) / 1000),
        };
        json(res, 200, health);
        return;
    }
    if (req.method === "GET" && path === "/tools") {
        json(res, 200, TOOL_DEFINITIONS);
        return;
    }
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
