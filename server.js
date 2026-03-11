const express = require("express");
const http = require("http");
const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("."));

// Generate 4‑letter room codes
function generateRoomCode() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}

const rooms = {};

const WORDS = [
  { word: "Lebron", hint: "basketball" },
  { word: "Messi", hint: "soccer" },
  { word: "yellow", hint: "color" },
  { word: "feces", hint: "toilet" },
  { word: "drinks", hint: "party" },
  { word: "computer", hint: "video games" },
  { word: "air conditioning", hint: "cold" },
  { word: "lemonade", hint: "yellow" },
  { word: "secret", hint: "safe" },
  { word: "school", hint: "books" },
  { word: "food", hint: "fat" },
  { word: "bed", hint: "dreams" }
];

io.on("connection", (socket) => {

  // CREATE ROOM
  socket.on("createRoom", (name) => {
    const code = generateRoomCode();
    rooms[code] = {
      hostId: socket.id,
      players: {},
      secretWord: "",
      imposterHint: "",
      roundStarted: false
    };

    rooms[code].players[socket.id] = {
      name,
      isImposter: false,
      clue: null,
      vote: null
    };

    socket.join(code);
    socket.emit("roomCreated", code);
    io.to(code).emit("players", rooms[code].players);
  });

  // JOIN ROOM
  socket.on("joinRoom", ({ name, code }) => {
    if (!rooms[code]) {
      socket.emit("errorMessage", "Room does not exist");
      return;
    }

    rooms[code].players[socket.id] = {
      name,
      isImposter: false,
      clue: null,
      vote: null
    };

    socket.join(code);
    socket.emit("joinedRoom", code);
    io.to(code).emit("players", rooms[code].players);
  });

  // START ROUND (host only)
  socket.on("startRound", (code) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;

    room.roundStarted = true;

    const choice = WORDS[Math.floor(Math.random() * WORDS.length)];
    room.secretWord = choice.word;
    room.imposterHint = choice.hint;

    const ids = Object.keys(room.players);
    const imposterId = ids[Math.floor(Math.random() * ids.length)];
    room.players[imposterId].isImposter = true;

    ids.forEach((id) => {
      if (id === imposterId) {
        io.to(id).emit("role", { role: "imposter", hint: room.imposterHint });
      } else {
        io.to(id).emit("role", { role: "crewmate", word: room.secretWord });
      }
    });
  });

  // CLUE SUBMISSION
  socket.on("submitClue", ({ code, clue }) => {
    const room = rooms[code];
    if (!room) return;

    room.players[socket.id].clue = clue;

    const allSubmitted = Object.values(room.players).every(p => p.clue !== null);
    if (allSubmitted) io.to(code).emit("allClues", room.players);
  });

  // VOTING
  socket.on("submitVote", ({ code, voteId }) => {
    const room = rooms[code];
    if (!room) return;

    room.players[socket.id].vote = voteId;

    const allVoted = Object.values(room.players).every(p => p.vote !== null);
    if (allVoted) {
      const tally = {};
      for (const p of Object.values(room.players)) {
        tally[p.vote] = (tally[p.vote] || 0) + 1;
      }

      let votedOut = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
      const imposterId = Object.keys(room.players).find(id => room.players[id].isImposter);

      io.to(code).emit("results", {
        votedOut,
        imposterId,
        players: room.players
      });
    }
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(code).emit("players", room.players);

        if (Object.keys(room.players).length === 0) {
          delete rooms[code];
        }
      }
    }
  });
});

// Serve client.html as homepage
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/client.html");
});

server.listen(3000, () => console.log("Server running on port 3000"));
