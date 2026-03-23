import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, access, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname);
const APP_DIR = join(ROOT, 'app');
const DATA_DIR = join(ROOT, 'data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const WATCHLIST_PATH = join(DATA_DIR, 'watchlists.json');
const SNAPSHOT_DIR = join(DATA_DIR, 'snapshots');
const DEFAULT_PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const DEFAULT_CONFIG = {
  openaiApiKey: '',
  openaiModel: 'gpt-4.1-mini',
  googleMapsApiKey: '',
  cesiumIonToken: '',
  openSkyClientId: '',
  openSkyClientSecret: '',
  aisFeedUrl: '',
  aisUsername: '',
  trafficIncidentsUrl: '',
  trafficTileUrl: '',
  camerasUrl: '',
  customGeoJsonUrl: '',
  transitFeeds: [],
};

async function ensureDataLayout() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  try { await access(CONFIG_PATH); } catch { await writeJson(CONFIG_PATH, DEFAULT_CONFIG); }
  try { await access(WATCHLIST_PATH); } catch { await writeJson(WATCHLIST_PATH, []); }
}

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

function json(res, code, value) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(value));
}

function text(res, code, value) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(value);
}

async function getBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inBounds(lat, lon, bbox) {
  if (!bbox) return true;
  return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
}

async function loadEarthquakes(bbox) {
  const data = await fetchJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson');
  const items = (data.features || []).map((f) => ({
    id: f.id,
    type: 'earthquake',
    title: f.properties?.title || 'Earthquake',
    mag: f.properties?.mag,
    time: f.properties?.time,
    lat: f.geometry?.coordinates?.[1],
    lon: f.geometry?.coordinates?.[0],
    depth: f.geometry?.coordinates?.[2],
    url: f.properties?.url,
  })).filter((x) => inBounds(x.lat, x.lon, bbox));
  return items;
}

async function loadNaturalEvents() {
  const data = await fetchJson('https://eonet.gsfc.nasa.gov/api/v3/events?status=open');
  return (data.events || []).flatMap((e) => (e.geometry || []).map((g, idx) => ({
    id: `${e.id}-${idx}`,
    type: 'natural_event',
    title: e.title,
    category: e.categories?.[0]?.title || 'Event',
    time: g.date,
    lat: g.coordinates?.[1],
    lon: g.coordinates?.[0],
    url: e.link,
  })));
}

async function loadFlights(bbox, config) {
  const params = bbox ? `?lamin=${bbox.south}&lomin=${bbox.west}&lamax=${bbox.north}&lomax=${bbox.east}` : '';
  const headers = {};
  if (config.openSkyClientId && config.openSkyClientSecret) {
    const token = Buffer.from(`${config.openSkyClientId}:${config.openSkyClientSecret}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  const data = await fetchJson(`https://opensky-network.org/api/states/all${params}`, headers);
  return (data.states || []).map((s, idx) => ({
    id: s[0] || `flight-${idx}`,
    type: 'flight',
    callsign: (s[1] || '').trim(),
    country: s[2],
    time: s[3] || s[4],
    lon: s[5],
    lat: s[6],
    altitude: s[7],
    onGround: s[8],
    speed: s[9],
    heading: s[10],
    verticalRate: s[11],
    squawk: s[14],
  })).filter((x) => x.lat != null && x.lon != null);
}

async function loadWeatherPoint(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,relative_humidity_2m,weather_code&hourly=temperature_2m,wind_speed_10m&forecast_days=1`;
  return fetchJson(url);
}

async function loadTransitStatic(bbox) {
  const q = `
[out:json][timeout:25];
(
  node["railway"="station"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  way["railway"~"rail|subway|light_rail|tram"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  node["highway"="bus_stop"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out body geom;`;
  const data = await fetchJson('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q));
  const stations = [];
  const busStops = [];
  const lines = [];
  for (const el of data.elements || []) {
    if (el.type === 'node' && el.tags?.railway === 'station') {
      stations.push({ id: `st-${el.id}`, type: 'train_station', name: el.tags.name || 'Station', lat: el.lat, lon: el.lon });
    }
    if (el.type === 'node' && el.tags?.highway === 'bus_stop') {
      busStops.push({ id: `bus-${el.id}`, type: 'bus_stop', name: el.tags.name || 'Bus Stop', lat: el.lat, lon: el.lon });
    }
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      lines.push({
        id: `line-${el.id}`,
        type: 'train_line',
        name: el.tags?.name || el.tags?.ref || 'Rail Line',
        geometry: el.geometry.map((p) => [p.lat, p.lon]),
      });
    }
  }
  return { stations, busStops, lines };
}

async function loadJsonFeed(url) {
  if (!url) return [];
  return fetchJson(url);
}

async function saveSnapshot(body) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(SNAPSHOT_DIR, `${ts}.json`);
  await writeJson(path, body);
  return { ok: true, file: path };
}

async function listSnapshots() {
  const files = await readdir(SNAPSHOT_DIR);
  const out = [];
  for (const file of files) {
    const full = join(SNAPSHOT_DIR, file);
    const s = await stat(full);
    out.push({ file, mtimeMs: s.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 50);
}

async function analystSummary(prompt, context, config) {
  if (!config.openaiApiKey) {
    return {
      mode: 'local',
      text: `Local summary for: ${prompt}\n\nVisible counts: ${Object.entries(context.counts || {}).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}\nSnapshot count: ${context.snapshots?.length || 0}`,
    };
  }
  const payload = {
    model: config.openaiModel || 'gpt-4.1-mini',
    input: [
      { role: 'system', content: [{ type: 'input_text', text: 'You are an OSINT situational awareness analyst. Summarize visible evidence, note uncertainty, and stay concise.' }] },
      { role: 'user', content: [{ type: 'input_text', text: `${prompt}\n\nContext JSON:\n${JSON.stringify(context).slice(0, 120000)}` }] },
    ],
  };
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`OpenAI failed: ${res.status}`);
  const data = await res.json();
  const text = data.output_text || 'No response text returned.';
  return { mode: 'openai', text };
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let filePath = normalize(decodeURIComponent(url.pathname));
  if (filePath === '/') filePath = '/index.html';
  const target = resolve(APP_DIR, '.' + filePath);
  if (!target.startsWith(APP_DIR)) return text(res, 403, 'Forbidden');
  const ext = extname(target).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stream = createReadStream(target);
  stream.on('error', () => text(res, 404, 'Not found'));
  res.writeHead(200, { 'Content-Type': type });
  stream.pipe(res);
}

await ensureDataLayout();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, port: DEFAULT_PORT, now: new Date().toISOString() });
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, await readJson(CONFIG_PATH, DEFAULT_CONFIG));
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await getBody(req);
      const next = { ...DEFAULT_CONFIG, ...body };
      await writeJson(CONFIG_PATH, next);
      return json(res, 200, { ok: true, config: next });
    }

    if (req.method === 'GET' && url.pathname === '/api/watchlists') {
      return json(res, 200, await readJson(WATCHLIST_PATH, []));
    }

    if (req.method === 'POST' && url.pathname === '/api/watchlists') {
      const body = await getBody(req);
      await writeJson(WATCHLIST_PATH, Array.isArray(body) ? body : []);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/snapshots') {
      return json(res, 200, await listSnapshots());
    }

    if (req.method === 'POST' && url.pathname === '/api/snapshot') {
      return json(res, 200, await saveSnapshot(await getBody(req)));
    }

    if (req.method === 'GET' && url.pathname === '/api/weather/point') {
      const lat = toNum(url.searchParams.get('lat'));
      const lon = toNum(url.searchParams.get('lon'));
      return json(res, 200, await loadWeatherPoint(lat, lon));
    }

    if (req.method === 'POST' && url.pathname === '/api/layers/query') {
      const body = await getBody(req);
      const bbox = body.bbox || null;
      const layers = body.layers || {};
      const config = await readJson(CONFIG_PATH, DEFAULT_CONFIG);
      const bundle = {};

      if (layers.earthquakes) bundle.earthquakes = await loadEarthquakes(bbox);
      if (layers.naturalEvents) bundle.naturalEvents = await loadNaturalEvents();
      if (layers.flights) bundle.flights = await loadFlights(bbox, config);
      if (bbox && (layers.trainStations || layers.busStops || layers.trainLines)) {
        const transit = await loadTransitStatic(bbox);
        if (layers.trainStations) bundle.trainStations = transit.stations;
        if (layers.busStops) bundle.busStops = transit.busStops;
        if (layers.trainLines) bundle.trainLines = transit.lines;
      }
      if (layers.transitVehicles && Array.isArray(config.transitFeeds)) {
        const all = [];
        for (const feed of config.transitFeeds) {
          try {
            const rows = await loadJsonFeed(feed.url);
            all.push(...rows.map((r) => ({ ...r, feedName: feed.name || 'Transit Feed' })));
          } catch {}
        }
        bundle.transitVehicles = all;
      }
      if (layers.trafficIncidents && config.trafficIncidentsUrl) bundle.trafficIncidents = await loadJsonFeed(config.trafficIncidentsUrl);
      if (layers.cameras && config.camerasUrl) bundle.cameras = await loadJsonFeed(config.camerasUrl);
      if (layers.custom && config.customGeoJsonUrl) bundle.custom = await loadJsonFeed(config.customGeoJsonUrl);
      if (layers.ais && config.aisFeedUrl) bundle.ais = await loadJsonFeed(config.aisFeedUrl);

      return json(res, 200, bundle);
    }

    if (req.method === 'POST' && url.pathname === '/api/analyst') {
      const body = await getBody(req);
      const config = await readJson(CONFIG_PATH, DEFAULT_CONFIG);
      const result = await analystSummary(body.prompt || 'Summarize the situation.', body.context || {}, config);
      return json(res, 200, result);
    }

    return serveStatic(req, res);
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.message || error) });
  }
});

server.listen(DEFAULT_PORT, () => {
  console.log(`Worldview MVP listening on http://localhost:${DEFAULT_PORT}`);
});
