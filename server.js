/**
 * VOIDRIFT — Game Server
 * Express + Socket.io, deployable to Render
 * ─────────────────────────────────────────
 * Socket events (client → server):
 *   join        { username }
 *   input       { keys: {up,down,left,right,shoot} }
 *   respawn
 *   ping        (heartbeat)
 *
 * Socket events (server → client):
 *   welcome     { id, config }
 *   state       { players, bullets }
 *   player_died { id, killerId, killerName }
 *   player_left { id }
 *   pong
 *
 * Extension points marked with // [EXT]
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

let bulletcd = 0.5;
let playerspd = 340;
let bulletdmg = 10;
let maxhp = 100;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  PORT:             process.env.PORT || 3000,
  TICK_RATE:        60,
  BROADCAST_RATE:   25,
  MAP_SIZE:         6000,
  PLAYER_SPEED:     playerspd,       // faster feels smoother at 25Hz broadcast
  PLAYER_RADIUS:    27,        // 18 * 1.5
  BULLET_SPEED:     820,
  BULLET_LIFETIME:  1,
  BULLET_DAMAGE:    bulletdmg,
  PLAYER_MAX_HP:    maxhp,
  SHOOT_COOLDOWN:   bulletcd,
  RESPAWN_INVULN:   3.0,
  MAX_TURN_SPEED:   Math.PI * 2, // 360 deg/s — enforced server-side too
};

// ─── EXPRESS + SOCKET.IO SETUP ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  // Render uses sticky sessions by default — if you scale to multiple instances,
  // enable Redis adapter here: [EXT] io.adapter(createAdapter(pubClient, subClient))
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── GAME STATE ───────────────────────────────────────────────────────────────
let players = {};
let bullets  = [];
let nextId   = 1;

function createPlayer(socketId, username) {
  return {
    id:           socketId,
    username:     username.trim().slice(0, 20) || 'Pilot',
    x:            Math.random() * CONFIG.MAP_SIZE,
    y:            Math.random() * CONFIG.MAP_SIZE,
    angle:        0,
    targetAngle:  0,   // mouse aim — client sends desired angle
    vx:           0,
    vy:           0,
    hp:           CONFIG.PLAYER_MAX_HP,
    alive:        true,
    invuln:       CONFIG.RESPAWN_INVULN,
    shootCooldown:0,
    score:        0,
    kills:        0,
    deaths:       0,
    keys:         { up: false, down: false, shoot: false },
    // [EXT] loadout: { weapon: null, armor: null, ship: 'default' }
    // [EXT] accountId: null, currency: 0
  };
}

function spawnBullet(owner) {
  bullets.push({
    id:       nextId++,
    ownerId:  owner.id,
    x:        owner.x + Math.cos(owner.angle) * (CONFIG.PLAYER_RADIUS + 4),
    y:        owner.y + Math.sin(owner.angle) * (CONFIG.PLAYER_RADIUS + 4),
    vx:       Math.cos(owner.angle) * CONFIG.BULLET_SPEED + owner.vx * 0.3,
    vy:       Math.sin(owner.angle) * CONFIG.BULLET_SPEED + owner.vy * 0.3,
    lifetime: CONFIG.BULLET_LIFETIME,
    // [EXT] damage: weaponStats[owner.loadout.weapon]?.damage ?? CONFIG.BULLET_DAMAGE
  });
}

// ─── PHYSICS TICK ─────────────────────────────────────────────────────────────
const DT = 1 / CONFIG.TICK_RATE;

function angleDiff(a, b) {
  // shortest signed angle from a to b
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function tick() {
  for (const p of Object.values(players)) {
    if (!p.alive) continue;

    if (p.invuln > 0) p.invuln -= DT;

    // Rotate toward targetAngle, capped at MAX_TURN_SPEED
    const diff    = angleDiff(p.angle, p.targetAngle);
    const maxStep = 10;
    if (Math.abs(diff) <= maxStep) {
      p.angle = p.targetAngle;
    } else {
      p.angle += Math.sign(diff) * maxStep;
    }
    // Keep angle in [-PI, PI]
    p.angle = ((p.angle + Math.PI) % (Math.PI * 2)) - Math.PI;

    if (p.keys.up) {
      p.vx += Math.cos(p.angle) * CONFIG.PLAYER_SPEED * DT * 2.5;
      p.vy += Math.sin(p.angle) * CONFIG.PLAYER_SPEED * DT * 2.5;
    }

    const drag = p.keys.down ? 0.88 : 0.97;
    p.vx *= drag;
    p.vy *= drag;

    const spd = Math.hypot(p.vx, p.vy);
    if (spd > CONFIG.PLAYER_SPEED) {
      p.vx = (p.vx / spd) * CONFIG.PLAYER_SPEED;
      p.vy = (p.vy / spd) * CONFIG.PLAYER_SPEED;
    }

    p.x = ((p.x + p.vx * DT) % CONFIG.MAP_SIZE + CONFIG.MAP_SIZE) % CONFIG.MAP_SIZE;
    p.y = ((p.y + p.vy * DT) % CONFIG.MAP_SIZE + CONFIG.MAP_SIZE) % CONFIG.MAP_SIZE;

    if (p.shootCooldown > 0) p.shootCooldown -= DT;
    if (p.keys.shoot && p.shootCooldown <= 0) {
      spawnBullet(p);
      p.shootCooldown = CONFIG.SHOOT_COOLDOWN;
    }
  }

  bullets = bullets.filter(b => {
    b.lifetime -= DT;
    if (b.lifetime <= 0) return false;

    b.x = ((b.x + b.vx * DT) % CONFIG.MAP_SIZE + CONFIG.MAP_SIZE) % CONFIG.MAP_SIZE;
    b.y = ((b.y + b.vy * DT) % CONFIG.MAP_SIZE + CONFIG.MAP_SIZE) % CONFIG.MAP_SIZE;

    for (const p of Object.values(players)) {
      if (!p.alive || p.id === b.ownerId || p.invuln > 0) continue;

      if (Math.hypot(p.x - b.x, p.y - b.y) < CONFIG.PLAYER_RADIUS) {
        const dmg = CONFIG.BULLET_DAMAGE;
        // [EXT] const dmg = weaponStats[b.weaponType].damage * (1 - armorStats[p.loadout.armor]?.reduction ?? 0)
        p.hp -= dmg;

        if (p.hp <= 0) {
          p.hp = 0;
          p.alive = false;
          p.deaths++;

          const killer = players[b.ownerId];
          if (killer) {
            killer.kills++;
            killer.score += 100;
            // [EXT] killer.currency += lootDrop();
          }

          io.emit('player_died', {
            id:         p.id,
            killerId:   b.ownerId,
            killerName: killer?.username ?? null,
            victimName: p.username,
          });
        }
        return false;
      }
    }
    return true;
  });
}

// ─── BROADCAST STATE ──────────────────────────────────────────────────────────
function broadcastState() {
  io.emit('state', {
    players: Object.values(players).map(p => ({
      id:        p.id,
      username:  p.username,
      x:         p.x,
      y:         p.y,
      angle:     p.angle,
      vx:        p.vx,
      vy:        p.vy,
      hp:        p.hp,
      alive:     p.alive,
      invuln:    p.invuln > 0,
      score:     p.score,
      kills:     p.kills,
      deaths:    p.deaths,
      thrusting: p.keys.up,  // used for engine glow on other clients
      // [EXT] ship: p.loadout.ship
    })),
    bullets: bullets.map(b => ({
      id:    b.id,
      x:     b.x,
      y:     b.y,
      vx:    b.vx,
      vy:    b.vy,
      angle: Math.atan2(b.vy, b.vx),
    })),
    // [EXT] asteroids, stations, loot
  });
}

setInterval(tick,           1000 / CONFIG.TICK_RATE);
setInterval(broadcastState, 1000 / CONFIG.BROADCAST_RATE);

// ─── SOCKET CONNECTIONS ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  socket.on('join', ({ username }) => {
    // [EXT] validate session token, load account from DB
    const p = createPlayer(socket.id, username || 'Pilot');
    players[socket.id] = p;
    console.log(`[JOIN] ${p.username} (${socket.id})`);

    socket.emit('welcome', {
      id:     socket.id,
      config: {
        mapSize:      CONFIG.MAP_SIZE,
        playerRadius: CONFIG.PLAYER_RADIUS,
        maxHp:        CONFIG.PLAYER_MAX_HP,
      },
    });
  });

  socket.on('input', ({ keys, angle }) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    p.keys.up    = !!keys.up;
    p.keys.down  = !!keys.down;
    p.keys.shoot = !!keys.shoot;
    // [EXT] keys.a, keys.d for special abilities
    if (typeof angle === 'number' && isFinite(angle)) {
      p.targetAngle = angle;
    }
  });

  socket.on('respawn', () => {
    const p = players[socket.id];
    if (!p || p.alive) return;
    p.x           = Math.random() * CONFIG.MAP_SIZE;
    p.y           = Math.random() * CONFIG.MAP_SIZE;
    p.vx          = 0;
    p.vy          = 0;
    p.hp          = CONFIG.PLAYER_MAX_HP;
    p.alive       = true;
    p.invuln      = CONFIG.RESPAWN_INVULN;
    p.keys        = { up: false, down: false, shoot: false };
    console.log(`[RESPAWN] ${p.username}`);
  });

  socket.on('ping', () => socket.emit('pong'));

  // [EXT] socket.on('chat', ...)
  // [EXT] socket.on('dock', ...)
  // [EXT] socket.on('market_buy', ...)
  // [EXT] socket.on('equip', ...)

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) {
      console.log(`[LEAVE] ${p.username}`);
      io.emit('player_left', { id: socket.id });
      delete players[socket.id];
    }
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, () => {
  console.log(`[SERVER] VOIDRIFT running on port ${CONFIG.PORT}`);
});
