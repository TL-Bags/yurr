/**
 * VOIDRIFT — Game Server
 * Express + Socket.io, deployable to Render
 * ─────────────────────────────────────────
 * Socket events (client → server):
 *   join     { username, clan?, cosmetics?, ship? }
 *   input    { keys: {up,down,shoot,sideLeft,sideRight}, angle }
 *   respawn
 *   ping
 *
 * Socket events (server → client):
 *   welcome      { id, config }
 *   state        { players, bullets }
 *   player_died  { id, killerId, killerName, victimName }
 *   player_left  { id }
 *   join_error   { message }
 *   pong
 *
 * Extension points marked // [EXT]
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  PORT:             process.env.PORT || 3000,
  TICK_RATE:        60,
  BROADCAST_RATE:   25,
  MAP_SIZE:         6000,
  PLAYER_SPEED:     340,
  SIDE_THRUST_SPEED:80,
  PLAYER_RADIUS:    27,
  BULLET_SPEED:     820,
  BULLET_LIFETIME:  2.4,
  BULLET_DAMAGE:    10,
  PLAYER_MAX_HP:    100,
  SHOOT_COOLDOWN:   0.25,
  RESPAWN_INVULN:   3.0,

  // Turn speed per ship class — Infinity = no cap (default)
  // [EXT] set per-ship values when multiple ship types exist
  SHIP_TURN_SPEEDS: {
    default: Infinity,
    // [EXT] heavy:   Math.PI * 2,
    // [EXT] fighter: Math.PI * 6,
  },
};

// ─── COSMETICS SCHEMA ────────────────────────────────────────────────────────
// Defines what cosmetic slots exist. Actual asset selection is client-side.
// Server just validates and stores the chosen keys.
const COSMETIC_SLOTS = ['thrustParticle', 'sideParticle', 'bulletStyle', 'shipSkin'];
// [EXT] expand with: 'deathEffect', 'engineTrail', 'shieldStyle', etc.

const DEFAULT_COSMETICS = {
  thrustParticle: 'default',   // [EXT] 'flame', 'ion', 'rainbow', ...
  sideParticle:   'default',   // [EXT] 'spark', 'ghost', ...
  bulletStyle:    'default',   // [EXT] 'laser', 'plasma', 'orb', ...
  shipSkin:       'default',   // [EXT] 'gold', 'dark', 'clan_color', ...
};

// ─── SHIP SCHEMA ─────────────────────────────────────────────────────────────
const SHIPS = {
  default: {
    radius:     27,
    speed:      340,
    sideSpeed:  80,
    hp:         100,
    turnSpeed:  Infinity,       // no cap
    shootCooldown: 0.25,
    // [EXT] bulletDamage, bulletSpeed overrides
  },
  // [EXT] heavy:   { radius:36, speed:220, sideSpeed:40, hp:200, turnSpeed: Math.PI*2 },
  // [EXT] fighter: { radius:20, speed:440, sideSpeed:120, hp:60, turnSpeed: Math.PI*6 },
};

// ─── EXPRESS + SOCKET.IO ─────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  // [EXT] Redis adapter for multi-instance: io.adapter(createAdapter(...))
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── VALIDATION ──────────────────────────────────────────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function sanitizeCosmetics(raw) {
  const out = { ...DEFAULT_COSMETICS };
  if (!raw || typeof raw !== 'object') return out;
  for (const slot of COSMETIC_SLOTS) {
    if (typeof raw[slot] === 'string' && raw[slot].length < 32) {
      out[slot] = raw[slot];
    }
  }
  return out;
  // [EXT] validate against unlocked cosmetics from player account DB
}

function sanitizeClan(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 6);
  return /^[a-zA-Z0-9_]{2,6}$/.test(trimmed) ? trimmed : null;
  // [EXT] validate clan membership from DB
}

function sanitizeShip(raw) {
  if (raw && SHIPS[raw]) return raw;
  return 'default';
  // [EXT] validate ship ownership from player account
}

// ─── GAME STATE ───────────────────────────────────────────────────────────────
let players = {};
let bullets  = [];
let nextId   = 1;

function createPlayer(socketId, { username, clan, cosmetics, ship }) {
  const shipDef = SHIPS[ship] ?? SHIPS.default;
  return {
    id:           socketId,
    username,
    clan:         clan ?? null,          // [EXT] load from DB
    ship:         ship,
    cosmetics,                           // [EXT] load from DB / validate ownership
    // [EXT] accountId: null
    // [EXT] currency: 0
    // [EXT] inventory: []

    // Physics
    x:            Math.random() * CONFIG.MAP_SIZE,
    y:            Math.random() * CONFIG.MAP_SIZE,
    angle:        0,
    targetAngle:  0,
    vx:           0,
    vy:           0,

    // State
    hp:           shipDef.hp,
    alive:        true,
    invuln:       CONFIG.RESPAWN_INVULN,
    shootCooldown:0,
    score:        0,
    kills:        0,
    deaths:       0,
    keys:         { up:false, down:false, shoot:false, sideLeft:false, sideRight:false },

    // Per-ship stats (resolved once, used in tick)
    _speed:       shipDef.speed,
    _sideSpeed:   shipDef.sideSpeed,
    _maxHp:       shipDef.hp,
    _turnSpeed:   shipDef.turnSpeed,
    _shootCooldown: shipDef.shootCooldown,
    _radius:      shipDef.radius,
  };
}

function spawnBullet(owner) {
  bullets.push({
    id:        nextId++,
    ownerId:   owner.id,
    x:         owner.x + Math.cos(owner.angle) * (owner._radius + 4),
    y:         owner.y + Math.sin(owner.angle) * (owner._radius + 4),
    vx:        Math.cos(owner.angle) * CONFIG.BULLET_SPEED + owner.vx * 0.3,
    vy:        Math.sin(owner.angle) * CONFIG.BULLET_SPEED + owner.vy * 0.3,
    lifetime:  CONFIG.BULLET_LIFETIME,
    bulletStyle: owner.cosmetics.bulletStyle,
    // [EXT] damage: weaponStats[owner.loadout.weapon]?.damage ?? CONFIG.BULLET_DAMAGE
  });
}

// ─── PHYSICS ──────────────────────────────────────────────────────────────────
const DT = 1 / CONFIG.TICK_RATE;

function angleDiff(a, b) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function tick() {
  for (const p of Object.values(players)) {
    if (!p.alive) continue;

    if (p.invuln > 0) p.invuln -= DT;

    // Rotation — capped at per-ship turn speed (Infinity = instant)
    if (isFinite(p._turnSpeed)) {
      const diff    = angleDiff(p.angle, p.targetAngle);
      const maxStep = p._turnSpeed * DT;
      p.angle += Math.abs(diff) <= maxStep ? diff : Math.sign(diff) * maxStep;
    } else {
      p.angle = p.targetAngle; // instant turn
    }
    p.angle = ((p.angle + Math.PI) % (Math.PI * 2)) - Math.PI;

    // Forward thrust
    if (p.keys.up) {
      p.vx += Math.cos(p.angle) * p._speed * DT * 2.5;
      p.vy += Math.sin(p.angle) * p._speed * DT * 2.5;
    }

    // Side strafe
    if (p.keys.sideLeft || p.keys.sideRight) {
      const dir   = p.keys.sideRight ? 1 : -1;
      const perpX = -Math.sin(p.angle);
      const perpY =  Math.cos(p.angle);
      p.vx += perpX * dir * p._sideSpeed * DT * 4;
      p.vy += perpY * dir * p._sideSpeed * DT * 4;
    }

    const drag = p.keys.down ? 0.88 : 0.97;
    p.vx *= drag;
    p.vy *= drag;

    const spd = Math.hypot(p.vx, p.vy);
    if (spd > p._speed) {
      p.vx = p.vx / spd * p._speed;
      p.vy = p.vy / spd * p._speed;
    }

    p.x = ((p.x + p.vx * DT) % CONFIG.MAP_SIZE + CONFIG.MAP_SIZE) % CONFIG.MAP_SIZE;
    p.y = ((p.y + p.vy * DT) % CONFIG.MAP_SIZE + CONFIG.MAP_SIZE) % CONFIG.MAP_SIZE;

    if (p.shootCooldown > 0) p.shootCooldown -= DT;
    if (p.keys.shoot && p.shootCooldown <= 0) {
      spawnBullet(p);
      p.shootCooldown = p._shootCooldown;
    }
  }

  bullets = bullets.filter(b => {
    b.lifetime -= DT;
    if (b.lifetime <= 0) return false;

    b.x = ((b.x + b.vx * DT) % CONFIG.MAP_SIZE + CONFIG.MAP_SIZE) % CONFIG.MAP_SIZE;
    b.y = ((b.y + b.vy * DT) % CONFIG.MAP_SIZE + CONFIG.MAP_SIZE) % CONFIG.MAP_SIZE;

    for (const p of Object.values(players)) {
      if (!p.alive || p.id === b.ownerId || p.invuln > 0) continue;
      if (Math.hypot(p.x - b.x, p.y - b.y) < p._radius) {
        p.hp -= CONFIG.BULLET_DAMAGE;
        // [EXT] apply armor reduction, weapon-specific damage
        if (p.hp <= 0) {
          p.hp = 0; p.alive = false; p.deaths++;
          const killer = players[b.ownerId];
          if (killer) { killer.kills++; killer.score += 100; }
          // [EXT] killer.currency += lootDrop()
          io.emit('player_died', {
            id: p.id, killerId: b.ownerId,
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

// ─── BROADCAST ────────────────────────────────────────────────────────────────
function broadcastState() {
  io.emit('state', {
    players: Object.values(players).map(p => ({
      id:           p.id,
      username:     p.username,
      clan:         p.clan,
      ship:         p.ship,
      cosmetics:    p.cosmetics,
      x:  p.x, y:  p.y,
      angle:        p.angle,
      vx: p.vx, vy: p.vy,
      hp:           p.hp,
      maxHp:        p._maxHp,
      alive:        p.alive,
      invuln:       p.invuln > 0,
      score:        p.score,
      kills:        p.kills,
      deaths:       p.deaths,
      thrusting:    p.keys.up,
      sideThrusting:p.keys.sideLeft ? -1 : p.keys.sideRight ? 1 : 0,
      // [EXT] weapon, armor, shield
    })),
    bullets: bullets.map(b => ({
      id:          b.id,
      x: b.x, y:  b.y,
      vx: b.vx, vy: b.vy,
      angle:       Math.atan2(b.vy, b.vx),
      bulletStyle: b.bulletStyle,
    })),
    // [EXT] asteroids, stations, loot
  });
}

setInterval(tick,           1000 / CONFIG.TICK_RATE);
setInterval(broadcastState, 1000 / CONFIG.BROADCAST_RATE);

// ─── CONNECTIONS ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  socket.on('join', ({ username, clan, cosmetics, ship } = {}) => {
    // Validate username
    const name = (username || '').trim();
    if (!USERNAME_RE.test(name)) {
      socket.emit('join_error', {
        message: 'Name must be 3–20 characters: letters, numbers, underscores only.'
      });
      return;
    }

    // [EXT] Check name uniqueness, check ban list, validate session token

    const p = createPlayer(socket.id, {
      username:   name,
      clan:       sanitizeClan(clan),
      cosmetics:  sanitizeCosmetics(cosmetics),
      ship:       sanitizeShip(ship),
    });
    players[socket.id] = p;
    console.log(`[JOIN] ${p.username} clan=${p.clan} ship=${p.ship} (${socket.id})`);

    socket.emit('welcome', {
      id:     socket.id,
      config: {
        mapSize:      CONFIG.MAP_SIZE,
        playerRadius: CONFIG.PLAYER_RADIUS,
        maxHp:        CONFIG.PLAYER_MAX_HP,
      },
    });
  });

  socket.on('input', ({ keys, angle } = {}) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    p.keys.up        = !!keys?.up;
    p.keys.down      = !!keys?.down;
    p.keys.shoot     = !!keys?.shoot;
    p.keys.sideLeft  = !!keys?.sideLeft;
    p.keys.sideRight = !!keys?.sideRight;
    if (typeof angle === 'number' && isFinite(angle)) p.targetAngle = angle;
  });

  socket.on('respawn', () => {
    const p = players[socket.id];
    if (!p || p.alive) return;
    p.x = Math.random() * CONFIG.MAP_SIZE;
    p.y = Math.random() * CONFIG.MAP_SIZE;
    p.vx = p.vy = 0;
    p.hp     = p._maxHp;
    p.alive  = true;
    p.invuln = CONFIG.RESPAWN_INVULN;
    p.keys   = { up:false, down:false, shoot:false, sideLeft:false, sideRight:false };
    console.log(`[RESPAWN] ${p.username}`);
  });

  // [EXT] socket.on('equip', ({ slot, item }) => { ... })
  // [EXT] socket.on('dock', () => { ... })
  // [EXT] socket.on('market_buy', ({ listingId }) => { ... })
  // [EXT] socket.on('chat', ({ msg }) => { ... })

  socket.on('ping', () => socket.emit('pong'));

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) {
      console.log(`[LEAVE] ${p.username}`);
      io.emit('player_left', { id: socket.id });
      delete players[socket.id];
    }
  });
});

server.listen(CONFIG.PORT, () => {
  console.log(`[SERVER] VOIDRIFT on port ${CONFIG.PORT}`);
});
