import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { EmbedBuilder } from "discord.js";

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

const LEGEND_SCALE = 2.5; // x2

// ====== GUILD COLORS ======
const GUILD_COLORS = [
  "#ff0000", // rouge
  "#3498DB", // bleu
  "#2ECC71", // vert
  "#F1C40F", // jaune
  "#9B59B6", // violet
  "#E67E22", // orange
  "#ff21e1", // rose
  "#95A5A6", // gris
  "#00ffff", // cyan
  "#FF5722", // deep orange
  "#8BC34A", // light green
  "#5e6f9e", // tailos
  "#004953", // stratof
];

function normalizePalId(id) {
  // guild members: "21FCEE28-00000000-..." vs players: "21FCEE2800000000..."
  return String(id ?? "").replaceAll("-", "").toLowerCase();
}

function pickColorForGuild(palGuildId, state) {
  state.palworld ??= {};
  state.palworld.guildColors ??= {};

  if (!state.palworld.guildColors[palGuildId]) {
    const used = new Set(Object.values(state.palworld.guildColors));
    const available = GUILD_COLORS.filter(c => !used.has(c));
    const color = available.length
      ? available[0]
      : GUILD_COLORS[Math.floor(Math.random() * GUILD_COLORS.length)];

    state.palworld.guildColors[palGuildId] = color;
    saveState(state);
  }

  return state.palworld.guildColors[palGuildId];
}

// ====== COORDS / CALIBRATION ======
const WORLD_TO_MAP = {
  transl_x: 123888,
  transl_y: 158000,
  scale: 459,
};

const MAP_TO_PX = {
  A: 2.5953628006591515,
  B: 5073.702848050116,
  C: -2.596070066847979,
  D: 3233.9698454713814,
};

function worldToMap(worldX, worldY) {
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

const tintedCache = {
  camp: new Map(),   // key: color -> buffer
  player: new Map(), // key: color -> buffer
};

async function getTintedIcon(basePath, size, colorHex) {
  const key = colorHex.toLowerCase();

  const cache =
    basePath === ASSETS.camp ? tintedCache.camp :
    basePath === ASSETS.player ? tintedCache.player :
    null;

  if (cache && cache.has(key)) return cache.get(key);

  const buf = await sharp(basePath)
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.nearest })
    .tint(colorHex)
    .png()
    .toBuffer();

  if (cache) cache.set(key, buf);
  return buf;
}

async function loadIconsOnce() {
  if (iconCache) return iconCache;

  const CAMP_SIZE = 128;
  const PLAYER_SIZE = 112;

  iconCache = { CAMP_SIZE, PLAYER_SIZE };
  return iconCache;
}

// ====== STATE ======
const STATE_DIR = path.resolve(__dirname, "../state");
const STATE_FILE = path.join(STATE_DIR, "palmap-state.json");

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
        guild_id: guildId,
        guild: g.name,

        camp_id: c.id,

        map_x: (typeof c.map_pos?.x === "number") ? c.map_pos.x : null,
        map_y: (typeof c.map_pos?.y === "number") ? c.map_pos.y : null,

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

function hexToRgb(hex) {
  const h = String(hex ?? "").replace("#", "").trim();
  if (h.length !== 6) return { r: 255, g: 255, b: 255 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function makeLegendSvg(legendGuilds, scale = 1) {
  // layout base (avant scale)
  const pad = 14;
  const rowH = 28;
  const titleH = 24;
  const dotR = 7;

  const w = 340;
  const h = pad * 2 + titleH + legendGuilds.length * rowH;

  const rows = legendGuilds.map((g, i) => {
    const y = pad + titleH + i * rowH + 18;

    const { r, g: gg, b } = hexToRgb(g.color);
    const name = escapeXml(g.name ?? "Guild");
    const count = Number(g.campCount ?? 0);

    return `
      <circle cx="${pad + dotR}" cy="${y - 6}" r="${dotR}" fill="rgb(${r},${gg},${b})" />
      <text x="${pad + dotR * 2 + 10}" y="${y}" font-family="Arial, sans-serif"
            font-size="16" font-weight="700" fill="white">${name}</text>
      <text x="${w - pad}" y="${y}" text-anchor="end" font-family="Arial, sans-serif"
            font-size="16" font-weight="700" fill="white">${count}</text>
    `;
  }).join("\n");

  // SVG final: on scale tout le contenu (sans flou)
  const scaledW = Math.round(w * scale);
  const scaledH = Math.round(h * scale);

  return {
    buf: Buffer.from(`
<svg width="${scaledW}" height="${scaledH}" xmlns="http://www.w3.org/2000/svg">
  <g transform="scale(${scale})">
    <rect x="0" y="0" width="${w}" height="${h}" rx="14" ry="14" fill="rgba(0,0,0,0.55)"/>
    <text x="${pad}" y="${pad + 18}" font-family="Arial, sans-serif"
          font-size="16" font-weight="800" fill="white">Guildes (bases)</text>
    ${rows}
  </g>
</svg>`),
    w: scaledW,
    h: scaledH,
  };
}

async function renderSnapshot({ players, camps, playerToGuild, legendGuilds, state }) {
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

    const { px, py } = mapToPixel(c.map_x, c.map_y);
    const x = px * sx;
    const y = py * sy;

    const size = icons.CAMP_SIZE;

    const color = pickColorForGuild(c.guild_id ?? "unknown", state);
    const campIcon = await getTintedIcon(ASSETS.camp, size, color);

    composites.push({
      input: campIcon,
      left: Math.round(x - size / 2),
      top: Math.round(y - size / 2),
    });
  }

  // Players
  for (const p of players) {
    const wx = Number(p.location_x ?? 0);
    const wy = Number(p.location_y ?? 0);
    if (!wx && !wy) continue;

    const { px, py } = worldToPixel(wx, wy);
    const x = px * sx;
    const y = py * sy;

    const size = icons.PLAYER_SIZE;

    const pid = normalizePalId(p.playerId ?? p.player_id ?? "");
    const palGuildId = playerToGuild?.[pid] ?? null;

    const color = palGuildId ? pickColorForGuild(palGuildId, state) : "#FFFFFF";
    const playerIcon = await getTintedIcon(ASSETS.player, size, color);

    composites.push({
      input: playerIcon,
      left: Math.round(x - size / 2),
      top: Math.round(y - size), // bottom-center (épingle)
    });

    const labelSvg = makeLabelSvgSmall(p.name ?? p.nickname ?? "Player");
    composites.push({
      input: labelSvg,
      left: Math.round(x + 12),
      top: Math.round(y - 56),
    });
  }

  // Legend (bottom-right)
  if (Array.isArray(legendGuilds) && legendGuilds.length) {
    const { buf: legendSvg, w: legendW, h: legendH } = makeLegendSvg(legendGuilds, LEGEND_SCALE);

    composites.push({
      input: legendSvg,
      left: OUTPUT_SIZE - legendW - 24,
      top: OUTPUT_SIZE - legendH - 24,
    });
  }

  return await base
    .composite(composites)
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

// ====== DISCORD HELPERS ======
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

  const buf = await renderSnapshot({
    players: data.players,
    camps: data.camps,
    playerToGuild: data.playerToGuild,
    legendGuilds: data.legendGuilds,
    state, // <= important: pour persister les couleurs
  });

  const file = new AttachmentBuilder(buf, { name: "palworld-map.jpg" });
  const embed = makePalmapEmbed({
    playersCount: data.players.length,
    campsCount: data.camps.length,
    force,
  });

  await msg.edit({
    content: "",
    embeds: [embed],
    files: [file],
  });

  cfg.lastHash = data.hash;
  cfg.lastUpdatedAt = new Date().toISOString();
  saveState(state);
}

function buildPlayerToGuildMap(guildsJson) {
  const map = {};
  for (const guildId of Object.keys(guildsJson)) {
    const g = guildsJson[guildId];
    for (const memberId of (g.members ?? [])) {
      map[normalizePalId(memberId)] = guildId;
    }
    if (g.admin?.id) {
      map[normalizePalId(g.admin.id)] = guildId;
    }
  }
  return map;
}

async function fetchSnapshotData() {
  const playersJson = await fetchPlayers();
  const guildsJson = await fetchGuilds();

  const players = playersJson.players ?? playersJson ?? [];
  const camps = extractCamps(guildsJson);

  const playerToGuild = buildPlayerToGuildMap(guildsJson);

  // ✅ LEGEND: on utilise les couleurs persistées (state) via pickColorForGuild
  // Note: on ne filtre que les guildes avec au moins 1 base
  const state = loadState();
  const legendGuilds = Object.entries(guildsJson)
    .map(([gid, g]) => ({
      id: gid,
      name: g.name,
      campCount: g.camp_count ?? 0,
      color: pickColorForGuild(gid, state),
    }))
    .filter(g => g.campCount > 0)
    .sort((a, b) => (b.campCount - a.campCount) || a.name.localeCompare(b.name));

  // ⚠️ pickColorForGuild peut avoir modifié le state (persist),
  // donc on resave au cas où (même si pickColorForGuild le fait déjà)
  saveState(state);

  const hashPayload = stableSnapshotForHash(players, camps);
  const hash = sha256(hashPayload);

  return { players, camps, playerToGuild, guildsJson, legendGuilds, hash };
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

      // IMPORTANT: on recharge state ici pour doUpdateForGuild (colors etc.)
      const freshState = loadState();

      await doUpdateForGuild(guildId, cfg, freshState, data, {
        force: forceGuildId === guildId,
      }).catch(err => console.error(`Update error guild ${guildId}:`, err));
    }
  } catch (err) {
    console.error("Tick error:", err);
  } finally {
    running = false;
  }
}

function makePalmapEmbed({ playersCount, campsCount, force = false }) {
  return new EmbedBuilder()
    .setTitle("🗺️ Memiroa — Live Map")
    .setColor(playersCount > 0 ? 0x3BA55D : 0x747F8D)
    .addFields(
      { name: "Joueurs", value: `${playersCount}/20`, inline: true },
      { name: "Bases", value: `${campsCount}`, inline: true },
      { name: "\u200B", value: "\u200B", inline: true }
    )
    .setFooter({ text: "Memiroa Bot • Mise à jour automatique" })
    .setTimestamp(new Date());
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
      content: `✅ Ok, j’attache la live-map à ${channel}.\nJe poste/édite un seul message dans ce canal.`,
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
      await interaction.reply({ content: "Aucune live-map attachée. Fais \`/palmap add #canal\` d’abord.", ephemeral: true });
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
