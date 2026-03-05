const mongoose = require("mongoose");

const RoomSchema = new mongoose.Schema(
  {
    roomCode: {
      type: String,
      required: true,
      unique: true
    },

    roomName: {
      type: String,
      required: true,
      trim: true,
      unique: true
    },

    host: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },

    coHosts: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
      }
    ],

    roomPic: {
      type: String,
      default: null
    },

    isPublic: {
      type: Boolean,
      default: false
    },

    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
      }
    ],

    joinRequests: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        requestedAt: { type: Date, default: Date.now }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model("Room", RoomSchema);