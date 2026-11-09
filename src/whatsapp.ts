import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  type WAMessage,
  type proto,
  isJidGroup,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import P from "pino";
import fs from "node:fs";
import path from "node:path";
import qrcodeTerminal from "qrcode-terminal";

import {
  initializeDatabase,
  storeMessage,
  storeChat,
  storeContact,
  type Message as DbMessage,
} from "./database.ts";

export const AUTH_DIR = path.join(import.meta.dirname, "..", "auth_info");
const CREDS_PATH = path.join(AUTH_DIR, "creds.json");

/** Linked Devices display name — keep short; changing it requires re-pair. */
export const DEVICE_BROWSER: [string, string, string] = ["mcp", "mcp", "1.0.0"];

/**
 * Print ASCII QR to the terminal only. Never open a browser or ask the user
 * to open image/HTML files.
 */
function printQrAscii(qr: string): void {
  qrcodeTerminal.generate(qr, { small: true }, (ascii: string) => {
    console.error("\n========== WHATSAPP PAIRING QR (scan with phone) ==========");
    console.error(ascii);
    console.error("WhatsApp → Linked Devices → Link a Device → scan above");
    console.error("===========================================================\n");
  });
}

export type SessionStatus = {
  ok: boolean;
  registered: boolean;
  meId: string | null;
  meName: string | null;
  credsPath: string;
  credsBytes: number;
};

export function getSessionStatus(): SessionStatus {
  const status: SessionStatus = {
    ok: false,
    registered: false,
    meId: null,
    meName: null,
    credsPath: CREDS_PATH,
    credsBytes: 0,
  };
  try {
    if (!fs.existsSync(CREDS_PATH)) return status;
    const raw = fs.readFileSync(CREDS_PATH, "utf8");
    status.credsBytes = raw.length;
    if (!raw.trim()) return status;
    const creds = JSON.parse(raw) as {
      registered?: boolean;
      me?: { id?: string; name?: string };
    };
    status.registered = Boolean(creds.registered);
    status.meId = creds.me?.id ?? null;
    status.meName = creds.me?.name ?? null;
    status.ok = Boolean(status.meId) || status.registered;
    return status;
  } catch {
    return status;
  }
}

export type StartWhatsAppOptions = {
  /** Called when a QR string is emitted (default: ASCII to stderr). */
  onQr?: (qr: string) => void;
  /** If true, resolves only after connection === "open". */
  waitUntilOpen?: boolean;
};

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

function parseMessageForDb(msg: WAMessage): DbMessage | null {
  if (!msg.message || !msg.key || !msg.key.remoteJid) {
    return null;
  }

  let content: string | null = null;
  const messageType = Object.keys(msg.message)[0];

  if (msg.message.conversation) {
    content = msg.message.conversation;
  } else if (msg.message.extendedTextMessage?.text) {
    content = msg.message.extendedTextMessage.text;
  } else if (msg.message.imageMessage?.caption) {
    content = `[Image] ${msg.message.imageMessage.caption}`;
  } else if (msg.message.videoMessage?.caption) {
    content = `[Video] ${msg.message.videoMessage.caption}`;
  } else if (msg.message.documentMessage?.caption) {
    content = `[Document] ${
      msg.message.documentMessage.caption ||
      msg.message.documentMessage.fileName ||
      ""
    }`;
  } else if (msg.message.audioMessage) {
    content = `[Audio]`;
  } else if (msg.message.stickerMessage) {
    content = `[Sticker]`;
  } else if (msg.message.locationMessage?.address) {
    content = `[Location] ${msg.message.locationMessage.address}`;
  } else if (msg.message.contactMessage?.displayName) {
    content = `[Contact] ${msg.message.contactMessage.displayName}`;
  } else if (msg.message.pollCreationMessage?.name) {
    content = `[Poll] ${msg.message.pollCreationMessage.name}`;
  }

  if (!content) {
    return null;
  }

  // Use WhatsApp's original message timestamp (seconds since epoch)
  let timestampSeconds: number;

  if (msg.messageTimestamp != null) {
    // Handles number, bigint, and Long-like objects
    timestampSeconds = Number(msg.messageTimestamp);
  } else {
    // Fallback only if WA didn't give us a timestamp at all
    timestampSeconds = Date.now() / 1000;
  }

  const timestamp = new Date(timestampSeconds * 1000);

  let senderJid: string | null | undefined = msg.key.participant;
  if (!msg.key.fromMe && !senderJid && !isJidGroup(msg.key.remoteJid)) {
    senderJid = msg.key.remoteJid;
  }
  if (msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) {
    senderJid = null;
  }

  return {
    id: msg.key.id!,
    chat_jid: msg.key.remoteJid,
    sender: senderJid ? jidNormalizedUser(senderJid) : null,
    content: content,
    timestamp: timestamp,
    is_from_me: msg.key.fromMe ?? false,
  };
}

export async function startWhatsAppConnection(
  logger: P.Logger,
  options: StartWhatsAppOptions = {}
): Promise<WhatsAppSocket> {
  initializeDatabase();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  const onQr = options.onQr ?? printQrAscii;
  let resolveOpen: ((sock: WhatsAppSocket) => void) | null = null;
  let rejectOpen: ((err: Error) => void) | null = null;
  const openPromise =
    options.waitUntilOpen === true
      ? new Promise<WhatsAppSocket>((resolve, reject) => {
          resolveOpen = resolve;
          rejectOpen = reject;
        })
      : null;

  // Linked Devices label is the browser tuple — default Baileys used Ubuntu/Chrome.
  const sock = makeWASocket({
    version,
    logger,
    browser: DEVICE_BROWSER,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid: (jid) => isJidGroup(jid),
  });

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info({ qrCodeData: qr }, "QR Code received — ASCII terminal only.");
        onQr(qr);
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        logger.warn(
          `Connection closed. Reason: ${
            DisconnectReason[statusCode as number] || "Unknown"
          }`,
          lastDisconnect?.error
        );
        if (statusCode !== DisconnectReason.loggedOut) {
          logger.info("Reconnecting...");
          // Do not re-enter waitUntilOpen (would orphan the original promise).
          startWhatsAppConnection(logger, {
            onQr: options.onQr,
            waitUntilOpen: false,
          });
        } else {
          logger.error(
            "Connection closed: Logged Out. Please delete auth_info and restart."
          );
          rejectOpen?.(new Error("Logged out"));
          process.exit(1);
        }
      } else if (connection === "open") {
        logger.info(`Connection opened. WA user: ${sock.user?.name}`);
        console.error(
          `[pairing] Connected as ${sock.user?.id ?? sock.user?.name ?? "unknown"} (device label: mcp)`
        );
        resolveOpen?.(sock);
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
      logger.info("Credentials saved.");
    }

    if (events["messaging-history.set"]) {
      const { chats, contacts, messages, isLatest, progress, syncType } =
        events["messaging-history.set"];
      if (contacts.length > 0) {
        logger.info(`Storing ${contacts.length} contacts from history sync.`);
        contacts.forEach((c) =>
          storeContact({
            jid: c.id,
            name: c.name ?? null,
            notify: c.notify ?? null,
            phoneNumber: (c as any).phoneNumber ?? null,
          })
        );
        logger.info(`Stored ${contacts.length} contacts from history sync.`);
      }

      logger.info(`Storing ${chats.length} chats from history sync.`);
      chats.forEach((chat) =>
        storeChat({
          jid: chat.id,
          name: chat.name,
          last_message_time: chat.conversationTimestamp
            ? new Date(Number(chat.conversationTimestamp) * 1000)
            : undefined,
        })
      );

      let storedCount = 0;
      messages.forEach((msg) => {
        const parsed = parseMessageForDb(msg);
        if (parsed) {
          storeMessage(parsed);
          storedCount++;
        }
      });
      logger.info(`Stored ${storedCount} messages from history sync.`);
    }

    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      logger.info(
        { type, count: messages.length },
        "Received messages.upsert event"
      );

      if (type === "notify" || type === "append") {
        for (const msg of messages) {
          const parsed = parseMessageForDb(msg);
          if (parsed) {
            logger.info(
              {
                msgId: parsed.id,
                chatId: parsed.chat_jid,
                fromMe: parsed.is_from_me,
                sender: parsed.sender,
              },
              `Storing message: ${parsed.content.substring(0, 50)}...`
            );
            storeMessage(parsed);
          } else {
            logger.warn(
              { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
              "Skipped storing message (parsing failed or unsupported type)"
            );
          }
        }
      }
    }

    if (events["chats.update"]) {
      logger.info(
        { count: events["chats.update"].length },
        "Received chats.update event"
      );
      for (const chatUpdate of events["chats.update"]) {
        storeChat({
          jid: chatUpdate.id!,
          name: chatUpdate.name,
          last_message_time: chatUpdate.conversationTimestamp
            ? new Date(Number(chatUpdate.conversationTimestamp) * 1000)
            : undefined,
        });
      }
    }
  });

  if (openPromise) {
    return openPromise;
  }
  return sock;
}

export async function sendWhatsAppMessage(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  recipientJid: string,
  text: string
): Promise<proto.WebMessageInfo | void> {
  if (!sock || !sock.user) {
    logger.error(
      "Cannot send message: WhatsApp socket not connected or initialized."
    );
    return;
  }
  if (!recipientJid) {
    logger.error("Cannot send message: Recipient JID is missing.");
    return;
  }
  if (!text) {
    logger.error("Cannot send message: Message text is empty.");
    return;
  }

  try {
    logger.info(
      `Sending message to ${recipientJid}: ${text.substring(0, 50)}...`
    );
    const normalizedJid = jidNormalizedUser(recipientJid);
    const result = await sock.sendMessage(normalizedJid, { text: text });
    logger.info({ msgId: result?.key.id }, "Message sent successfully");
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid }, "Failed to send message");
    return;
  }
}
