require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const Groq = require("groq-sdk");

const http = require("http");
const { Server } = require("socket.io");

const connectDB = require("./config/db");

const authRoutes = require("./routes/authRoutes");
const roomRoutes = require("./routes/roomRoutes");
const Message = require("./models/Message");
const Room = require("./models/Room");
const User = require("./models/User");

// --- Groq client ---
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const app = express();

connectDB();

// --- Nerd Bot: ensure bot user exists ---
let nerdBotUser = null;
async function ensureNerdBot() {
  try {
    nerdBotUser = await User.findOne({ username: "nerd" });
    if (!nerdBotUser) {
      nerdBotUser = await User.create({
        username: "nerd",
        email: "nerd@studyroom.bot",
        password: require("crypto").randomBytes(32).toString("hex") + "Aa1!"
      });
      console.log("Nerd bot user created");
    }
    console.log("Nerd bot ready, id:", nerdBotUser._id);
  } catch (err) {
    console.error("Failed to ensure nerd bot user:", err.message);
  }
}
// Call after DB connects (mongoose buffers, so this is safe)
ensureNerdBot();

// --- Nerd AI response generator (Groq) ---
async function generateNerdReply(userMessage, recentMessages) {
  try {
    // Build conversation context from recent messages
    const context = recentMessages.map(m => ({
      role: "user",
      content: `${m.sender}: ${m.text}`
    }));

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `You are "nerd", a friendly and knowledgeable AI study assistant living in a study room chat. You help students with their questions, explain concepts clearly, and encourage good study habits. Keep responses concise (under 300 words) and conversational. Use simple language. If you don't know something, say so honestly. You can use light humour to keep things engaging. Do not use markdown formatting — just plain text.`
        },
        ...context,
        { role: "user", content: userMessage }
      ],
      max_tokens: 500,
      temperature: 0.7
    });

    return response.choices[0].message.content.trim();
  } catch (err) {
    console.error("Groq API error:", err.status, err.message);
    if (err.status === 429) {
      return "I've hit my usage limit for now. Try again in a minute! 😅";
    }
    if (err.status === 401) {
      return "My API key seems invalid. Ask the admin to check the GROQ_API_KEY in .env 🔑";
    }
    return "Sorry, I'm having trouble thinking right now. Try again in a moment! 🤔";
  }
}

app.use(cors());
app.use(express.json());

// ---- Static file serving for uploads ----
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// ---- Serve frontend ----
app.use(express.static(path.join(__dirname, "public")));

// ---- Multer config ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB limit
});

function getFileType(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

app.use("/api/auth", authRoutes);
app.use("/api/rooms", roomRoutes);

// ---- File upload endpoint ----
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const { roomCode, sender } = req.body;
    const file = req.file;
    if (!roomCode || !sender || !file) {
      return res.status(400).json({ message: "roomCode, sender, and file are required" });
    }
    if (!mongoose.Types.ObjectId.isValid(sender)) {
      return res.status(400).json({ message: "Invalid sender ID" });
    }
    // Verify membership
    const room = await Room.findOne({ roomCode });
    if (!room || !room.participants.some(p => p.toString() === sender)) {
      // Delete the uploaded file
      fs.unlink(file.path, () => {});
      return res.status(403).json({ message: "You are not a member of this room" });
    }

    const fileType = getFileType(file.mimetype);
    const fileUrl = "/uploads/" + file.filename;

    const msgData = {
      roomCode,
      sender,
      text: req.body.text || "",
      fileUrl,
      fileName: file.originalname,
      fileType,
      fileMime: file.mimetype,
      fileSize: file.size
    };
    if (req.body.replyTo && mongoose.Types.ObjectId.isValid(req.body.replyTo)) {
      msgData.replyTo = req.body.replyTo;
    }

    const msg = await Message.create(msgData);

    const populated = await msg.populate("sender", "username profilePic");
    await populated.populate({ path: "replyTo", populate: { path: "sender", select: "username" } });

    const payload = msgPayload(populated);

    // Broadcast to room via socket
    const ioRef = req.app.get("io");
    if (ioRef) ioRef.to(roomCode).emit("receiveMessage", payload);

    res.json({ message: "File sent", payload });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ message: "Upload failed" });
  }
});

// ---- Profile pic upload ----
app.post("/api/profile-pic", upload.single("profilePic"), async (req, res) => {
  try {
    const { userId } = req.body;
    const file = req.file;
    if (!userId || !file) return res.status(400).json({ message: "userId and profilePic are required" });
    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).json({ message: "Invalid userId" });
    if (!file.mimetype.startsWith("image/")) {
      fs.unlink(file.path, () => {});
      return res.status(400).json({ message: "Only image files are allowed" });
    }
    const user = await User.findById(userId);
    if (!user) { fs.unlink(file.path, () => {}); return res.status(404).json({ message: "User not found" }); }

    // Delete old pic if exists
    if (user.profilePic) {
      const oldPath = path.join(__dirname, user.profilePic);
      fs.unlink(oldPath, () => {});
    }

    user.profilePic = "/uploads/" + file.filename;
    await user.save();
    res.json({ message: "Profile picture updated", profilePic: user.profilePic });
  } catch (err) {
    console.error("Profile pic error:", err.message);
    res.status(500).json({ message: "Upload failed" });
  }
});

// ---- Room pic upload ----
app.post("/api/room-pic", upload.single("roomPic"), async (req, res) => {
  try {
    const { roomId, userId } = req.body;
    const file = req.file;
    if (!roomId || !userId || !file) return res.status(400).json({ message: "roomId, userId and roomPic are required" });
    if (!file.mimetype.startsWith("image/")) {
      fs.unlink(file.path, () => {});
      return res.status(400).json({ message: "Only image files are allowed" });
    }
    const room = await Room.findById(roomId);
    if (!room) { fs.unlink(file.path, () => {}); return res.status(404).json({ message: "Room not found" }); }
    const isHost = room.host.toString() === userId;
    const isCoHost = (room.coHosts || []).some(c => c.toString() === userId);
    if (!isHost && !isCoHost) {
      fs.unlink(file.path, () => {});
      return res.status(403).json({ message: "Only host or co-host can change room picture" });
    }

    // Delete old pic if exists
    if (room.roomPic) {
      const oldPath = path.join(__dirname, room.roomPic);
      fs.unlink(oldPath, () => {});
    }

    room.roomPic = "/uploads/" + file.filename;
    await room.save();

    const ioRef = app.get("io");
    if (ioRef) ioRef.to(room.roomCode).emit("roomPicUpdated", { roomCode: room.roomCode, roomPic: room.roomPic });

    res.json({ message: "Room picture updated", roomPic: room.roomPic });
  } catch (err) {
    console.error("Room pic error:", err.message);
    res.status(500).json({ message: "Upload failed" });
  }
});

// Serve the main app page for any non-API route (SPA fallback)
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 5000;

/* SOCKET.IO SETUP */

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

// Make io accessible to controllers via req.app
app.set("io", io);

// ---- Presence tracking: { roomCode -> Set of { userId, username, socketId } } ----
const roomPresence = {};

function getPresenceList(roomCode) {
  const set = roomPresence[roomCode];
  if (!set) return [];
  // Deduplicate by userId (a user can have multiple tabs)
  const seen = {};
  const list = [];
  for (const entry of set) {
    if (!seen[entry.userId]) {
      seen[entry.userId] = true;
      list.push({ userId: entry.userId, username: entry.username });
    }
  }
  return list;
}

function broadcastPresence(roomCode) {
  io.to(roomCode).emit("presenceUpdate", { roomCode, users: getPresenceList(roomCode) });
}

// Helper to build a message payload (used in chatHistory, sendMessage, upload, pin)
function msgPayload(msg) {
  const reply = msg.replyTo;
  return {
    _id: msg._id,
    roomCode: msg.roomCode,
    senderId: msg.sender ? (msg.sender._id || msg.sender) : null,
    sender: msg.sender ? (msg.sender.username || msg.sender) : "Unknown",
    senderPic: msg.sender ? (msg.sender.profilePic || null) : null,
    text: msg.text,
    fileUrl: msg.fileUrl || null,
    fileName: msg.fileName || null,
    fileType: msg.fileType || null,
    fileMime: msg.fileMime || null,
    fileSize: msg.fileSize || null,
    pinned: msg.pinned || false,
    pinnedBy: msg.pinnedBy ? (msg.pinnedBy.username || msg.pinnedBy) : null,
    edited: msg.edited || false,
    editedAt: msg.editedAt || null,
    mentions: (msg.mentions || []).map(u => (typeof u === "object" && u._id) ? { _id: u._id, username: u.username } : u),
    replyTo: reply ? {
      _id: reply._id,
      sender: reply.sender ? (reply.sender.username || reply.sender) : "Unknown",
      text: reply.text || "",
      fileName: reply.fileName || null
    } : null,
    createdAt: msg.createdAt
  };
}

io.on("connection", (socket) => {

  console.log("User connected:", socket.id);

  // Store userId so we can target this socket later
  socket.on("registerUser", (userId) => {
    socket.userId = userId;
    socket.join("user_" + userId);   // personal room for targeted events
    console.log(`Socket ${socket.id} registered as user ${userId}`);
  });

  // --- Join room & send chat history + presence ---
  socket.on("joinRoom", async (roomCode) => {
    try {
      socket.join(roomCode);
      socket.currentRoom = roomCode;
      console.log(`User joined room ${roomCode}`);

      // Track presence
      if (socket.userId) {
        if (!roomPresence[roomCode]) roomPresence[roomCode] = new Set();
        // Find username
        const u = await User.findById(socket.userId).select("username");
        const username = u ? u.username : "Unknown";
        socket.currentUsername = username;
        roomPresence[roomCode].add({ userId: socket.userId, username, socketId: socket.id });
        broadcastPresence(roomCode);
      }

      // Fetch last 50 messages with reply population
      const history = await Message.find({ roomCode })
        .sort({ createdAt: 1 })
        .limit(50)
        .populate("sender", "username profilePic")
        .populate({ path: "replyTo", populate: { path: "sender", select: "username" } })
        .populate("pinnedBy", "username")
        .populate("mentions", "username");

      const messages = history.map(msgPayload);
      socket.emit("chatHistory", messages);

      // Also send pinned messages list
      const pinned = await Message.find({ roomCode, pinned: true })
        .sort({ createdAt: -1 })
        .populate("sender", "username profilePic")
        .populate("pinnedBy", "username")
        .populate({ path: "replyTo", populate: { path: "sender", select: "username" } })
        .populate("mentions", "username");
      socket.emit("pinnedMessages", pinned.map(msgPayload));

    } catch (err) {
      console.error("joinRoom error:", err.message);
      socket.emit("error", "Failed to load chat history");
    }
  });

  // --- Leave a socket room (when switching rooms) ---
  socket.on("leaveRoom", (roomCode) => {
    socket.leave(roomCode);
    // Remove from presence
    if (roomPresence[roomCode]) {
      for (const entry of roomPresence[roomCode]) {
        if (entry.socketId === socket.id) { roomPresence[roomCode].delete(entry); break; }
      }
      broadcastPresence(roomCode);
    }
    socket.currentRoom = null;
    console.log(`Socket ${socket.id} left room ${roomCode}`);
  });

  // --- Typing indicator ---
  socket.on("typing", ({ roomCode, username }) => {
    socket.to(roomCode).emit("userTyping", { username });
  });
  socket.on("stopTyping", ({ roomCode, username }) => {
    socket.to(roomCode).emit("userStopTyping", { username });
  });

  // --- Send message with optional replyTo ---
  socket.on("sendMessage", async ({ roomCode, message, sender, replyTo, mentions }) => {
    try {
      if (!roomCode || !message || !sender) {
        return socket.emit("error", "Missing roomCode, message, or sender");
      }

      if (!mongoose.Types.ObjectId.isValid(sender)) {
        return socket.emit("error", "Invalid sender ID");
      }

      // Check if the sender is still a participant of this room
      const room = await Room.findOne({ roomCode });
      if (!room || !room.participants.some(p => p.toString() === sender)) {
        return socket.emit("error", "You are no longer a member of this room");
      }

      const msgData = { roomCode, sender, text: message };
      if (replyTo && mongoose.Types.ObjectId.isValid(replyTo)) {
        msgData.replyTo = replyTo;
      }
      // Validate mentions array
      if (mentions && Array.isArray(mentions)) {
        msgData.mentions = mentions.filter(id => mongoose.Types.ObjectId.isValid(id));
      }

      const savedMessage = await Message.create(msgData);

      // Populate sender + replyTo before broadcasting
      const populated = await savedMessage
        .populate("sender", "username profilePic");
      await populated.populate({ path: "replyTo", populate: { path: "sender", select: "username" } });
      await populated.populate("mentions", "username");

      io.to(roomCode).emit("receiveMessage", msgPayload(populated));

      // --- Nerd Bot: check if @nerd was mentioned ---
      if (nerdBotUser && message.toLowerCase().includes("@nerd")) {
        // Fetch recent messages for context (last 10)
        const recentMsgs = await Message.find({ roomCode })
          .sort({ createdAt: -1 })
          .limit(10)
          .populate("sender", "username");
        const context = recentMsgs.reverse().map(m => ({
          sender: m.sender ? m.sender.username : "Unknown",
          text: m.text || ""
        })).filter(m => m.text);

        // Strip @nerd from the prompt to get the actual question
        const userPrompt = message.replace(/@nerd/gi, "").trim() || message;

        const aiReply = await generateNerdReply(userPrompt, context);

        // Save nerd bot message
        const nerdMsg = await Message.create({
          roomCode,
          sender: nerdBotUser._id,
          text: aiReply,
          replyTo: savedMessage._id
        });
        const nerdPopulated = await nerdMsg.populate("sender", "username profilePic");
        await nerdPopulated.populate({ path: "replyTo", populate: { path: "sender", select: "username" } });
        await nerdPopulated.populate("mentions", "username");

        io.to(roomCode).emit("receiveMessage", msgPayload(nerdPopulated));
      }

    } catch (err) {
      console.error("sendMessage error:", err.message);
      socket.emit("error", "Failed to send message");
    }
  });

  // --- Pin / Unpin message ---
  socket.on("pinMessage", async ({ messageId, userId }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return socket.emit("error", "Message not found");
      msg.pinned = true;
      msg.pinnedBy = userId;
      await msg.save();
      await msg.populate("sender", "username profilePic");
      await msg.populate("pinnedBy", "username");
      await msg.populate({ path: "replyTo", populate: { path: "sender", select: "username" } });
      await msg.populate("mentions", "username");
      io.to(msg.roomCode).emit("messagePinned", msgPayload(msg));
    } catch (err) {
      console.error("pinMessage error:", err.message);
      socket.emit("error", "Failed to pin message");
    }
  });

  socket.on("unpinMessage", async ({ messageId }) => {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) return socket.emit("error", "Message not found");
      msg.pinned = false;
      msg.pinnedBy = null;
      await msg.save();
      io.to(msg.roomCode).emit("messageUnpinned", { messageId: msg._id, roomCode: msg.roomCode });
    } catch (err) {
      console.error("unpinMessage error:", err.message);
      socket.emit("error", "Failed to unpin message");
    }
  });

  // --- Edit message (sender only) ---
  socket.on("editMessage", async ({ messageId, newText, userId }) => {
    try {
      if (!messageId || !newText || !userId) return socket.emit("error", "Missing fields");
      const msg = await Message.findById(messageId);
      if (!msg) return socket.emit("error", "Message not found");
      // Only the sender can edit their own message
      if (msg.sender.toString() !== userId) {
        return socket.emit("error", "You can only edit your own messages");
      }
      msg.text = newText;
      msg.edited = true;
      msg.editedAt = new Date();
      // Re-parse mentions from newText (client will send them)
      await msg.save();
      await msg.populate("sender", "username profilePic");
      await msg.populate("pinnedBy", "username");
      await msg.populate({ path: "replyTo", populate: { path: "sender", select: "username" } });
      await msg.populate("mentions", "username");
      io.to(msg.roomCode).emit("messageEdited", msgPayload(msg));
    } catch (err) {
      console.error("editMessage error:", err.message);
      socket.emit("error", "Failed to edit message");
    }
  });

  // --- Delete message (sender or host/co-host) ---
  socket.on("deleteMessage", async ({ messageId, userId }) => {
    try {
      if (!messageId || !userId) return socket.emit("error", "Missing fields");
      const msg = await Message.findById(messageId);
      if (!msg) return socket.emit("error", "Message not found");

      const room = await Room.findOne({ roomCode: msg.roomCode });
      if (!room) return socket.emit("error", "Room not found");

      const isSender = msg.sender.toString() === userId;
      const isHost = room.host.toString() === userId;
      const isCoHost = (room.coHosts || []).some(c => c.toString() === userId);

      if (!isSender && !isHost && !isCoHost) {
        return socket.emit("error", "You don't have permission to delete this message");
      }

      const roomCode = msg.roomCode;
      await Message.findByIdAndDelete(messageId);
      io.to(roomCode).emit("messageDeleted", { messageId, roomCode });
    } catch (err) {
      console.error("deleteMessage error:", err.message);
      socket.emit("error", "Failed to delete message");
    }
  });

  // --- Forward message to multiple rooms ---
  socket.on("forwardMessage", async ({ messageId, targetRoomCodes, targetRoomCode, userId }) => {
    try {
      // Support both old single-room and new multi-room format
      const codes = targetRoomCodes || (targetRoomCode ? [targetRoomCode] : []);
      if (!messageId || codes.length === 0 || !userId) {
        return socket.emit("error", "Missing fields for forwarding");
      }
      const originalMsg = await Message.findById(messageId).populate("sender", "username");
      if (!originalMsg) return socket.emit("error", "Original message not found");

      const fwdLabel = `[Forwarded from ${originalMsg.sender ? originalMsg.sender.username : "Unknown"}]`;
      const fwdText = originalMsg.text ? `${fwdLabel}\n${originalMsg.text}` : fwdLabel;

      const successCodes = [];
      for (const code of codes) {
        const targetRoom = await Room.findOne({ roomCode: code });
        if (!targetRoom || !targetRoom.participants.some(p => p.toString() === userId)) continue;

        const fwdData = { roomCode: code, sender: userId, text: fwdText };
        if (originalMsg.fileUrl) {
          fwdData.fileUrl = originalMsg.fileUrl;
          fwdData.fileName = originalMsg.fileName;
          fwdData.fileType = originalMsg.fileType;
          fwdData.fileMime = originalMsg.fileMime;
          fwdData.fileSize = originalMsg.fileSize;
        }
        const saved = await Message.create(fwdData);
        const populated = await saved.populate("sender", "username profilePic");
        await populated.populate("mentions", "username");
        io.to(code).emit("receiveMessage", msgPayload(populated));
        successCodes.push(code);
      }

      if (successCodes.length > 0) {
        socket.emit("forwardSuccess", { targetRoomCodes: successCodes });
      } else {
        socket.emit("error", "Could not forward to any of the selected rooms");
      }
    } catch (err) {
      console.error("forwardMessage error:", err.message);
      socket.emit("error", "Failed to forward message");
    }
  });

  socket.on("disconnect", () => {
    // Remove from all presence maps
    for (const [roomCode, set] of Object.entries(roomPresence)) {
      for (const entry of set) {
        if (entry.socketId === socket.id) { set.delete(entry); broadcastPresence(roomCode); break; }
      }
    }
    console.log("User disconnected");
  });

});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});