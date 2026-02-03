import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  ChannelType,
  Events
} from "discord.js";

import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== ENV ======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const PLAYERS_URL = process.env.PLAYERS_URL;
const GUILDS_URL = process.env.GUILDS_URL;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // Basic auth (players)
const PALDEFENDER_TOKEN = process.env.PALDEFENDER_TOKEN; // Bearer (guilds)

const INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES ?? 10);

// Optionnel: pour matcher exactement l'image "PalworldSaveTools" que tu as jointe
// Exemple: MAP_IMAGE=../assets/updated_worldmap.png
const MAP_IMAGE = process.env.MAP_IMAGE;
const OUTPUT_SIZE = 4096;
// ====== COORDS / CALIBRATION ======
//
// 1) world -> map (déduit de tes couples joueurs world<->map)
//
// mapX ≈ ax*worldX + bx*worldY + cx
// mapY ≈ dx*worldX + ex*worldY + fx
//
// Coeffs issus d'un fit sur:
//  (-599707.69, -360077.13) -> (-1129, 1037)
//  (  35266.16,  321438.91) -> (  356, -347)
//  (  -1856.02, -148615.58) -> ( -668, -266)
//  (-558096.00,  120982.28) -> (  -81,  946)
const WORLD_TO_MAP = {
  transl_x: 123888,
  transl_y: 158000,
  scale: 459,
};

// 2) map -> pixel (déduit de tes correspondances map_pos -> pixels sur l'image 8192)
//
// px ≈ A*mapX + B
// py ≈ C*mapY + D
//
// Points utilisés:
// map(-589.057,  276.500) -> px(3546), py(2518)
// map( 399.670, -467.508) -> px(6110), py(4447)
// map(-556.759,   10.149) -> px(3628), py(3206)
// map( 419.385, -317.217) -> px(6163), py(4057)
// map(-1123.327,-1036.224)-> px(2158), py(5925)
const MAP_TO_PX = {
  A: 2.5953628006591515,
  B: 5073.702848050116,
  C: -2.596070066847979,
  D: 3233.9698454713814,
};

function worldToMap(worldX, worldY) {
  // équivalent palworld_coord.sav_to_map(..., new=False)
  // newX = x + transl_x
  // newY = y - transl_y
  // mapX = newY / scale
  // mapY = newX / scale
  const newX = worldX + WORLD_TO_MAP.transl_x;
  const newY = worldY - WORLD_TO_MAP.transl_y;

  return {
    mapX: newY / WORLD_TO_MAP.scale,
    mapY: newX / WORLD_TO_MAP.scale,
  };
}

function mapToPixel(mapX, mapY) {
  const px = MAP_TO_PX.A * mapX + MAP_TO_PX.B;
  const py = MAP_TO_PX.C * mapY + MAP_TO_PX.D;
  return { px, py };
}

function worldToPixel(worldX, worldY) {
  const { mapX, mapY } = worldToMap(worldX, worldY);
  return mapToPixel(mapX, mapY);
}

// ====== ASSETS ======
const ASSETS = {
  map: MAP_IMAGE
    ? path.resolve(__dirname, MAP_IMAGE)
    : path.resolve(__dirname, "../assets/T_WorldMap.png"),

  camp: path.resolve(__dirname, "../assets/T_icon_compass_camp.png"),
  player: path.resolve(__dirname, "../assets/T_icon_compass_00.png"),
};

let iconCache = null;

async function loadIconsOnce() {
  if (iconCache) return iconCache;

  const CAMP_SIZE = 128;
  const PLAYER_SIZE = 112;

  const camp = await sharp(ASSETS.camp)
    .resize(CAMP_SIZE, CAMP_SIZE, { fit: "fill", kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();

  const player = await sharp(ASSETS.player)
    .resize(PLAYER_SIZE, PLAYER_SIZE, { fit: "fill", kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();

  iconCache = {
    camp,
    player,
    CAMP_SIZE,
    PLAYER_SIZE,
  };

  return iconCache;
}

// ====== STATE ======
const STATE_DIR = path.resolve(__dirname, "../state");
const STATE_FILE = path.join(STATE_DIR, "palmap-state.json");

/**
 * State format:
 * {
 *   "guilds": {
 *     "<guildId>": {
 *       "channelId": "...",
 *       "messageId": "...",
 *       "lastHash": "...",
 *       "lastUpdatedAt": "ISO..."
 *     }
 *   }
 * }
 */
function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { guilds: {} };
  }
}

function saveState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ====== AUTH FETCHERS ======
async function fetchPlayers() {
  if (!ADMIN_PASSWORD) throw new Error("Missing env ADMIN_PASSWORD");
  if (!PLAYERS_URL) throw new Error("Missing env PLAYERS_URL");

  const auth = Buffer.from(`admin:${ADMIN_PASSWORD}`).toString("base64");

  const res = await fetch(PLAYERS_URL, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) throw new Error(`Players API HTTP ${res.status}`);
  return res.json();
}

async function fetchGuilds() {
  if (!PALDEFENDER_TOKEN) throw new Error("Missing env PALDEFENDER_TOKEN");
  if (!GUILDS_URL) throw new Error("Missing env GUILDS_URL");

  const res = await fetch(GUILDS_URL, {
    headers: { Authorization: `Bearer ${PALDEFENDER_TOKEN}` },
  });

  if (!res.ok) throw new Error(`Guilds API HTTP ${res.status}`);
  return res.json();
}

// ====== DATA NORMALIZATION ======
function extractCamps(guildsJson) {
  const camps = [];
  for (const guildId of Object.keys(guildsJson)) {
    const g = guildsJson[guildId];
    for (const c of (g.camps ?? [])) {
      camps.push({
        guild: g.name,
        camp_id: c.id,

        // ✅ on utilise map_pos directement (c'est notre meilleure vérité)
        map_x: (typeof c.map_pos?.x === "number") ? c.map_pos.x : null,
        map_y: (typeof c.map_pos?.y === "number") ? c.map_pos.y : null,

        // debug
        world_x: c.world_pos?.x ?? null,
        world_y: c.world_pos?.y ?? null,
      });
    }
  }
  return camps;
}

// ====== HASH (no change = no edit) ======
function stableSnapshotForHash(players, camps) {
  const p = (players ?? [])
    .map(x => ({
      id: x.playerId ?? x.userId ?? x.name ?? "",
      name: x.name ?? x.nickname ?? "",
      x: Number(x.location_x ?? 0),
      y: Number(x.location_y ?? 0),
    }))
    .sort((a, b) => (a.id || a.name).localeCompare(b.id || b.name));

  const c = (camps ?? [])
    .map(x => ({
      id: x.camp_id ?? "",
      guild: x.guild ?? "",
      mx: Number(x.map_x ?? 0),
      my: Number(x.map_y ?? 0),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { players: p, camps: c };
}

function sha256(obj) {
  const json = JSON.stringify(obj);
  return crypto.createHash("sha256").update(json).digest("hex");
}

// ====== RENDER (Sharp) ======
function escapeXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function makeLabelSvgSmall(text) {
  const t = escapeXml(text);
  const paddingX = 8;
  const paddingY = 4;
  const fontSize = 18;

  const textWidth = Math.max(60, t.length * 7);
  const w = textWidth + paddingX * 2;
  const h = fontSize + paddingY * 2 + 2;

  return Buffer.from(`
<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${w}" height="${h}" rx="6" ry="6" fill="rgba(0,0,0,0.75)"/>
  <text x="${paddingX}" y="${fontSize + paddingY}" font-family="Arial, sans-serif"
        font-size="${fontSize}" font-weight="bold" fill="white">${t}</text>
</svg>`);
}

async function renderSnapshot({ players, camps }) {
  const icons = await loadIconsOnce();

  // 1) lire la map source
  const baseSrc = sharp(ASSETS.map);
  const meta = await baseSrc.metadata();
  const srcW = meta.width ?? 8192;
  const srcH = meta.height ?? 8192;

  // 2) créer un canvas base en OUTPUT_SIZE
  const base = baseSrc.resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "fill" });

  // 3) facteur d’échelle coord pixels
  const sx = OUTPUT_SIZE / srcW;
  const sy = OUTPUT_SIZE / srcH;

  const composites = [];

  // Camps
  for (const c of camps) {
    if (typeof c.map_x !== "number" || typeof c.map_y !== "number") continue;

    const { px, py } = mapToPixel(c.map_x, c.map_y); // px/py en repère srcW/srcH (8192)
    const x = px * sx;
    const y = py * sy;

    const size = icons.CAMP_SIZE;
    composites.push({
      input: icons.camp,
      left: Math.round(x - size / 2),
      top: Math.round(y - size / 2),
    });
  }

  // Players
  for (const p of players) {
    const wx = Number(p.location_x ?? 0);
    const wy = Number(p.location_y ?? 0);
    if (!wx && !wy) continue;

    const { px, py } = worldToPixel(wx, wy); // px/py en repère srcW/srcH
    const x = px * sx;
    const y = py * sy;

    const size = icons.PLAYER_SIZE;
    composites.push({
      input: icons.player,
      left: Math.round(x - size / 2),
      top: Math.round(y - size),
    });

    const labelSvg = makeLabelSvgSmall(p.name ?? p.nickname ?? "Player");
    composites.push({
      input: labelSvg,
      left: Math.round(x + 12),
      top: Math.round(y - 56),
    });
  }

  return await base
    .composite(composites)
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

// ====== DISCORD HELPERS ======
function formatHeader(playersCount, campsCount, note = "") {
  const ts = new Date().toLocaleString("fr-FR");
  const extra = note ? `\n${note}` : "";
  return `🗺️ **Palworld — Snapshot**\n🧍 Joueurs: **${playersCount}** • 🏕️ Camps: **${campsCount}**\n⏱️ Dernière mise à jour: **${ts}**${extra}`;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let running = false;

async function ensureMessage(channel, guildId, state) {
  const cfg = state.guilds[guildId];
  if (!cfg) throw new Error("No config for this guild");

  if (cfg.messageId) {
    try {
      const msg = await channel.messages.fetch(cfg.messageId);
      return msg;
    } catch {
      // supprimé / introuvable → on recrée
    }
  }

  const msg = await channel.send("🗺️ Initialisation de la carte…");
  cfg.messageId = msg.id;
  saveState(state);
  return msg;
}

async function doUpdateForGuild(guildId, cfg, state, data, { force = false } = {}) {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const msg = await ensureMessage(channel, guildId, state);

  if (!force && cfg.lastHash && cfg.lastHash === data.hash) {
    return;
  }

  const buf = await renderSnapshot({ players: data.players, camps: data.camps });
  const file = new AttachmentBuilder(buf, { name: "palworld-map.jpg" });

  await msg.edit({
    content: formatHeader(
      data.players.length,
      data.camps.length,
      force ? "⚡ Update forcé" : ""
    ),
    files: [file],
  });

  cfg.lastHash = data.hash;
  cfg.lastUpdatedAt = new Date().toISOString();
  saveState(state);
}

async function fetchSnapshotData() {
  const playersJson = await fetchPlayers();
  const guildsJson = await fetchGuilds();

  const players = playersJson.players ?? playersJson ?? [];
  const camps = extractCamps(guildsJson);

  const hashPayload = stableSnapshotForHash(players, camps);
  const hash = sha256(hashPayload);

  return { players, camps, hash };
}

async function tick({ forceGuildId = null } = {}) {
  if (running) return;
  running = true;

  try {
    const state = loadState();
    const guildEntries = Object.entries(state.guilds ?? {});
    if (guildEntries.length === 0) return;

    const data = await fetchSnapshotData();

    for (const [guildId, cfg] of guildEntries) {
      if (!cfg?.channelId) continue;
      if (forceGuildId && guildId !== forceGuildId) continue;

      await doUpdateForGuild(guildId, cfg, state, data, {
        force: forceGuildId === guildId,
      }).catch(err => console.error(`Update error guild ${guildId}:`, err));
    }
  } catch (err) {
    console.error("Tick error:", err);
  } finally {
    running = false;
  }
}

// ====== SLASH COMMANDS ======
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "palmap") return;

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.reply({ content: "Cette commande doit être utilisée dans un serveur.", ephemeral: true });
    return;
  }

  const state = loadState();
  state.guilds ??= {};
  state.guilds[guildId] ??= {};

  if (sub === "add") {
    const channel = interaction.options.getChannel("channel", true);

    if (channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Je peux seulement poster dans un canal texte (GuildText).", ephemeral: true });
      return;
    }

    state.guilds[guildId].channelId = channel.id;
    state.guilds[guildId].messageId = null;
    state.guilds[guildId].lastHash = null;
    state.guilds[guildId].lastUpdatedAt = null;

    saveState(state);

    await interaction.reply({
      content: `✅ Ok, j’attache la live-map à ${channel}.\nJe poste/édite **un seul message** dans ce canal.`,
      ephemeral: true
    });

    await tick({ forceGuildId: guildId });
    return;
  }

  if (sub === "remove") {
    const had = !!state.guilds[guildId]?.channelId;
    delete state.guilds[guildId];
    saveState(state);

    await interaction.reply({
      content: had
        ? "🧹 Live-map détachée pour ce serveur. Je n’éditerai plus rien."
        : "Il n’y avait pas de live-map attachée sur ce serveur.",
      ephemeral: true
    });
    return;
  }

  if (sub === "status") {
    const cfg = state.guilds[guildId];
    if (!cfg?.channelId) {
      await interaction.reply({ content: "Aucune live-map attachée sur ce serveur.", ephemeral: true });
      return;
    }
    const when = cfg.lastUpdatedAt ? new Date(cfg.lastUpdatedAt).toLocaleString("fr-FR") : "jamais";
    await interaction.reply({
      content: `📌 Live-map attachée à <#${cfg.channelId}>\n🧾 Message ID: ${cfg.messageId ?? "pas encore créé"}\n⏱️ Dernier update: ${when}`,
      ephemeral: true
    });
    return;
  }

  if (sub === "force") {
    const cfg = state.guilds[guildId];
    if (!cfg?.channelId) {
      await interaction.reply({ content: "Aucune live-map attachée. Fais `/palmap add #canal` d’abord.", ephemeral: true });
      return;
    }

    await interaction.reply({ content: "⚡ Update forcé en cours…", ephemeral: true });
    await tick({ forceGuildId: guildId });
    return;
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged as ${client.user.tag}`);

  await tick();
  setInterval(() => tick(), INTERVAL_MINUTES * 60 * 1000);
});

client.login(DISCORD_TOKEN);
