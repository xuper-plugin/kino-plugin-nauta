/// <reference path="./kino.d.ts" />

const BASE       = "https://stremio-addon-wheat.vercel.app";
const CACHE_TTL  = 6 * 60 * 60 * 1000; // 6 h
const PAGE_SIZE  = 100;

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
// Data layer — lazy per-category fetch with storage cache
// ---------------------------------------------------------------------------

async function fetchCat(catId) {
  const key = "ch:" + catId;
  const raw = kino.storage.get(key);
  if (raw) {
    try { return JSON.parse(raw); } catch (_) { /* stale */ }
  }
  kino.log("[nauta] fetch", catId);
  const r = await kino.fetch(BASE + "/catalog/tv/" + catId + ".json");
  if (!r.ok) throw kino.error("unavailable", catId + " → HTTP " + r.status);
  const list = (r.json().metas || []).map(m => ({
    id:    m.id.replace("magmatv_", ""),
    title: m.name,
    logo:  m.poster || null,
  }));
  kino.storage.set(key, JSON.stringify(list), { ttlMs: CACHE_TTL });
  return list;
}

// ---------------------------------------------------------------------------
// Channel builder and search helper
// ---------------------------------------------------------------------------

function toChannel(ch, categoryId) {
  return { id: ch.id, title: ch.title, logo: ch.logo || undefined, categoryId, ref: ch.id };
}

// Two-pass search: word-overlap filter → substring fallback (for abbreviations).
async function doSearch(q) {
  const key = "idx";
  const raw = kino.storage.get(key);
  let idx;
  if (raw) {
    try { idx = JSON.parse(raw); } catch (_) { /* rebuild */ }
  }
  if (!idx) {
    kino.log("[nauta] building search index");
    const batches = await Promise.all(
      CATS.map(c =>
        fetchCat(c.catId)
          .then(chs => chs.map(ch => ({ ...ch, catId: c.id })))
          .catch(() => [])
      )
    );
    const seen = new Set();
    idx = [];
    for (const batch of batches)
      for (const ch of batch)
        if (!seen.has(ch.id)) { seen.add(ch.id); idx.push(ch); }
    kino.storage.set(key, JSON.stringify(idx), { ttlMs: CACHE_TTL });
  }
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
  const off  = cursor ? parseInt(cursor, 10) : 0;
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
// home capability — required with channels; returns empty so nothing appears
// on the Home screen (all content lives in the En vivo tab)
// ---------------------------------------------------------------------------

export async function home() {
  return [];
}

// ---------------------------------------------------------------------------
// resolve — get the live stream URL
// ---------------------------------------------------------------------------

export async function resolve(ref) {
  const r = await kino.fetch(BASE + "/stream/tv/magmatv_" + ref + ".json");
  if (!r.ok) throw kino.error("unavailable", "stream " + ref + " → HTTP " + r.status);
  const streams = (r.json().streams || []).filter(s => s.url);
  if (!streams.length) throw kino.error("not_found", "no playable stream for " + ref);
  const [main, ...rest] = streams;
  return {
    url:          main.url,
    mime:         "application/vnd.apple.mpegurl",
    label:        main.title || undefined,
    alternatives: rest.map(s => ({
      url:   s.url,
      mime:  "application/vnd.apple.mpegurl",
      label: s.title || undefined,
    })),
  };
}

// ---------------------------------------------------------------------------
// settings form (apiVersion 6) — cache status + refresh action
// ---------------------------------------------------------------------------

export async function settingsStatus() {
  const keys    = kino.storage.keys();
  const catKeys = keys.filter(k => k.startsWith("ch:"));
  const hasIdx  = keys.includes("idx");
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
    for (const k of kino.storage.keys()) kino.storage.remove(k);
    return { message: "Caché borrada. Los canales se actualizarán al abrirlos." };
  }
}
