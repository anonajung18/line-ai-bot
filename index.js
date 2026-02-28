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

// ---- เก็บ log รายวัน ----
const dailyLogs = [];

function addLog(userId, userText, aiReply) {
  const time = new Date().toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok" });
  dailyLogs.push({ time, userId, userText, aiReply: aiReply.slice(0, 60) + (aiReply.length > 60 ? "..." : "") });
}

// ---- Push message หา admin ----
async function pushToAdmin(text) {
  const adminId = process.env.ADMIN_USER_ID;
  if (!adminId) return;
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: adminId,
      messages: [{ type: "text", text }],
    }),
  });
}

// ---- รายงานทุกวัน 08:00 น. (UTC+7) ----
function scheduleDailyReport() {
  const now = new Date();
  const next = new Date();
  // 08:00 น. ไทย = 01:00 UTC
  next.setUTCHours(1, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  setTimeout(async () => {
    const date = new Date().toLocaleDateString("th-TH", {
      timeZone: "Asia/Bangkok",
      day: "numeric", month: "long", year: "numeric",
    });

    let report;
    if (dailyLogs.length === 0) {
      report = `📊 รายงานประจำวัน ${date}\n\nไม่มีการสนทนาเมื่อวานครับ`;
    } else {
      const userCount = new Set(dailyLogs.map((l) => l.userId)).size;
      const lines = dailyLogs.map((l) => `🕐 ${l.time}\n💬 ${l.userText}\n🤖 ${l.aiReply}`).join("\n─────────\n");
      report = `📊 รายงานประจำวัน ${date}\n👥 ผู้ใช้ ${userCount} คน | 💬 ${dailyLogs.length} ข้อความ\n\n${lines}`;
    }

    await pushToAdmin(report);
    dailyLogs.length = 0;
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
    const userText = event.message.text;
    const replyToken = event.replyToken;

    console.log(`[userId: ${userId}] ${userText}`);

    // คำสั่งพิเศษ: ส่ง "รายงาน" เพื่อดู log ทันที
    if (userText === "รายงาน" && userId === process.env.ADMIN_USER_ID) {
      const date = new Date().toLocaleDateString("th-TH", {
        timeZone: "Asia/Bangkok", day: "numeric", month: "long", year: "numeric",
      });
      const report = dailyLogs.length === 0
        ? `📊 รายงานวันนี้ ${date}\n\nยังไม่มีการสนทนาครับ`
        : `📊 รายงานวันนี้ ${date}\n👥 ผู้ใช้ ${new Set(dailyLogs.map(l => l.userId)).size} คน | 💬 ${dailyLogs.length} ข้อความ\n\n` +
          dailyLogs.map(l => `🕐 ${l.time}\n💬 ${l.userText}\n🤖 ${l.aiReply}`).join("\n─────────\n");
      await replyToLine(replyToken, report);
      continue;
    }

    try {
      const history = getHistory(userId);
      const chat = model.startChat({ history });
      const result = await chat.sendMessage(userText);
      const aiReply = result.response.text();

      history.push({ role: "user", parts: [{ text: userText }] });
      history.push({ role: "model", parts: [{ text: aiReply }] });
      if (history.length > 20) history.splice(0, history.length - 20);

      addLog(userId, userText, aiReply);
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
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

app.get("/", (_req, res) => res.send("Line AI Bot is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
