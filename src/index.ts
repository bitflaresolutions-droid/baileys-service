import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { logger } from "./logger";
import {
  getInstance,
  listInstances,
  resumeAllFromDisk,
  sendText,
  startInstance,
  stopInstance,
} from "./manager";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const API_KEY = process.env.BAILEYS_API_KEY || "";
if (!API_KEY) {
  logger.error("BAILEYS_API_KEY not set — refusing to start");
  process.exit(1);
}

function auth(req: Request, res: Response, next: NextFunction) {
  const h = req.header("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (token !== API_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, instances: listInstances().length });
});

app.use(auth);

// List all instances
app.get("/instances", (_req, res) => {
  res.json({ instances: listInstances() });
});

// Get one instance (status, qr if pairing)
app.get("/instances/:id", (req, res) => {
  const i = getInstance(req.params.id);
  if (!i) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(i);
});

// Create / start (idempotent). Body: { id: string }
app.post("/instances", async (req, res) => {
  const id = String(req.body?.id || "").trim();
  if (!id) {
    res.status(400).json({ error: "id required" });
    return;
  }
  try {
    await startInstance(id);
    res.json({ ok: true, instance: getInstance(id) });
  } catch (err) {
    logger.error({ err, id }, "start failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get QR (data URL) if instance is pairing
app.get("/instances/:id/qr", (req, res) => {
  const i = getInstance(req.params.id);
  if (!i) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ status: i.status, qr: i.qr });
});

// Logout & wipe credentials
app.delete("/instances/:id", async (req, res) => {
  const wipe = req.query.wipe !== "false";
  await stopInstance(req.params.id, wipe);
  res.json({ ok: true });
});

// Send text. Body: { to: string, body: string }
app.post("/instances/:id/send", async (req, res) => {
  const to = String(req.body?.to || "");
  const body = String(req.body?.body || "");
  if (!to || !body) {
    res.status(400).json({ error: "to and body required" });
    return;
  }
  try {
    const r = await sendText(req.params.id, to, body);
    res.json({ ok: true, messageId: r.messageId });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => {
  logger.info({ port: PORT }, "baileys service listening");
  resumeAllFromDisk().catch((err) => logger.error({ err }, "resume-all failed"));
});
