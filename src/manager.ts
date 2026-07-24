import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
  type ConnectionState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { logger } from "./logger";
import { emit } from "./webhook";

const SESSION_DIR = process.env.SESSION_DIR || "./sessions";

type Instance = {
  id: string;
  sock: WASocket | null;
  status: "connecting" | "qr" | "open" | "close";
  qr: string | null; // base64 PNG data URL
  phone: string | null;
  lastError: string | null;
  startedAt: number;
};

const instances = new Map<string, Instance>();

function ensureDir(): void {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

function sessionPath(id: string): string {
  return join(SESSION_DIR, id);
}

export function listInstances() {
  return [...instances.values()].map((i) => ({
    id: i.id,
    status: i.status,
    phone: i.phone,
    hasQr: !!i.qr,
    lastError: i.lastError,
    startedAt: i.startedAt,
  }));
}

export function getInstance(id: string) {
  const i = instances.get(id);
  if (!i) return null;
  return {
    id: i.id,
    status: i.status,
    phone: i.phone,
    qr: i.qr,
    lastError: i.lastError,
    startedAt: i.startedAt,
  };
}

export async function startInstance(id: string): Promise<void> {
  ensureDir();
  let inst = instances.get(id);
  if (inst && inst.sock && inst.status === "open") return;

  if (!inst) {
    inst = {
      id,
      sock: null,
      status: "connecting",
      qr: null,
      phone: null,
      lastError: null,
      startedAt: Date.now(),
    };
    instances.set(id, inst);
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath(id));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: logger.child({ instance: id }) as any,
    browser: ["Reachly", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });
  inst.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u: Partial<ConnectionState>) => {
    const cur = instances.get(id);
    if (!cur) return;

    if (u.qr) {
      try {
        const dataUrl = await QRCode.toDataURL(u.qr, { margin: 1, scale: 6 });
        cur.qr = dataUrl;
        cur.status = "qr";
        await emit({ type: "connection.update", instanceId: id, state: "qr", qr: dataUrl });
      } catch (err) {
        logger.error({ err }, "qr encode failed");
      }
    }

    if (u.connection === "open") {
      cur.status = "open";
      cur.qr = null;
      cur.lastError = null;
      const jid = sock.user?.id || "";
      cur.phone = jid ? jid.split(":")[0].split("@")[0] : null;
      await emit({
        type: "connection.update",
        instanceId: id,
        state: "open",
        phone: cur.phone || undefined,
      });
    }

    if (u.connection === "close") {
      const boom = u.lastDisconnect?.error as Boom | undefined;
      const code = boom?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      cur.status = "close";
      cur.lastError = boom?.message || `closed (code ${code ?? "?"})`;
      await emit({
        type: "connection.update",
        instanceId: id,
        state: "close",
        reason: cur.lastError,
      });
      if (loggedOut) {
        try {
          rmSync(sessionPath(id), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        instances.delete(id);
        logger.warn({ id }, "logged out, session cleared");
      } else {
        // reconnect after short delay
        setTimeout(() => {
          startInstance(id).catch((err) =>
            logger.error({ err, id }, "reconnect failed"),
          );
        }, 2000);
      }
    }
  });

  sock.ev.on("messages.upsert", async (ev) => {
    if (ev.type !== "notify") return;
    for (const m of ev.messages) {
      const jid = m.key.remoteJid || "";
      if (jid.endsWith("@g.us") || jid === "status@broadcast") continue;
      const text =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        "";
      await emit({
        type: "message.upsert",
        instanceId: id,
        messageId: m.key.id || "",
        from: jid.split("@")[0],
        fromMe: !!m.key.fromMe,
        text,
        timestamp:
          typeof m.messageTimestamp === "number"
            ? m.messageTimestamp
            : Number(m.messageTimestamp || Date.now() / 1000),
      });
    }
  });

  sock.ev.on("messages.update", async (updates) => {
    for (const u of updates) {
      const s = u.update?.status;
      if (s == null) continue;
      // Baileys status enum: 0 ERROR, 1 PENDING, 2 SERVER_ACK (sent), 3 DELIVERY_ACK (delivered), 4 READ, 5 PLAYED
      const map: Record<number, "sent" | "delivered" | "read" | "failed"> = {
        0: "failed",
        2: "sent",
        3: "delivered",
        4: "read",
        5: "read",
      };
      const status = map[s as number];
      if (!status) continue;
      await emit({
        type: "message.status",
        instanceId: id,
        messageId: u.key.id || "",
        status,
        to: (u.key.remoteJid || "").split("@")[0],
      });
    }
  });
}

export async function stopInstance(id: string, wipe = false): Promise<void> {
  const inst = instances.get(id);
  if (inst?.sock) {
    try {
      await inst.sock.logout().catch(() => inst.sock?.end(undefined));
    } catch {
      /* ignore */
    }
  }
  instances.delete(id);
  if (wipe) {
    try {
      rmSync(sessionPath(id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export async function sendText(
  id: string,
  to: string,
  body: string,
): Promise<{ messageId: string }> {
  const inst = instances.get(id);
  if (!inst || !inst.sock || inst.status !== "open") {
    throw new Error(`instance ${id} not connected`);
  }
  const digits = String(to).replace(/[^\d]/g, "");
  if (!digits) throw new Error("invalid recipient");
  const jid = `${digits}@s.whatsapp.net`;
  const res = await inst.sock.sendMessage(jid, { text: body });
  return { messageId: res?.key.id || "" };
}

// On boot, resume any instance whose session directory already exists.
export async function resumeAllFromDisk(): Promise<void> {
  ensureDir();
  const { readdirSync, statSync } = await import("fs");
  const entries = readdirSync(SESSION_DIR);
  for (const name of entries) {
    try {
      if (statSync(join(SESSION_DIR, name)).isDirectory()) {
        logger.info({ id: name }, "resuming instance from disk");
        startInstance(name).catch((err) =>
          logger.error({ err, id: name }, "resume failed"),
        );
      }
    } catch {
      /* ignore */
    }
  }
}
