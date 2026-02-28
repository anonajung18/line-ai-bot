import "dotenv/config";
import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json());

// ---- Gemini setup ----
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genai.getGenerativeModel({
  model: "gemini-2.5-flash",
  systemInstruction: `คุณเป็น AI ผู้ช่วยชายของครอบครัว ตอบภาษาไทยเป็นกันเอง ใช้คำลงท้าย "ครับ" เสมอ
เชี่ยวชาญเรื่องเกษตร พืชผัก ปุ๋ย ยาฆ่าแมลง การทำสวน
ตอบเรื่องทั่วไปได้ด้วย เช่น สุขภาพ ข่าวสาร คำแนะนำต่างๆ
ถ้าไม่รู้หรือไม่แน่ใจให้บอกตรงๆ อย่าเดา`,
});

// ---- เก็บ log พร้อม timestamp ----
const logs = []; // { timestamp: Date, userId, userText, aiReply }

function addLog(userId, displayName, userText, aiReply) {
  logs.push({
    timestamp: new Date(),
    userId,
    displayName,
    userText,
    aiReply: aiReply.slice(0, 80) + (aiReply.length > 80 ? "..." : ""),
  });
  // เก็บแค่ 7 วันย้อนหลัง
  const limit = Date.now() - 7 * 24 * 60 * 60 * 1000;
  while (logs.length > 0 && logs[0].timestamp.getTime() < limit) logs.shift();
}

// ดึงชื่อ Line ของ user
const nameCache = new Map();
async function getDisplayName(userId) {
  if (nameCache.has(userId)) return nameCache.get(userId);
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    const data = await res.json();
    nameCache.set(userId, data.displayName || userId);
    return data.displayName || userId;
  } catch {
    return userId;
  }
}

function formatTime(date) {
  return date.toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
}

function formatDate(date) {
  return date.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "long", year: "numeric" });
}

function buildReport(filteredLogs, title) {
  if (filteredLogs.length === 0) return `${title}\n\nไม่มีการสนทนาครับ`;
  const userCount = new Set(filteredLogs.map((l) => l.userId)).size;
  const lines = filteredLogs
    .map((l) => `🕐 ${formatTime(l.timestamp)} · ${l.displayName}\n💬 ${l.userText}\n🤖 ${l.aiReply}`)
    .join("\n─────────\n");
  return `${title}\n👥 ${userCount} คน | 💬 ${filteredLogs.length} ข้อความ\n\n${lines}`;
}

// ---- Push message หา admin (แบ่งถ้ายาวเกิน) ----
async function pushToAdmin(text) {
  const adminId = process.env.ADMIN_USER_ID;
  if (!adminId) return;

  // Line รับได้สูงสุด 5000 ตัวอักษรต่อข้อความ
  const chunks = [];
  while (text.length > 4800) {
    const cut = text.lastIndexOf("\n─────────\n", 4800);
    chunks.push(text.slice(0, cut > 0 ? cut : 4800));
    text = text.slice(cut > 0 ? cut + 11 : 4800);
  }
  chunks.push(text);

  for (const chunk of chunks) {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ to: adminId, messages: [{ type: "text", text: chunk }] }),
    });
  }
}

// ---- รายงานอัตโนมัติทุกวัน 08:00 น. ----
function scheduleDailyReport() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(1, 0, 0, 0); // 08:00 ไทย = 01:00 UTC
  if (next <= now) next.setDate(next.getDate() + 1);

  setTimeout(async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const todayLogs = logs.filter((l) => l.timestamp >= since);
    const report = buildReport(todayLogs, `📊 รายงานประจำวัน ${formatDate(new Date())}`);
    await pushToAdmin(report);
    scheduleDailyReport();
  }, next - now);
}

scheduleDailyReport();

// ---- เก็บประวัติสนทนาแยกต่อ user ----
const chatHistory = new Map();

function getHistory(userId) {
  if (!chatHistory.has(userId)) chatHistory.set(userId, []);
  return chatHistory.get(userId);
}

// ---- Webhook ----
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  for (const event of req.body.events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const userId = event.source.userId;
    const userText = event.message.text.trim();
    const replyToken = event.replyToken;
    const isAdmin = userId === process.env.ADMIN_USER_ID;

    console.log(`[${userId}] ${userText}`);

    // ---- คำสั่งพิเศษ (admin เท่านั้น) ----
    if (isAdmin && userText === "รายงาน") {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = logs.filter((l) => l.timestamp >= since);
      const report = buildReport(recent, `📊 รายงานย้อนหลัง 24 ชม. (${formatDate(new Date())})`);
      await replyToLine(replyToken, report.slice(0, 4800));
      continue;
    }

    // ---- สนทนาปกติ ----
    try {
      const history = getHistory(userId);
      const chat = model.startChat({ history });
      const result = await chat.sendMessage(userText);
      const aiReply = result.response.text();

      history.push({ role: "user", parts: [{ text: userText }] });
      history.push({ role: "model", parts: [{ text: aiReply }] });
      if (history.length > 20) history.splice(0, history.length - 20);

      const displayName = await getDisplayName(userId);
      addLog(userId, displayName, userText, aiReply);
      await replyToLine(replyToken, aiReply);
    } catch (err) {
      console.error("Error:", err.message);
      await replyToLine(replyToken, "ขอโทษนะครับ เกิดข้อผิดพลาด ลองใหม่อีกครั้งได้เลยครับ");
    }
  }
});

async function replyToLine(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
}

app.get("/", (_req, res) => res.send("Line AI Bot is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
