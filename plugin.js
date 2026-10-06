/// <reference path="./kino.d.ts" />

const BASE       = "https://stremio-addon-wheat.vercel.app";
const CACHE_TTL  = 6 * 60 * 60 * 1000; // 6 h: refetch after this, but keep serving the old copy if the refetch fails
const PAGE_SIZE  = 100;
const CACHE_V    = "v2:";              // bumped when the cached shape changes (v2: full addon ids)
const HOME_CATS  = ["mas-vistos", "nacionales", "hd"]; // the Home row: the first of these that answers
const FETCH_TIMEOUT_MS = 10000;        // per attempt; two attempts still fit inside a call's own deadline
const RETRY_DELAY_MS   = 700;

// ---------------------------------------------------------------------------
// Network — one retry for what is usually passing (a dropped connection, a
// cold Vercel function, 429/5xx), never for an answer that will not change
// ---------------------------------------------------------------------------

function retriable(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function getJson(url, what) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await kino.sleep(RETRY_DELAY_MS);
    let r;
    try {
      r = await kino.fetch(url, { timeoutMs: FETCH_TIMEOUT_MS });
    } catch (e) {
      last = e;                                      // network error or timeout: try once more
      continue;
    }
    if (r.ok) {
      try {
        return r.json();
      } catch (_) {
        last = kino.error("unavailable", what + " -> not JSON");
        continue;                                    // a truncated body from a cold start
      }
    }
    if (r.status === 404) throw kino.error("not_found", what + " -> HTTP 404");
    last = kino.error("unavailable", what + " -> HTTP " + r.status);
    if (!retriable(r.status)) break;
  }
  throw last;
}

function isHttpUrl(u) {
  return typeof u === "string" && /^https?:\/\/[^\s/]+/i.test(u);
}

// ---------------------------------------------------------------------------
// Category map: Kino id → Stremio catalog id + display metadata
// ---------------------------------------------------------------------------

const CATS = [
  { id: "mas-vistos",      label: "Más vistos",     catId: "cat_200", genre: "entretenimiento", country: "AR" },
  { id: "nacionales",      label: "Nacionales",     catId: "cat_11",  genre: "entretenimiento", country: "AR" },
  { id: "hd",              label: "HD",             catId: "cat_32",  genre: "entretenimiento" },
  { id: "cine-247",        label: "Cine 24/7",      catId: "cat_10",  genre: "peliculas" },
  { id: "247",             label: "24/7",           catId: "cat_9",   genre: "entretenimiento" },
  { id: "entretenimiento", label: "Entretenimiento",catId: "cat_1",   genre: "entretenimiento" },
  { id: "deportes",        label: "Deportes",       catId: "cat_4",   genre: "deportes" },
  { id: "peliculas",       label: "Películas",      catId: "cat_3",   genre: "peliculas" },
  { id: "infantiles",      label: "Infantiles",     catId: "cat_2",   genre: "infantil" },
  { id: "musica",          label: "Música",         catId: "cat_7",   genre: "musica" },
  { id: "cultura",         label: "Cultura",        catId: "cat_5",   genre: "entretenimiento" },
  { id: "noticias",        label: "Noticias",       catId: "cat_6",   genre: "noticias" },
  { id: "espana",          label: "España",         catId: "cat_28",  genre: "entretenimiento", country: "ES" },
  { id: "religion",        label: "Religión",       catId: "cat_29",  genre: "otros" },
  { id: "usa",             label: "USA",            catId: "cat_31",  genre: "entretenimiento", country: "US" },
  { id: "ecuador",         label: "Ecuador",        catId: "cat_23",  genre: "entretenimiento", country: "EC" },
];

const BY_ID   = Object.fromEntries(CATS.map(c => [c.id,    c]));

// ---------------------------------------------------------------------------
// Cache — stored without a TTL and stamped by hand, so an addon outage serves
// the last good copy instead of an empty category
// ---------------------------------------------------------------------------

function readCache(key) {
  const raw = kino.storage.get(CACHE_V + key);
  if (!raw) return null;
  try {
    const { at, data } = JSON.parse(raw);
    return { data, fresh: Date.now() - at < CACHE_TTL };
  } catch (_) {
    return null;
  }
}

function writeCache(key, data) {
  kino.storage.set(CACHE_V + key, JSON.stringify({ at: Date.now(), data }));
}

async function cached(key, load) {
  const hit = readCache(key);
  if (hit && hit.fresh) return hit.data;
  try {
    const data = await load();
    writeCache(key, data);
    return data;
  } catch (e) {
    if (hit) {
      kino.log("[nauta] refresh failed, serving the old copy of", key);
      return hit.data;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Data layer — lazy per-category fetch
// ---------------------------------------------------------------------------

function fetchCat(catId) {
  return cached("ch:" + catId, async () => {
    kino.log("[nauta] fetch", catId);
    const body  = await getJson(BASE + "/catalog/tv/" + catId + ".json", catId);
    const metas = Array.isArray(body && body.metas) ? body.metas : [];
    // The addon's full id is the ref: resolve() sends it back as is, whatever its prefix.
    const seen = new Set();
    const list = [];
    for (const m of metas) {
      if (!m || typeof m.id !== "string" || !m.id || typeof m.name !== "string" || !m.name.trim()) continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      list.push({ id: m.id, title: m.name.trim(), logo: isHttpUrl(m.poster) ? m.poster : null });
    }
    // An empty answer is never cached over a good copy: cached() serves the old one instead.
    if (!list.length && metas.length) throw kino.error("unavailable", catId + " -> no usable channel");
    return list;
  });
}

// ---------------------------------------------------------------------------
// Channel builder and search helper
// ---------------------------------------------------------------------------

function toChannel(ch, categoryId) {
  return { id: ch.id, title: ch.title, logo: ch.logo || undefined, categoryId, ref: ch.id };
}

// Two-pass search: word-overlap filter → substring fallback (for abbreviations).
async function doSearch(q) {
  const idx = await cached("idx", async () => {
    kino.log("[nauta] building search index");
    const batches = await Promise.all(
      CATS.map(c =>
        fetchCat(c.catId)
          .then(chs => chs.map(ch => ({ ...ch, catId: c.id })))
          .catch(() => [])
      )
    );
    const seen = new Set();
    const all  = [];
    for (const batch of batches)
      for (const ch of batch)
        if (!seen.has(ch.id)) { seen.add(ch.id); all.push(ch); }
    if (!all.length) throw kino.error("unavailable", "no category answered");
    return all;
  });
  const ranked = kino.rank.filterRelevant(idx, q, ch => ch.title);
  if (ranked.length > 0) return kino.rank.sortBySimilarity(ranked, q, ch => ch.title);
  const lower = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits  = idx.filter(ch => lower.some(w => ch.title.toLowerCase().includes(w)));
  return kino.rank.sortBySimilarity(hits, q, ch => ch.title);
}

// ---------------------------------------------------------------------------
// channels capability (apiVersion 3)
// ---------------------------------------------------------------------------

export async function liveCategories() {
  const cats = CATS.map(c => {
    const cat = { id: c.id, title: c.label, genre: c.genre };
    if (c.country) cat.country = c.country;
    return cat;
  });
  return [
    ...cats,
    {
      // Its channels live on dozens of hosts: the manifest's "liveStreamHosts": "any" lets them play.
      playlist: {
        url:          "https://m3u.cl/lista/AR.m3u",
        format:       "m3u",
        genre:        "entretenimiento",
        refreshHours: 24,
      },
    },
  ];
}

export async function liveChannels({ categoryId, cursor }) {
  const cat = BY_ID[categoryId];
  if (!cat) return { items: [] };
  const list = await fetchCat(cat.catId);
  const n    = cursor ? parseInt(cursor, 10) : 0;
  const off  = Number.isFinite(n) && n > 0 ? n : 0;
  const page = list.slice(off, off + PAGE_SIZE);
  return {
    items: page.map(ch => toChannel(ch, categoryId)),
    next:  off + PAGE_SIZE < list.length ? String(off + PAGE_SIZE) : undefined,
  };
}

// En vivo tab search
export async function liveSearch({ query }) {
  const q = query.trim();
  if (!q) return { items: [] };
  const sorted = await doSearch(q).catch(() => []);
  return {
    items: sorted.slice(0, 50).map(ch => ({
      id:         ch.id,
      title:      ch.title,
      logo:       ch.logo || undefined,
      ref:        ch.id,
      categoryId: ch.catId,
    })),
  };
}

// ---------------------------------------------------------------------------
// home capability — one row of live channels (apiVersion 6 keeps live items on Home)
// ---------------------------------------------------------------------------

export async function home() {
  let cat  = null;
  let list = [];
  for (const id of HOME_CATS) {
    list = await fetchCat(BY_ID[id].catId).catch(() => []);
    if (list.length) { cat = BY_ID[id]; break; }
  }
  if (!cat) return [];                               // Home simply shows no row; En vivo still works
  return [{
    id:    "en-vivo-" + cat.id,
    title: cat.label + " en vivo",
    items: list.slice(0, 30).map(ch => ({
      id:     ch.id,
      ref:    ch.id,
      title:  ch.title,
      kind:   "live",
      poster: ch.logo || undefined,
    })),
  }];
}

// ---------------------------------------------------------------------------
// resolve — get the live stream URL
// ---------------------------------------------------------------------------

// The type from the URL's path: HLS for .m3u8 (and when unknown, the addon's usual), else left to the player.
function mimeOf(url) {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (path.endsWith(".mpd"))  return "application/dash+xml";
  if (path.endsWith(".ts") || path.endsWith(".mp4") || path.endsWith(".mkv")) return undefined;
  return "application/vnd.apple.mpegurl";
}

// Stremio's behaviorHints.proxyHeaders.request: the User-Agent / Referer a channel only answers to.
function headersOf(s) {
  const req = s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request;
  if (!req || typeof req !== "object") return undefined;
  const out = {};
  for (const [k, v] of Object.entries(req)) if (typeof v === "string" && v) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

function toStream(s) {
  return {
    url:     s.url,
    mime:    mimeOf(s.url),
    label:   s.title || s.name || undefined,
    headers: headersOf(s),
  };
}

const GONE = { userMessage: "Este canal no está disponible en este momento." };

export async function resolve(ref) {
  if (typeof ref !== "string" || !ref) throw kino.error("not_found", "empty ref", GONE);
  const body = await getJson(BASE + "/stream/tv/" + encodeURIComponent(ref) + ".json", "stream " + ref)
    .catch(e => { throw e && e.code === "not_found" ? kino.error("not_found", "stream " + ref + " -> 404", GONE) : e; });
  const seen    = new Set();
  const streams = (Array.isArray(body && body.streams) ? body.streams : [])
    .filter(s => s && isHttpUrl(s.url) && !seen.has(s.url) && seen.add(s.url));
  if (!streams.length) throw kino.error("not_found", "no playable stream for " + ref, GONE);
  const [main, ...rest] = streams;
  return { ...toStream(main), alternatives: rest.slice(0, 9).map(toStream) };
}

// ---------------------------------------------------------------------------
// settings form (apiVersion 6) — cache status + refresh action
// ---------------------------------------------------------------------------

function cacheKeys() {
  return kino.storage.keys().filter(k => k.startsWith(CACHE_V) || k.startsWith("ch:") || k === "idx");
}

export async function settingsStatus() {
  const keys    = cacheKeys();
  const catKeys = keys.filter(k => k.startsWith(CACHE_V + "ch:"));
  const hasIdx  = keys.includes(CACHE_V + "idx");
  let msg;
  if (!catKeys.length && !hasIdx) {
    msg = "Sin caché. Los canales se cargarán al abrirlos.";
  } else {
    msg = catKeys.length + " categoría(s) en caché" +
          (hasIdx ? ", índice de búsqueda listo" : "") + ".";
  }
  return { cacheInfo: msg };
}

export async function action(key) {
  if (key === "refresh") {
    // Only the channel cache (and the pre-v2 keys): anything else the plugin keeps stays.
    for (const k of cacheKeys()) kino.storage.remove(k);
    return { message: "Caché borrada. Los canales se actualizarán al abrirlos." };
  }
}
