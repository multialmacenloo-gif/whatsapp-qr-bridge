const express = require("express");
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const fetch = require("node-fetch");
const P = require("pino");

const app = express();
app.use(express.json({ limit: "20mb" }));

const API_SECRET = process.env.API_SECRET || "changeme";
const CONVEX_WEBHOOK_URL = process.env.CONVEX_WEBHOOK_URL || "";
const PORT = process.env.PORT || 3000;

let qrDataUrl = null;
let isReady = false;
let sock = null;

function requireSecret(req, res, next) {
  if (req.headers["x-api-secret"] !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function startClient() {
  const { state, saveCreds } = await useMultiFileAuthState("/tmp/wa_auth");
  sock = makeWASocket({ auth: state, logger: P({ level: "silent" }), printQRInTerminal: false });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) { isReady = false; qrDataUrl = await QRCode.toDataURL(qr); }
    if (connection === "open") { isReady = true; qrDataUrl = null; console.log("[WA] Connected!"); }
    if (connection === "close") {
      isReady = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(startClient, 5000);
    }
  });
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const from = msg.key.remoteJid?.replace("@s.whatsapp.net", "") || "";
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
      if (!text) continue;
      const payload = {
        object: "whatsapp_business_account",
        entry: [{ id: "qr_bridge", changes: [{ field: "messages", value: {
          messaging_product: "whatsapp",
          contacts: [{ profile: { name: msg.pushName || from }, wa_id: from }],
          messages: [{ from, id: msg.key.id, type: "text", text: { body: text }, timestamp: String(Math.floor(Date.now()/1000)) }],
        }}]}],
      };
      if (CONVEX_WEBHOOK_URL) {
        await fetch(CONVEX_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-qr-bridge": "true" }, body: JSON.stringify(payload) }).catch(console.error);
      }
    }
  });
}

startClient();

app.get("/health", (req, res) => res.json({ status: "ok", waReady: isReady }));

app.get("/qr", (req, res) => {
  if (isReady) return res.json({ status: "connected" });
  if (!qrDataUrl) return res.json({ status: "loading", message: "Generando QR, recarga en 10 segundos..." });
  res.send(`<!DOCTYPE html><html><head><title>Escanea QR</title><meta http-equiv="refresh" content="10"><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f0f0}.card{background:white;border-radius:16px;padding:32px;text-align:center}h2{color:#128C7E}img{width:280px;height:280px}</style></head><body><div class="card"><h2>Conectar WhatsApp</h2><p>Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p><img src="${qrDataUrl}"/><p style="font-size:12px;color:#999">Se recarga cada 10 segundos</p></div></body></html>`);
});

app.post("/send", requireSecret, async (req, res) => {
  if (!isReady || !sock) return res.status(503).json({ error: "WhatsApp not connected" });
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ error: "Missing to or text" });
  try {
    await sock.sendMessage(`${to.replace(/\D/g,"")}@s.whatsapp.net`, { text });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));

