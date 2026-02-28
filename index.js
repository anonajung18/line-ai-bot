import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import crypto from "crypto";

const app = express();
app.use(express.json());

// ---- Gemini setup ----
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genai.getGenerativeModel({
  model: "gemini-2.0-flash",
  systemInstruction: `คุณเป็น AI ผู้ช่วยของครอบครัว ตอบภาษาไทยเป็นกันเอง สุภาพ เข้าใจง่าย
ถ้าถามเรื่องทั่วไปก็ตอบได้เลย เช่น สูตรอาหาร สุขภาพ ข่าวสาร คำแนะนำต่างๆ
ถ้าไม่รู้หรือไม่แน่ใจให้บอกตรงๆ อย่าเดา`,
});

// เก็บประวัติสนทนาแยกต่อ user (จำ 20 ข้อความล่าสุด)
const chatHistory = new Map();

function getHistory(userId) {
  if (!chatHistory.has(userId)) {
    chatHistory.set(userId, []);
  }
  return chatHistory.get(userId);
}

// ---- Line signature verify ----
function verifySignature(rawBody, signature) {
  const hash = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

// ต้องอ่าน raw body ก่อน parse JSON เพื่อ verify signature
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---- Webhook ----
app.post("/webhook", async (req, res) => {
  const signature = req.headers["x-line-signature"];
  if (!verifySignature(req.rawBody, signature)) {
    return res.sendStatus(401);
  }

  res.sendStatus(200); // ตอบ Line ทันที (ต้องทำก่อน ไม่งั้น timeout)

  for (const event of req.body.events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const userId = event.source.userId;
    const userText = event.message.text;
    const replyToken = event.replyToken;

    try {
      const history = getHistory(userId);

      // สนทนากับ Gemini พร้อมประวัติ
      const chat = model.startChat({ history });
      const result = await chat.sendMessage(userText);
      const aiReply = result.response.text();

      // บันทึกประวัติ (เก็บแค่ 20 ข้อความล่าสุด)
      history.push({ role: "user", parts: [{ text: userText }] });
      history.push({ role: "model", parts: [{ text: aiReply }] });
      if (history.length > 20) history.splice(0, history.length - 20);

      // ส่งกลับ Line
      await replyToLine(replyToken, aiReply);
    } catch (err) {
      console.error("Error:", err.message);
      await replyToLine(replyToken, "ขอโทษนะคะ เกิดข้อผิดพลาด ลองใหม่อีกครั้งได้เลย");
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

// Health check
app.get("/", (_req, res) => res.send("Line AI Bot is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
