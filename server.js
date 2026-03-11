const http = require("http");
const express = require("express");
const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(".")); // serve client.html

let players = {};
let secretWord = "";
let imposterHint = "";
let roundStarted = false;

const WORDS = [
  { word: "Apple", hint: "Fruit" },
  { word: "Dog", hint: "Animal" },
  { word: "Car", hint: "Vehicle" },
  { word: "Ocean", hint: "Water" },
  { word: "Pizza", hint: "Food" }
];

io.on("connection", (socket) => {
  socket.on("join", (name) => {
    players[socket.id] = {
      name,
      isImposter: false,
      clue: null,
      vote: null
    };
    io.emit("players", players);
  });

  socket.on("startRound", () => {
    if (roundStarted) return;
    roundStarted = true;

    const choice = WORDS[Math.floor(Math.random() * WORDS.length)];
    secretWord = choice.word;
    imposterHint = choice.hint;

    const ids = Object.keys(players);
    const imposterId = ids[Math.floor(Math.random() * ids.length)];
    players[imposterId].isImposter = true;

    ids.forEach((id) => {
      if (id === imposterId) {
        io.to(id).emit("role", { role: "imposter", hint: imposterHint });
      } else {
        io.to(id).emit("role", { role: "crewmate", word: secretWord });
      }
    });
  });

  socket.on("submitClue", (clue) => {
    players[socket.id].clue = clue;

    const allSubmitted = Object.values(players).every(p => p.clue !== null);
    if (allSubmitted) io.emit("allClues", players);
  });

  socket.on("submitVote", (voteId) => {
    players[socket.id].vote = voteId;

    const allVoted = Object.values(players).every(p => p.vote !== null);
    if (allVoted) {
      const tally = {};
      for (const p of Object.values(players)) {
        tally[p.vote] = (tally[p.vote] || 0) + 1;
      }

      let votedOut = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
      const imposterId = Object.keys(players).find(id => players[id].isImposter);

      io.emit("results", {
        votedOut,
        imposterId,
        players
      });
    }
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("players", players);
  });
});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});
