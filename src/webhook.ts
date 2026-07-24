import { createHmac } from "crypto";
import { logger } from "./logger";

const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

export type WebhookEvent =
  | {
      type: "connection.update";
      instanceId: string;
      state: "connecting" | "open" | "close" | "qr" | "pairing";
      qr?: string; // base64 PNG data URL
      reason?: string;
      phone?: string;
    }
  | {
      type: "message.upsert";
      instanceId: string;
      messageId: string;
      from: string; // digits only
      fromMe: boolean;
      text: string;
      timestamp: number;
    }
  | {
      type: "message.status";
      instanceId: string;
      messageId: string;
      status: "sent" | "delivered" | "read" | "failed";
      to?: string;
    };

export async function emit(event: WebhookEvent): Promise<void> {
  if (!WEBHOOK_URL) {
    logger.warn({ event: event.type }, "no WEBHOOK_URL configured, skipping");
    return;
  }
  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-baileys-event": event.type,
  };
  if (WEBHOOK_SECRET) {
    headers["x-webhook-signature"] = createHmac("sha256", WEBHOOK_SECRET)
      .update(body)
      .digest("hex");
  }
  try {
    const res = await fetch(WEBHOOK_URL, { method: "POST", headers, body });
    if (!res.ok) {
      logger.warn(
        { status: res.status, event: event.type },
        "webhook non-2xx",
      );
    }
  } catch (err) {
    logger.error({ err, event: event.type }, "webhook delivery failed");
  }
}
