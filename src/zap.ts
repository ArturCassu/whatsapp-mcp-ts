/**
 * zap — CLI for the local WhatsApp Baileys MCP install.
 * Shares auth_info/ + data/ with the MCP server. Prefer `zap pair` for QR UX;
 * keep Cursor mcp.json disabled while pairing (one process only).
 */
import { pino } from "pino";
import path from "node:path";
import {
  initializeDatabase,
  getChats,
  searchMessages,
  closeDatabase,
} from "./database.ts";
import {
  AUTH_DIR,
  DEVICE_BROWSER,
  getSessionStatus,
  startWhatsAppConnection,
  sendWhatsAppMessage,
  type WhatsAppSocket,
} from "./whatsapp.ts";

const ROOT = path.join(import.meta.dirname, "..");

function usage(): never {
  console.log(`zap — WhatsApp MCP CLI (${ROOT})

Usage:
  zap pair                 Pair via QR in this terminal (ASCII). Exit when connected.
  zap status               Session / auth_info health
  zap chats [limit]        List recent chats from local SQLite
  zap search <query>       Search messages in local SQLite
  zap send <jid|phone> <text...>   Send a message (needs live session)
  zap serve [--no-tunnel] [--port N]   Always-on HTTP MCP (Streamable HTTP) + optional Cloudflare tunnel

Env (zap serve):
  ZAP_MCP_TOKEN            Bearer token (auto-generated into .env.local if missing)
  ZAP_MCP_PORT             Local port (default 8787)
  ZAP_MCP_HOST             Bind host (default 127.0.0.1)
  ZAP_MCP_PUBLIC_URL       Override public base URL (skip detecting tunnel URL)
  ZAP_MCP_NO_TUNNEL=1      Do not start cloudflared
  CLOUDFLARED_PATH         Path to cloudflared.exe if not on PATH

One-socket rule: while \`zap serve\` owns Baileys, keep Cursor mcp.json whatsapp disabled.
Device Linked-Devices label: ${DEVICE_BROWSER.join(" / ")}
Auth: ${AUTH_DIR}
`);
  process.exit(1);
}

function makeWaLogger() {
  return pino(
    {
      level: process.env.LOG_LEVEL || "warn",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination(path.join(ROOT, "wa-logs.txt"))
  );
}

function normalizeRecipient(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) {
    throw new Error(`Invalid recipient: ${input}`);
  }
  return `${digits}@s.whatsapp.net`;
}

async function cmdPair(): Promise<void> {
  const status = getSessionStatus();
  if (status.ok) {
    console.error(
      `Session already looks paired (me=${status.meId ?? "?"}). Continuing connect to verify…`
    );
  }
  console.error("Starting pairing… keep Cursor WhatsApp MCP disabled until this exits.");
  console.error(`Device name will register as: mcp`);
  console.error("Unlink any old 'ubuntu' / previous device on the phone first if renaming.\n");

  const logger = makeWaLogger();
  initializeDatabase();
  const sock = await startWhatsAppConnection(logger, { waitUntilOpen: true });

  // Give creds a moment to flush
  await new Promise((r) => setTimeout(r, 1500));
  const after = getSessionStatus();
  console.error(
    after.ok
      ? `Paired OK. me=${after.meId ?? "?"} name=${after.meName ?? "?"}`
      : `Connected but creds look incomplete (bytes=${after.credsBytes}). Check auth_info/creds.json.`
  );
  console.error("Safe to stop this process. Enable mcp.json and restart Cursor when ready.");
  try {
    sock.end?.(undefined);
  } catch {
    /* ignore */
  }
  closeDatabase();
  process.exit(after.ok ? 0 : 2);
}

function cmdStatus(): void {
  const s = getSessionStatus();
  console.log(
    JSON.stringify(
      {
        connected_session: s.ok,
        registered: s.registered,
        meId: s.meId,
        meName: s.meName,
        credsBytes: s.credsBytes,
        credsPath: s.credsPath,
        deviceLabel: DEVICE_BROWSER,
        projectRoot: ROOT,
      },
      null,
      2
    )
  );
  process.exit(s.ok ? 0 : 1);
}

function cmdChats(limitArg?: string): void {
  initializeDatabase();
  const limit = Math.min(Math.max(Number(limitArg) || 20, 1), 100);
  const chats = getChats(limit, 0, "last_active", null, true);
  if (chats.length === 0) {
    console.log("(no chats in local DB yet — pair and sync, or wait for history)");
  } else {
    for (const c of chats) {
      const when = c.last_message_time?.toISOString?.() ?? "";
      const preview = (c.last_message ?? "").replace(/\s+/g, " ").slice(0, 80);
      console.log(`${c.jid}\t${c.name ?? ""}\t${when}\t${preview}`);
    }
  }
  closeDatabase();
}

function cmdSearch(query: string): void {
  if (!query) usage();
  initializeDatabase();
  const rows = searchMessages(query, null, 20, 0);
  if (rows.length === 0) {
    console.log("(no matches)");
  } else {
    for (const m of rows) {
      const t = m.timestamp.toISOString();
      const content = m.content.replace(/\s+/g, " ").slice(0, 120);
      console.log(`${t}\t${m.chat_name ?? m.chat_jid}\t${content}`);
    }
  }
  closeDatabase();
}

async function cmdSend(recipient: string, textParts: string[]): Promise<void> {
  const text = textParts.join(" ").trim();
  if (!recipient || !text) usage();
  const jid = normalizeRecipient(recipient);
  const logger = makeWaLogger();
  initializeDatabase();
  console.error(`Connecting to send to ${jid}…`);
  const sock: WhatsAppSocket = await startWhatsAppConnection(logger, {
    waitUntilOpen: true,
  });
  const result = await sendWhatsAppMessage(logger, sock, jid, text);
  if (result?.key?.id) {
    console.log(`sent id=${result.key.id} to=${jid}`);
    process.exitCode = 0;
  } else {
    console.error("send failed (see wa-logs.txt)");
    process.exitCode = 1;
  }
  try {
    sock.end?.(undefined);
  } catch {
    /* ignore */
  }
  closeDatabase();
  process.exit(process.exitCode ?? 0);
}

async function cmdServe(argv: string[]): Promise<void> {
  let tunnel = true;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-tunnel") tunnel = false;
    else if (a === "--port" || a === "-p") {
      port = Number(argv[++i]);
      if (!Number.isFinite(port) || port <= 0) {
        console.error("Invalid --port");
        process.exit(1);
      }
    } else if (a === "-h" || a === "--help") usage();
    else {
      console.error(`Unknown serve option: ${a}`);
      usage();
    }
  }
  const { runHttpServe } = await import("./httpServe.ts");
  await runHttpServe({ tunnel, port });
  // Keep process alive — runHttpServe registers signal handlers.
  await new Promise(() => undefined);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "pair":
      await cmdPair();
      break;
    case "status":
      cmdStatus();
      break;
    case "chats":
      cmdChats(rest[0]);
      break;
    case "search":
      cmdSearch(rest.join(" ").trim());
      break;
    case "send":
      await cmdSend(rest[0], rest.slice(1));
      break;
    case "serve":
      await cmdServe(rest);
      break;
    case "-h":
    case "--help":
    case "help":
    case undefined:
      usage();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
