const Room = require("../models/Room");
const Message = require("../models/Message");
const { nanoid } = require("nanoid");

// Create Room
exports.createRoom = async (req, res) => {
  try {
    const { userId, roomName, isPublic } = req.body;

    if (!roomName || !roomName.trim()) {
      return res.status(400).json({ message: "Room name is required" });
    }

    // Check unique room name (case-insensitive)
    const existing = await Room.findOne({ roomName: { $regex: new RegExp("^" + roomName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") } });
    if (existing) {
      return res.status(400).json({ message: "A room with that name already exists" });
    }

    const roomCode = "study-" + nanoid(4);

    const room = await Room.create({
      roomCode,
      roomName: roomName.trim(),
      host: userId,
      isPublic: !!isPublic,
      participants: [userId]
    });

    res.status(201).json({
      message: "Room created",
      room: {
        _id: room._id,
        roomCode: room.roomCode,
        roomName: room.roomName,
        host: room.host,
        coHosts: room.coHosts || [],
        roomPic: room.roomPic || null,
        isPublic: room.isPublic,
        participants: room.participants
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Join Room (by code — works for private rooms, or public rooms)
exports.joinRoom = async (req, res) => {
  try {
    const { roomCode, userId } = req.body;

    const room = await Room.findOne({ roomCode })
      .populate("host", "username")
      .populate("participants", "username profilePic")
      .populate("coHosts", "username");

    if (!room) {
      return res.status(404).json({ message: "Room not found" });
    }

    const isNew = !room.participants.some(p => p._id.toString() === userId);
    if (isNew) {
      room.participants.push(userId);
      // Remove from join requests if they were there
      room.joinRequests = room.joinRequests.filter(r => r.user.toString() !== userId);
      await room.save();
      await room.populate("participants", "username profilePic");
    }

    // Notify all clients in this room about the updated member list
    if (isNew) {
      const io = req.app.get("io");
      if (io) {
        io.to(room.roomCode).emit("memberUpdate", {
          roomCode: room.roomCode,
          participants: room.participants,
          coHosts: room.coHosts || []
        });
      }
    }

    res.json({
      message: "Joined room",
      room: {
        _id: room._id,
        roomCode: room.roomCode,
        roomName: room.roomName,
        host: room.host,
        coHosts: room.coHosts || [],
        roomPic: room.roomPic || null,
        isPublic: room.isPublic,
        participants: room.participants
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Get rooms the user is part of
exports.getMyRooms = async (req, res) => {
  try {
    const { userId } = req.params;

    const rooms = await Room.find({ participants: userId })
      .populate("host", "username")
      .populate("participants", "username profilePic")
      .populate("coHosts", "username")
      .sort({ updatedAt: -1 });

    res.json(rooms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Search public rooms by name
exports.searchRooms = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      return res.json([]);
    }
    const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rooms = await Room.find({
      isPublic: true,
      roomName: { $regex: escaped, $options: "i" }
    })
      .populate("host", "username")
      .populate("participants", "username profilePic")
      .populate("coHosts", "username")
      .select("-joinRequests")
      .sort({ updatedAt: -1 })
      .limit(20);

    res.json(rooms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// View a public room's messages (without joining)
exports.viewPublicRoom = async (req, res) => {
  try {
    const { roomId } = req.params;

    const room = await Room.findById(roomId)
      .populate("host", "username")
      .populate("participants", "username profilePic")
      .populate("coHosts", "username");

    if (!room) {
      return res.status(404).json({ message: "Room not found" });
    }

    if (!room.isPublic) {
      return res.status(403).json({ message: "This room is private" });
    }

    const messages = await Message.find({ roomCode: room.roomCode })
      .sort({ createdAt: 1 })
      .limit(50)
      .populate("sender", "username");

    const cleanMessages = messages.map(m => ({
      _id: m._id,
      sender: m.sender ? m.sender.username : "Unknown",
      text: m.text,
      fileUrl: m.fileUrl,
      fileName: m.fileName,
      fileType: m.fileType,
      fileMime: m.fileMime,
      fileSize: m.fileSize,
      createdAt: m.createdAt
    }));

    res.json({ room, messages: cleanMessages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Request to join a public room
exports.requestJoin = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId } = req.body;

    const room = await Room.findById(roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (!room.isPublic) return res.status(403).json({ message: "This room is private" });

    // Already a participant?
    if (room.participants.some(p => p.toString() === userId)) {
      return res.status(400).json({ message: "You are already a member" });
    }

    // Already requested?
    if (room.joinRequests.some(r => r.user.toString() === userId)) {
      return res.status(400).json({ message: "You already have a pending request" });
    }

    room.joinRequests.push({ user: userId });
    await room.save();

    // Notify host and co-hosts in real time
    const io = req.app.get("io");
    if (io) {
      const hostId = room.host.toString();
      io.to("user_" + hostId).emit("joinRequest", {
        roomId: room._id,
        roomName: room.roomName,
        userId
      });
      // Also notify co-hosts
      (room.coHosts || []).forEach(c => {
        io.to("user_" + c.toString()).emit("joinRequest", {
          roomId: room._id,
          roomName: room.roomName,
          userId
        });
      });
    }

    res.json({ message: "Join request sent" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Get join requests for a room (host or co-host)
exports.getJoinRequests = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId } = req.query;

    const room = await Room.findById(roomId)
      .populate("joinRequests.user", "username email");

    if (!room) return res.status(404).json({ message: "Room not found" });
    const isHost = room.host.toString() === userId;
    const isCoHost = (room.coHosts || []).some(c => c.toString() === userId);
    if (!isHost && !isCoHost) {
      return res.status(403).json({ message: "Only the host or co-host can view requests" });
    }

    res.json(room.joinRequests);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Approve a join request (host or co-host)
exports.approveRequest = async (req, res) => {
  try {
    const { roomId, requestUserId } = req.params;
    const { userId } = req.body;

    const room = await Room.findById(roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });
    const isHost = room.host.toString() === userId;
    const isCoHost = (room.coHosts || []).some(c => c.toString() === userId);
    if (!isHost && !isCoHost) {
      return res.status(403).json({ message: "Only the host or co-host can approve requests" });
    }

    // Add to participants
    if (!room.participants.some(p => p.toString() === requestUserId)) {
      room.participants.push(requestUserId);
    }
    room.joinRequests = room.joinRequests.filter(r => r.user.toString() !== requestUserId);
    await room.save();
    await room.populate("participants", "username profilePic");
    await room.populate("coHosts", "username");

    const io = req.app.get("io");
    if (io) {
      io.to(room.roomCode).emit("memberUpdate", {
        roomCode: room.roomCode,
        participants: room.participants,
        coHosts: room.coHosts
      });
      io.to("user_" + requestUserId).emit("requestApproved", {
        roomId: room._id,
        roomName: room.roomName,
        roomCode: room.roomCode
      });
    }

    res.json({ message: "Request approved", participants: room.participants });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Reject a join request (host or co-host)
exports.rejectRequest = async (req, res) => {
  try {
    const { roomId, requestUserId } = req.params;
    const { userId } = req.body;

    const room = await Room.findById(roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });
    const isHost = room.host.toString() === userId;
    const isCoHost = (room.coHosts || []).some(c => c.toString() === userId);
    if (!isHost && !isCoHost) {
      return res.status(403).json({ message: "Only the host or co-host can reject requests" });
    }

    room.joinRequests = room.joinRequests.filter(r => r.user.toString() !== requestUserId);
    await room.save();

    const io = req.app.get("io");
    if (io) {
      io.to("user_" + requestUserId).emit("requestRejected", {
        roomId: room._id,
        roomName: room.roomName
      });
    }

    res.json({ message: "Request rejected" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Toggle public/private (host only)
exports.toggleVisibility = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId } = req.body;

    const room = await Room.findById(roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (room.host.toString() !== userId) {
      return res.status(403).json({ message: "Only the host can change room visibility" });
    }

    room.isPublic = !room.isPublic;
    // Clear pending requests if switching to private
    if (!room.isPublic) room.joinRequests = [];
    await room.save();

    res.json({ message: `Room is now ${room.isPublic ? "public" : "private"}`, isPublic: room.isPublic });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Delete Room (host only)
exports.deleteRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId } = req.body;

    const room = await Room.findById(roomId);

    if (!room) {
      return res.status(404).json({ message: "Room not found" });
    }

    if (room.host.toString() !== userId) {
      return res.status(403).json({ message: "Only the host can delete this room" });
    }

    // Notify all clients in this room that it's been deleted
    const io = req.app.get("io");
    if (io) {
      io.to(room.roomCode).emit("roomDeleted", { roomCode: room.roomCode });
    }

    // Delete all messages in the room
    await Message.deleteMany({ roomCode: room.roomCode });
    await Room.findByIdAndDelete(roomId);

    res.json({ message: "Room deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Remove a participant (host or co-host — co-hosts cannot remove host or other co-hosts)
exports.removeMember = async (req, res) => {
  try {
    const { roomId, memberId } = req.params;
    const { userId } = req.body;

    const room = await Room.findById(roomId);

    if (!room) {
      return res.status(404).json({ message: "Room not found" });
    }

    const isHost = room.host.toString() === userId;
    const isCoHost = (room.coHosts || []).some(c => c.toString() === userId);

    if (!isHost && !isCoHost) {
      return res.status(403).json({ message: "Only the host or co-host can remove members" });
    }

    if (room.host.toString() === memberId) {
      return res.status(400).json({ message: "Host cannot be removed" });
    }

    // Co-hosts cannot remove other co-hosts
    if (isCoHost && !isHost && (room.coHosts || []).some(c => c.toString() === memberId)) {
      return res.status(403).json({ message: "Co-hosts cannot remove other co-hosts" });
    }

    room.participants = room.participants.filter(
      (p) => p.toString() !== memberId
    );
    // Also remove from coHosts if they were one
    room.coHosts = (room.coHosts || []).filter(c => c.toString() !== memberId);
    await room.save();

    await room.populate("participants", "username profilePic");
    await room.populate("coHosts", "username");

    // Notify remaining members about the updated list
    const io = req.app.get("io");
    if (io) {
      io.to(room.roomCode).emit("memberUpdate", {
        roomCode: room.roomCode,
        participants: room.participants,
        coHosts: room.coHosts
      });
      // Tell the kicked user they've been removed
      io.to("user_" + memberId).emit("kicked", {
        roomCode: room.roomCode,
        roomId: room._id.toString()
      });
    }

    res.json({
      message: "Member removed",
      participants: room.participants
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Add Co-Host (host only)
exports.addCoHost = async (req, res) => {
  try {
    const { roomId, memberId } = req.params;
    const { userId } = req.body;

    const room = await Room.findById(roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (room.host.toString() !== userId) {
      return res.status(403).json({ message: "Only the host can appoint co-hosts" });
    }
    if (room.host.toString() === memberId) {
      return res.status(400).json({ message: "Host is already the owner" });
    }
    if (!room.participants.some(p => p.toString() === memberId)) {
      return res.status(400).json({ message: "User is not a member of this room" });
    }
    if ((room.coHosts || []).some(c => c.toString() === memberId)) {
      return res.status(400).json({ message: "User is already a co-host" });
    }

    room.coHosts.push(memberId);
    await room.save();

    await room.populate("participants", "username profilePic");
    await room.populate("coHosts", "username");

    const io = req.app.get("io");
    if (io) {
      io.to(room.roomCode).emit("memberUpdate", {
        roomCode: room.roomCode,
        participants: room.participants,
        coHosts: room.coHosts
      });
    }

    res.json({ message: "Co-host added", coHosts: room.coHosts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


// Remove Co-Host (host only)
exports.removeCoHost = async (req, res) => {
  try {
    const { roomId, memberId } = req.params;
    const { userId } = req.body;

    const room = await Room.findById(roomId);
    if (!room) return res.status(404).json({ message: "Room not found" });
    if (room.host.toString() !== userId) {
      return res.status(403).json({ message: "Only the host can remove co-hosts" });
    }

    room.coHosts = (room.coHosts || []).filter(c => c.toString() !== memberId);
    await room.save();

    await room.populate("participants", "username profilePic");
    await room.populate("coHosts", "username");

    const io = req.app.get("io");
    if (io) {
      io.to(room.roomCode).emit("memberUpdate", {
        roomCode: room.roomCode,
        participants: room.participants,
        coHosts: room.coHosts
      });
    }

    res.json({ message: "Co-host removed", coHosts: room.coHosts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};