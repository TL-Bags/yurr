/**
 * VOIDRIFT — Game Server v6
 * Express + Socket.io, deployable to Render
 * ──────────────────────────────────────────
 * Socket events (client → server):
 *   join     { username, clan?, cosmetics?, ship? }
 *   input    { keys: {up,down,shoot,sideLeft,sideRight,boost,borderAnchor}, angle }
 *   respawn
 *   ping
 *
 * Socket events (server → client):
 *   welcome      { id, config }
 *   state        { players, bullets }
 *   bullet_hit   { x, y, bulletStyle }   — spark effect trigger
 *   player_died  { id, killerId, killerName, victimName, x, y }
 *   player_left  { id }
 *   join_error   { message }
 *   pong
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
  MAP_SIZE:         12000,           // doubled from 6000

  PLAYER_SPEED:         340,
  SIDE_THRUST_SPEED:    80,
  BORDER_ANCHOR_PENALTY:0.10,        // 10% speed reduction when border-anchored
  PLAYER_RADIUS:        27,
  BULLET_SPEED:         820,
  BULLET_LIFETIME:      3.5,         // longer for bigger map
  BULLET_DAMAGE:        10,
  PLAYER_MAX_HP:        100,
  SHOOT_COOLDOWN:       0.25,
  RESPAWN_INVULN:       3.0,

  // ── HEALTH REGEN ─────────────────────────────────────────────────────────
  REGEN_RATE:           2,           // hp per second
  REGEN_DELAY:          10,          // seconds after last damage before regen starts

  // ── BOOST ─────────────────────────────────────────────────────────────────
  BOOST_MAX:            100,
  BOOST_DRAIN:          20,
  BOOST_RECHARGE:       4,
  BOOST_SPEED_MULT:     2.2,
  BOOST_RECHARGE_DELAY: 1.0,

  // ── SHIP CLASSES ──────────────────────────────────────────────────────────
  SHIP_TURN_SPEEDS: {
    default: Infinity,
    // [EXT] heavy: Math.PI * 2,
  },
};

// ─── COSMETICS / SHIPS SCHEMAS ───────────────────────────────────────────────
const COSMETIC_SLOTS = ['thrustParticle','sideParticle','bulletStyle','shipSkin'];
const DEFAULT_COSMETICS = {
  thrustParticle:'default', sideParticle:'default',
  bulletStyle:'default',    shipSkin:'default',
};

const SHIPS = {
  default: { radius:27, speed:340, sideSpeed:80, hp:100, turnSpeed:Infinity, shootCooldown:0.25 },
  // [EXT] heavy, fighter, etc.
};

// ─── EXPRESS + SOCKET.IO ─────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{ origin:'*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── VALIDATION ──────────────────────────────────────────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function sanitizeCosmetics(raw) {
  const out = { ...DEFAULT_COSMETICS };
  if (!raw || typeof raw !== 'object') return out;
  for (const slot of COSMETIC_SLOTS)
    if (typeof raw[slot] === 'string' && raw[slot].length < 32) out[slot] = raw[slot];
  return out;
}
function sanitizeClan(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim().slice(0,6);
  return /^[a-zA-Z0-9_]{2,6}$/.test(t) ? t : null;
}
function sanitizeShip(raw) { return (raw && SHIPS[raw]) ? raw : 'default'; }

// ─── STATE ────────────────────────────────────────────────────────────────────
let players = {};
let bullets  = [];
let nextId   = 1;

function createPlayer(socketId, { username, clan, cosmetics, ship }) {
  const sd = SHIPS[ship] ?? SHIPS.default;
  return {
    id: socketId, username,
    clan: clan ?? null,
    ship, cosmetics,
    // [EXT] accountId, currency, inventory

    // Physics
    x: Math.random() * CONFIG.MAP_SIZE,
    y: Math.random() * CONFIG.MAP_SIZE,
    angle: 0, targetAngle: 0,
    vx: 0, vy: 0,

    // State
    hp: sd.hp, alive: true,
    invuln: CONFIG.RESPAWN_INVULN,
    shootCooldown: 0,
    score: 0, kills: 0, deaths: 0,
    keys: { up:false, down:false, shoot:false, sideLeft:false, sideRight:false, boost:false, borderAnchor:false },

    // Regen
    lastDamageTime: -999,   // server tick count when last hit

    // Boost
    boostFuel: CONFIG.BOOST_MAX,
    boostRechargeTimer: 0,
    boosting: false,

    // Border anchor — toggled by X, persists until toggled off
    borderAnchored: false,

    // Per-ship resolved stats
    _speed:        sd.speed,
    _sideSpeed:    sd.sideSpeed,
    _maxHp:        sd.hp,
    _turnSpeed:    sd.turnSpeed,
    _shootCooldown:sd.shootCooldown,
    _radius:       sd.radius,
  };
}

function spawnBullet(owner) {
  bullets.push({
    id:       nextId++,
    ownerId:  owner.id,
    x:  owner.x + Math.cos(owner.angle) * (owner._radius + 4),
    y:  owner.y + Math.sin(owner.angle) * (owner._radius + 4),
    vx: Math.cos(owner.angle) * CONFIG.BULLET_SPEED + owner.vx * 0.3,
    vy: Math.sin(owner.angle) * CONFIG.BULLET_SPEED + owner.vy * 0.3,
    lifetime:    CONFIG.BULLET_LIFETIME,
    bulletStyle: owner.cosmetics.bulletStyle,
  });
}

// ─── PHYSICS ─────────────────────────────────────────────────────────────────
const DT = 1 / CONFIG.TICK_RATE;
let tickCount = 0;

function angleDiff(a, b) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function tick() {
  tickCount++;
  const now = tickCount * DT; // seconds since start

  for (const p of Object.values(players)) {
    if (!p.alive) continue;

    if (p.invuln > 0) p.invuln -= DT;

    // Toggle border anchor on keypress (edge-detect via keys.borderAnchor)
    // Server receives it as a toggle signal — client sends true when X pressed
    if (p.keys.borderAnchor) {
      p.borderAnchored = !p.borderAnchored;
      p.keys.borderAnchor = false; // consume the signal
    }

    // Rotation
    if (isFinite(p._turnSpeed)) {
      const diff = angleDiff(p.angle, p.targetAngle);
      const ms   = p._turnSpeed * DT;
      p.angle += Math.abs(diff) <= ms ? diff : Math.sign(diff) * ms;
    } else {
      p.angle = p.targetAngle;
    }
    p.angle = ((p.angle + Math.PI) % (Math.PI * 2)) - Math.PI;

    // Boost
    const wantBoost = p.keys.boost && p.boostFuel > 0;
    p.boosting = wantBoost;
    if (wantBoost) {
      p.boostFuel = Math.max(0, p.boostFuel - CONFIG.BOOST_DRAIN * DT);
      p.boostRechargeTimer = CONFIG.BOOST_RECHARGE_DELAY;
    } else {
      if (p.boostRechargeTimer > 0) p.boostRechargeTimer -= DT;
      else p.boostFuel = Math.min(CONFIG.BOOST_MAX, p.boostFuel + CONFIG.BOOST_RECHARGE * DT);
    }

    const boostMult  = wantBoost ? CONFIG.BOOST_SPEED_MULT : 1;
    const anchorMult = p.borderAnchored ? (1 - CONFIG.BORDER_ANCHOR_PENALTY) : 1;
    const effSpeed   = p._speed * boostMult * anchorMult;

    // Thrust
    if (p.keys.up) {
      p.vx += Math.cos(p.angle) * effSpeed * DT * 2.5;
      p.vy += Math.sin(p.angle) * effSpeed * DT * 2.5;
    }

    // Strafe
    if (p.keys.sideLeft || p.keys.sideRight) {
      const dir   = p.keys.sideRight ? 1 : -1;
      p.vx += -Math.sin(p.angle) * dir * p._sideSpeed * DT * 4;
      p.vy +=  Math.cos(p.angle) * dir * p._sideSpeed * DT * 4;
    }

    const drag = p.keys.down ? 0.88 : 0.97;
    p.vx *= drag; p.vy *= drag;

    const spd = Math.hypot(p.vx, p.vy);
    if (spd > effSpeed) { p.vx = p.vx/spd*effSpeed; p.vy = p.vy/spd*effSpeed; }

    // ── BORDER — hard clamp, no wrapping ──────────────────────────────────
    let nx = p.x + p.vx * DT;
    let ny = p.y + p.vy * DT;
    const M = CONFIG.MAP_SIZE;

    if (!p.borderAnchored) {
      // Hard bounce — reflect + kill most velocity
      if (nx < 0)  { nx = 0;  p.vx =  Math.abs(p.vx) * 0.3; }
      if (nx > M)  { nx = M;  p.vx = -Math.abs(p.vx) * 0.3; }
      if (ny < 0)  { ny = 0;  p.vy =  Math.abs(p.vy) * 0.3; }
      if (ny > M)  { ny = M;  p.vy = -Math.abs(p.vy) * 0.3; }
    } else {
      // Anchored — clamp without killing velocity (player keeps momentum for turning)
      nx = Math.max(0, Math.min(M, nx));
      ny = Math.max(0, Math.min(M, ny));
    }
    p.x = nx; p.y = ny;

    // ── HEALTH REGEN ──────────────────────────────────────────────────────
    if (p.hp < p._maxHp && (now - p.lastDamageTime) >= CONFIG.REGEN_DELAY) {
      p.hp = Math.min(p._maxHp, p.hp + CONFIG.REGEN_RATE * DT);
    }

    // Shoot
    if (p.shootCooldown > 0) p.shootCooldown -= DT;
    if (p.keys.shoot && p.shootCooldown <= 0) {
      spawnBullet(p);
      p.shootCooldown = p._shootCooldown;
    }
  }

  // ── BULLETS ──────────────────────────────────────────────────────────────
  bullets = bullets.filter(b => {
    b.lifetime -= DT;
    if (b.lifetime <= 0) return false;

    // Bullets wrap around the map (they don't have the border restriction)
    b.x = ((b.x + b.vx*DT) % CONFIG.MAP_SIZE + CONFIG.MAP_SIZE) % CONFIG.MAP_SIZE;
    b.y = ((b.y + b.vy*DT) % CONFIG.MAP_SIZE + CONFIG.MAP_SIZE) % CONFIG.MAP_SIZE;

    for (const p of Object.values(players)) {
      if (!p.alive || p.id === b.ownerId || p.invuln > 0) continue;
      if (Math.hypot(p.x - b.x, p.y - b.y) < p._radius) {
        p.hp -= CONFIG.BULLET_DAMAGE;
        p.lastDamageTime = now;   // reset regen timer

        // Emit hit spark event to all clients
        io.emit('bullet_hit', { x: b.x, y: b.y, bulletStyle: b.bulletStyle });

        if (p.hp <= 0) {
          p.hp = 0; p.alive = false; p.deaths++;
          const killer = players[b.ownerId];
          if (killer) { killer.kills++; killer.score += 100; }
          io.emit('player_died', {
            id: p.id, killerId: b.ownerId,
            killerName: killer?.username ?? null,
            victimName: p.username,
            x: p.x, y: p.y,   // death position for explosion
          });
        }
        return false;
      }
    }
    return true;
  });
}

// ─── BROADCAST ───────────────────────────────────────────────────────────────
function broadcastState() {
  io.emit('state', {
    players: Object.values(players).map(p => ({
      id: p.id, username: p.username, clan: p.clan,
      ship: p.ship, cosmetics: p.cosmetics,
      x: p.x, y: p.y, angle: p.angle, vx: p.vx, vy: p.vy,
      hp: p.hp, maxHp: p._maxHp,
      alive: p.alive, invuln: p.invuln > 0,
      score: p.score, kills: p.kills, deaths: p.deaths,
      thrusting:      p.keys.up,
      boosting:       p.boosting,
      boostFuel:      p.boostFuel,
      boostMax:       CONFIG.BOOST_MAX,
      borderAnchored: p.borderAnchored,
      sideThrusting:  p.keys.sideLeft ? -1 : p.keys.sideRight ? 1 : 0,
      // [EXT] weapon, armor, shield
    })),
    bullets: bullets.map(b => ({
      id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy,
      angle: Math.atan2(b.vy, b.vx),
      bulletStyle: b.bulletStyle,
    })),
  });
}

setInterval(tick,           1000 / CONFIG.TICK_RATE);
setInterval(broadcastState, 1000 / CONFIG.BROADCAST_RATE);

// ─── CONNECTIONS ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  socket.on('join', ({ username, clan, cosmetics, ship } = {}) => {
    const name = (username || '').trim();
    if (!USERNAME_RE.test(name)) {
      socket.emit('join_error', { message: 'Name must be 3–20 chars: letters, numbers, underscores only.' });
      return;
    }
    const p = createPlayer(socket.id, {
      username: name,
      clan:      sanitizeClan(clan),
      cosmetics: sanitizeCosmetics(cosmetics),
      ship:      sanitizeShip(ship),
    });
    players[socket.id] = p;
    console.log(`[JOIN] ${p.username} (${socket.id})`);
    socket.emit('welcome', {
      id: socket.id,
      config: { mapSize: CONFIG.MAP_SIZE, playerRadius: CONFIG.PLAYER_RADIUS, maxHp: CONFIG.PLAYER_MAX_HP },
    });
  });

  socket.on('input', ({ keys, angle } = {}) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    p.keys.up           = !!keys?.up;
    p.keys.down         = !!keys?.down;
    p.keys.shoot        = !!keys?.shoot;
    p.keys.sideLeft     = !!keys?.sideLeft;
    p.keys.sideRight    = !!keys?.sideRight;
    p.keys.boost        = !!keys?.boost;
    // borderAnchor is a pulse signal — true only when X key just pressed
    if (keys?.borderAnchor) p.keys.borderAnchor = true;
    if (typeof angle === 'number' && isFinite(angle)) p.targetAngle = angle;
  });

  socket.on('respawn', () => {
    const p = players[socket.id];
    if (!p || p.alive) return;
    p.x = Math.random() * CONFIG.MAP_SIZE;
    p.y = Math.random() * CONFIG.MAP_SIZE;
    p.vx = p.vy = 0;
    p.hp = p._maxHp; p.alive = true;
    p.invuln = CONFIG.RESPAWN_INVULN;
    p.keys = { up:false, down:false, shoot:false, sideLeft:false, sideRight:false, boost:false, borderAnchor:false };
    p.boostFuel = CONFIG.BOOST_MAX;
    p.boostRechargeTimer = 0;
    p.borderAnchored = false;
    p.lastDamageTime = -999;
    console.log(`[RESPAWN] ${p.username}`);
  });

  socket.on('chat', ({ msg } = {}) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    if (typeof msg !== 'string') return;
    let clean = msg.replace(/[^a-zA-Z0-9 .,!?'\-]/g, '').trim().slice(0, 80);
    if (!clean) return;
    // ── CENSORED WORDS — fill this array with strings you want blocked ────
    const CENSORED = [];
    for (const w of CENSORED) {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      clean = clean.replace(new RegExp(`\\b${esc}\\b`, 'gi'), '*'.repeat(w.length));
    }
    console.log(`[CHAT] ${p.username}: ${clean}`);
    io.emit('chat', { id: socket.id, username: p.username, clan: p.clan, msg: clean, t: Date.now() });
  });

  socket.on('ping', () => socket.emit('pong'));

  // [EXT] socket.on('equip', ...) socket.on('dock', ...) socket.on('market_buy', ...)

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) {
      console.log(`[LEAVE] ${p.username}`);
      io.emit('player_left', { id: socket.id });
      delete players[socket.id];
    }
  });
});

server.listen(CONFIG.PORT, () => console.log(`[SERVER] VOIDRIFT on port ${CONFIG.PORT}`));
