import "dotenv/config";
import express from "express";
import cors from "cors";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { MCPManager } from "./mcp-manager.js";
import { buildRouter } from "./routes.js";
import * as storage from "./storage.js";
import type { SNCredentials } from "./servicenow.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MANAGEMENT_PORT = Number(
  process.env["PORT"] ?? process.env["MANAGEMENT_PORT"] ?? 3003
);

function parseEnabledServerNames(): Set<string> | null {
  const raw = process.env["ENABLED_MCP_SERVERS"]?.trim();
  if (!raw) return null;

  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return names.length ? new Set(names) : null;
}

function credsFromEnv(): SNCredentials {
  return {
    instanceUrl: process.env["SN_INSTANCE_URL"] ?? "",
    username: process.env["SN_USERNAME"] ?? "",
    password: process.env["SN_PASSWORD"] ?? "",
  };
}

async function main(): Promise<void> {
  const manager = new MCPManager(credsFromEnv());
  const enabledNames = parseEnabledServerNames();

  function resolvePublicMcpPort(serverName?: string): number | null {
    const runningServers = storage
      .listServers()
      .filter((s) => manager.isRunning(s.id));

    if (!runningServers.length) return null;

    if (serverName) {
      const exact = runningServers.find((s) => s.name === serverName);
      return exact ? exact.port : null;
    }

    // Prefer explicitly enabled servers when set, otherwise default to incident-mcp.
    if (enabledNames?.size) {
      const enabled = runningServers.find((s) => enabledNames.has(s.name));
      if (enabled) return enabled.port;
    }

    const incident = runningServers.find((s) => s.name === "incident-mcp");
    if (incident) return incident.port;

    return runningServers[0]?.port ?? null;
  }

  // Auto-start servers that were running before (all stored servers on startup)
  const stored = storage
    .listServers()
    .filter((s) => !enabledNames || enabledNames.has(s.name));

  if (enabledNames) {
    const skipped = storage
      .listServers()
      .filter((s) => !enabledNames.has(s.name))
      .map((s) => s.name);
    if (skipped.length) {
      console.log(`[mcp] skipped by ENABLED_MCP_SERVERS: ${skipped.join(", ")}`);
    }
  }

  await Promise.all(
    stored.map((s) =>
      manager.start(s).catch((err) =>
        console.warn(`[mcp] could not auto-start ${s.name}: ${err}`)
      )
    )
  );

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Public MCP passthrough for cloud deployments where only one app port is exposed.
  // Supports both /mcp and /rpc aliases because some enterprise proxies block /mcp.
  // Optional server selection: /mcp/:serverName or /rpc/:serverName.
  app.all(["/mcp", "/mcp/:serverName", "/rpc", "/rpc/:serverName"], async (req, res) => {
    const serverParam = req.params["serverName"];
    const serverName = Array.isArray(serverParam) ? serverParam[0] : serverParam;
    const targetPort = resolvePublicMcpPort(serverName);
    if (!targetPort) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32004, message: "No running MCP server available" },
        id: null,
      });
      return;
    }

    const targetUrl = `http://127.0.0.1:${targetPort}/mcp`;

    try {
      const body = req.method === "GET" ? undefined : JSON.stringify(req.body ?? {});
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers: {
          accept: String(req.headers["accept"] ?? "application/json"),
          "content-type": String(req.headers["content-type"] ?? "application/json"),
          ...(req.headers["mcp-session-id"]
            ? { "mcp-session-id": String(req.headers["mcp-session-id"]) }
            : {}),
        },
        body,
      });

      const contentType = upstream.headers.get("content-type");
      const mcpSessionId = upstream.headers.get("mcp-session-id");
      if (contentType) res.setHeader("content-type", contentType);
      if (mcpSessionId) res.setHeader("mcp-session-id", mcpSessionId);

      res.status(upstream.status).send(await upstream.text());
    } catch (err) {
      console.error("[mcp] public proxy error:", err);
      res.status(502).json({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Public MCP proxy failed" },
        id: null,
      });
    }
  });

  // Management REST API
  app.use("/api", buildRouter(manager, credsFromEnv));

  // Serve the UI
  app.use(express.static(join(__dir, "../public")));
  app.get("*", (_req, res) => {
    res.sendFile(join(__dir, "../public/index.html"));
  });

  const managementServer = app.listen(MANAGEMENT_PORT);

  managementServer.on("listening", () => {
    console.log(`\n  Management UI  →  http://localhost:${MANAGEMENT_PORT}`);
    console.log(`  API base       →  http://localhost:${MANAGEMENT_PORT}/api\n`);
  });

  managementServer.on("error", async (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[startup] Port ${MANAGEMENT_PORT} is already in use. ` +
          "Stop the existing process or change PORT/MANAGEMENT_PORT."
      );
      await manager.stopAll();
      process.exit(1);
    }

    console.error("[startup] Failed to start management server:", err.message);
    await manager.stopAll();
    process.exit(1);
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await manager.stopAll();
    process.exit(0);
  });
}

main().catch(console.error);
