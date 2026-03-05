const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    roomCode: {
      type: String,
      required: true
    },

    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },

    text: {
      type: String,
      default: ""
    },

    // Reply reference
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null
    },

    // Pinned
    pinned: {
      type: Boolean,
      default: false
    },
    pinnedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },

    // Edited
    edited: {
      type: Boolean,
      default: false
    },
    editedAt: {
      type: Date,
      default: null
    },

    // Mentions
    mentions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
      }
    ],

    // File attachment fields
    fileUrl: {
      type: String,
      default: null
    },
    fileName: {
      type: String,
      default: null
    },
    fileType: {
      type: String,    // "image", "video", "audio", "document"
      default: null
    },
    fileMime: {
      type: String,
      default: null
    },
    fileSize: {
      type: Number,
      default: null
    }

  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", MessageSchema);