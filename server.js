const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const express = require("express");
const QRCode = require("qrcode");
const fetch = require("node-fetch");
const app = express();
app.use(express.json({ limit: "20mb" }));
const API_SECRET = process.env.API_SECRET || "changeme";
const CONVEX_WEBHOOK_URL = process.env.CONVEX_WEBHOOK_URL || "";
const PORT = process.env.PORT || 8080;
let qrDataUrl = null;
let isReady = false;
let waClient = null;

function requireSecret(req, res, next) {
  const auth = req.headers["x-api-secret"];
  if (auth !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function startClient() {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: "/tmp/wwebjs_auth" }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-accelerated-2d-canvas","--no-first-run","--no-zygote","--single-process","--disable-gpu"],
    },
  });

  client.on("qr", async (qr) => {
    console.log("[WA] QR received");
    isReady = false;
    try { qrDataUrl = await QRCode.toDataURL(qr); } catch (e) { console.error(e); }
  });

  client.on("ready", () => {
    console.log("[WA] Client ready!");
    isReady = true;
    qrDataUrl = null;
  });

  client.on("disconnected", (reason) => {
    console.log("[WA] Disconnected:", reason);
    isReady = false;
    qrDataUrl = null;
    setTimeout(startClient, 5000);
  });

  client.on("message", async (msg) => {
    if (msg.fromMe) return;
    try {
      const contact = await msg.getContact();
      // Use contact.number to get the real phone number (handles @lid accounts)
      const from = contact.number || msg.from.replace("@c.us", "").replace("@lid", "");
      const profileName = contact.pushname || contact.name || from;

      let messageType = "text";
      let text = msg.body || "";
      let mediaBase64 = null;
      let mimeType = null;
      let fileName = null;

      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            mediaBase64 = media.data;
            mimeType = media.mimetype;
            fileName = media.filename || null;
            if (mimeType?.startsWith("image/")) { messageType = "image"; text = text || "Imagen"; }
            else if (mimeType?.startsWith("audio/")) { messageType = "audio"; text = text || "Audio"; }
            else { messageType = "file"; text = text || fileName || "Archivo"; }
          }
        } catch (e) { console.error("[WA] Media error:", e); }
      }

      if (!text) return;

      // Send simple format directly — easier to parse on the Convex side
      const payload = {
        from,
        profileName,
        text,
        messageType,
        mimeType,
        fileName,
        mediaBase64,
      };

      if (CONVEX_WEBHOOK_URL) {
        const r = await fetch(CONVEX_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-secret": API_SECRET,
          },
          body: JSON.stringify(payload),
        });
        console.log("[WA] forwarded, status:", r.status);
      }
    } catch (e) { console.error("[WA] error:", e); }
  });

  client.initialize();
  waClient = client;
}

startClient();

app.get("/health", (req, res) => res.json({ status: "ok", waReady: isReady }));

app.get("/qr", (req, res) => {
  if (isReady) return res.json({ status: "connected" });
  if (!qrDataUrl) return res.json({ status: "loading", message: "Generando QR..." });
  res.send('<!DOCTYPE html><html><head><title>QR</title><meta http-equiv="refresh" content="10"><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f0f0;}.card{background:white;border-radius:16px;padding:32px;text-align:center;}h2{color:#128C7E;}</style></head><body><div class="card"><h2>Escanea el QR</h2><p>WhatsApp Business → Dispositivos vinculados → Vincular dispositivo</p><img src="' + qrDataUrl + '" width="280" height="280"/></div></body></html>');
});

app.get("/qr.json", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (isReady) return res.json({ status: "connected" });
  if (!qrDataUrl) return res.json({ status: "loading" });
  return res.json({ status: "qr", qrDataUrl });
});

app.post("/send", requireSecret, async (req, res) => {
  if (!isReady || !waClient) return res.status(503).json({ error: "WhatsApp not connected" });
  const { to, text, mediaBase64, mimeType, fileName } = req.body;
  if (!to) return res.status(400).json({ error: "Missing to" });
  try {
    const chatId = to.replace(/\D/g, "") + "@c.us";
    if (mediaBase64 && mimeType) {
      const media = new MessageMedia(mimeType, mediaBase64, fileName || "file");
      await waClient.sendMessage(chatId, media, { caption: text });
    } else {
      await waClient.sendMessage(chatId, text || "");
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/disconnect", requireSecret, async (req, res) => {
  if (waClient) await waClient.logout().catch(() => {});
  isReady = false;
  res.json({ success: true });
});

app.listen(PORT, () => console.log("[Server] Listening on port " + PORT));
