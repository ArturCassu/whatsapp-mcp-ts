/**
 * Always-on HTTP MCP (Streamable HTTP) owning the single Baileys socket.
 * Protected by bearer token (ZAP_MCP_TOKEN). Optional Cloudflare quick tunnel.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pino, type P } from "pino";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { initializeDatabase, closeDatabase } from "./database.ts";
import { createWhatsAppMcpServer } from "./mcp.ts";
import {
  getSessionStatus,
  startWhatsAppConnection,
  type WhatsAppSocket,
} from "./whatsapp.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_LOCAL = path.join(ROOT, ".env.local");
const DEFAULT_PORT = 8787;
const MCP_PATH = "/mcp";

export type ServeOptions = {
  port?: number;
  host?: string;
  token?: string;
  /** Start cloudflared quick tunnel (default true unless ZAP_MCP_NO_TUNNEL=1) */
  tunnel?: boolean;
  publicUrl?: string;
};

type Session = {
  transport: StreamableHTTPServerTransport;
  open: number;
  lastActive: number;
};

function loadEnvLocal(): Record<string, string> {
  if (!fs.existsSync(ENV_LOCAL)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_LOCAL, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function upsertEnvLocal(updates: Record<string, string>): void {
  const existing = loadEnvLocal();
  const merged = { ...existing, ...updates };
  const lines = [
    "# Local secrets for zap serve — never commit",
    `# Updated ${new Date().toISOString()}`,
    ...Object.entries(merged).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  fs.writeFileSync(ENV_LOCAL, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
}

function resolveToken(explicit?: string): string {
  const fromEnv =
    explicit ||
    process.env.ZAP_MCP_TOKEN ||
    loadEnvLocal().ZAP_MCP_TOKEN ||
    "";
  if (fromEnv.trim()) return fromEnv.trim();
  const generated = randomBytes(32).toString("base64url");
  upsertEnvLocal({ ZAP_MCP_TOKEN: generated });
  process.env.ZAP_MCP_TOKEN = generated;
  return generated;
}

function tokensEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireBearer(token: string) {
  return (req: Request, res: Response, next: () => void) => {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const provided = match?.[1]?.trim() ?? "";
    if (!provided || !tokensEqual(token, provided)) {
      res.setHeader(
        "WWW-Authenticate",
        'Bearer realm="whatsapp-mcp", error="invalid_token"',
      );
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: bearer token required" },
        id: null,
      });
      return;
    }
    next();
  };
}

function findCloudflared(): string | null {
  const fromEnv = process.env.CLOUDFLARED_PATH?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    path.join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "cloudflared",
      "cloudflared.exe",
    ),
    path.join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "cloudflared",
      "cloudflared.exe",
    ),
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "Microsoft",
      "WinGet",
      "Links",
      "cloudflared.exe",
    ),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return "cloudflared"; // last resort: PATH
}

async function startQuickTunnel(
  localPort: number,
  logger: P.Logger,
): Promise<{ url: string; child: ChildProcess }> {
  const bin = findCloudflared();
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin!,
      ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let settled = false;
    let buf = "";
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(
          new Error(
            "cloudflared did not print a public URL within 45s. Install: winget install Cloudflare.cloudflared",
          ),
        );
      }
    }, 45_000);

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      buf += text;
      process.stderr.write(text);
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ url: m[0], child });
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `Failed to start cloudflared (${bin}): ${err.message}. Install with: winget install Cloudflare.cloudflared`,
          ),
        );
      }
    });
    child.on("exit", (code) => {
      logger.warn(`cloudflared exited code=${code}`);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited early (code=${code})`));
      }
    });
  });
}

export async function runHttpServe(options: ServeOptions = {}): Promise<void> {
  const localEnv = loadEnvLocal();
  for (const [k, v] of Object.entries(localEnv)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }

  const port =
    options.port ??
    Number(process.env.ZAP_MCP_PORT || localEnv.ZAP_MCP_PORT || DEFAULT_PORT);
  const host = options.host ?? process.env.ZAP_MCP_HOST ?? "127.0.0.1";
  const wantTunnel =
    options.tunnel ??
    !(
      process.env.ZAP_MCP_NO_TUNNEL === "1" ||
      process.env.ZAP_MCP_NO_TUNNEL === "true"
    );
  const token = resolveToken(options.token);

  const dataDir = process.env.WHATSAPP_MCP_DATA_DIR || ".";
  const mcpLogger = pino(
    {
      level: process.env.LOG_LEVEL || "info",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination(path.join(ROOT, dataDir === "." ? "mcp-logs.txt" : path.join(dataDir, "mcp-logs.txt"))),
  );
  const waLogger = pino(
    {
      level: process.env.LOG_LEVEL || "info",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination(path.join(ROOT, dataDir === "." ? "wa-logs.txt" : path.join(dataDir, "wa-logs.txt"))),
  );

  console.error("zap serve — HTTP MCP (Streamable HTTP) + Baileys owner");
  console.error(`Bind: http://${host}:${port}${MCP_PATH}`);
  console.error("One-socket rule: keep Cursor stdio WhatsApp MCP disabled while this runs.");

  initializeDatabase();
  const session = getSessionStatus();
  if (!session.ok) {
    console.error(
      "Session not paired (connected_session=false). Run `zap pair` first, then `zap serve`.",
    );
    process.exit(2);
  }

  console.error(`WhatsApp session OK me=${session.meId ?? "?"} — connecting…`);
  let sock: WhatsAppSocket | null = null;
  sock = await startWhatsAppConnection(waLogger);

  // Stateless-ish stateful sessions for Streamable HTTP
  const sessions = new Map<string, Session>();
  const IDLE_MS = 30 * 60_000;
  const MAX_SESSIONS = 64;

  const trackResponse = (s: Session, res: Response) => {
    if (!res.socket || res.destroyed) return;
    s.open++;
    res.on("close", () => {
      s.open--;
      s.lastActive = Date.now();
    });
  };

  setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const { transport, open, lastActive } of sessions.values()) {
      if (open === 0 && lastActive < cutoff) {
        transport.close().catch(() => undefined);
      }
    }
  }, 60_000).unref();

  // Tunnel Host headers won't match localhost — disable DNS-rebinding guard.
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  const auth = requireBearer(token);

  app.get("/health", (_req, res) => {
    const st = getSessionStatus();
    res.json({
      ok: true,
      mcp: "streamable-http",
      path: MCP_PATH,
      connected_session: st.ok,
      meId: st.meId,
      meName: st.meName,
      socket: sock ? "present" : "null",
    });
  });

  const mcpPostHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    try {
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      let transport: StreamableHTTPServerTransport;

      if (existing) {
        transport = existing.transport;
        trackResponse(existing, res);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        if (sessions.size >= MAX_SESSIONS) {
          res.status(503).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Too many open sessions" },
            id: null,
          });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, {
              transport,
              open: 0,
              lastActive: Date.now(),
            });
            mcpLogger.info(`MCP session initialized: ${sid}`);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessions.delete(sid);
        };
        const server = createWhatsAppMcpServer(sock, mcpLogger, waLogger);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else if (sessionId) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error: any) {
      mcpLogger.error({ err: error }, "MCP POST failed");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  const mcpGetHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing mcp-session-id");
      return;
    }
    const s = sessions.get(sessionId)!;
    trackResponse(s, res);
    await s.transport.handleRequest(req, res);
  };

  const mcpDeleteHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing mcp-session-id");
      return;
    }
    const s = sessions.get(sessionId)!;
    await s.transport.handleRequest(req, res);
  };

  app.post(MCP_PATH, auth, mcpPostHandler);
  app.get(MCP_PATH, auth, mcpGetHandler);
  app.delete(MCP_PATH, auth, mcpDeleteHandler);

  let tunnelChild: ChildProcess | null = null;
  let publicBase =
    options.publicUrl ||
    process.env.ZAP_MCP_PUBLIC_URL ||
    localEnv.ZAP_MCP_PUBLIC_URL ||
    "";

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  console.error(`Local health: http://${host}:${port}/health`);
  console.error(`Local MCP:    http://${host}:${port}${MCP_PATH}`);

  if (wantTunnel) {
    try {
      console.error("Starting Cloudflare quick tunnel…");
      const t = await startQuickTunnel(port, mcpLogger);
      tunnelChild = t.child;
      publicBase = t.url;
      upsertEnvLocal({
        ZAP_MCP_TOKEN: token,
        ZAP_MCP_PORT: String(port),
        ZAP_MCP_PUBLIC_URL: publicBase,
      });
    } catch (err: any) {
      console.error(`Tunnel failed: ${err.message}`);
      console.error(
        "HTTP MCP is still listening locally. Fix cloudflared and re-run, or set ZAP_MCP_PUBLIC_URL.",
      );
    }
  } else if (publicBase) {
    upsertEnvLocal({
      ZAP_MCP_TOKEN: token,
      ZAP_MCP_PORT: String(port),
      ZAP_MCP_PUBLIC_URL: publicBase,
    });
  }

  const publicMcp = publicBase
    ? `${publicBase.replace(/\/$/, "")}${MCP_PATH}`
    : `(no public URL — local only) http://${host}:${port}${MCP_PATH}`;

  console.error("");
  console.error("========== Grok Bot ==========");
  console.error(`Add this MCP server: ${publicMcp}`);
  console.error(`Authorization: Bearer ${token}`);
  console.error(
    "(Paste the HTTPS /mcp URL into Grok Bot custom MCP. Keep the bearer token private.)",
  );
  console.error("==============================");
  console.error("");
  console.error(`Token also stored in ${ENV_LOCAL} (gitignored).`);
  console.error("Stop: Ctrl+C");

  const shutdown = async (signal: string) => {
    console.error(`\n${signal} — shutting down…`);
    try {
      tunnelChild?.kill();
    } catch {
      /* ignore */
    }
    try {
      sock?.end?.(undefined);
    } catch {
      /* ignore */
    }
    closeDatabase();
    waLogger.flush();
    mcpLogger.flush();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
