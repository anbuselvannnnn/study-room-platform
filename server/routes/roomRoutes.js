const express = require("express");
const router = express.Router();

const {
  createRoom,
  joinRoom,
  getMyRooms,
  searchRooms,
  viewPublicRoom,
  requestJoin,
  getJoinRequests,
  approveRequest,
  rejectRequest,
  toggleVisibility,
  deleteRoom,
  removeMember,
  addCoHost,
  removeCoHost
} = require("../controllers/roomController");

router.post("/create", createRoom);
router.post("/join", joinRoom);
router.get("/my/:userId", getMyRooms);
router.get("/search", searchRooms);
router.get("/public/:roomId", viewPublicRoom);
router.post("/:roomId/request", requestJoin);
router.get("/:roomId/requests", getJoinRequests);
router.post("/:roomId/approve/:requestUserId", approveRequest);
router.post("/:roomId/reject/:requestUserId", rejectRequest);
router.patch("/:roomId/visibility", toggleVisibility);
router.delete("/:roomId", deleteRoom);
router.delete("/:roomId/member/:memberId", removeMember);
router.post("/:roomId/cohost/:memberId", addCoHost);
router.delete("/:roomId/cohost/:memberId", removeCoHost);

module.exports = router;