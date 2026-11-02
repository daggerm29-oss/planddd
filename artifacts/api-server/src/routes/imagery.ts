import { Router, type IRouter, type Request, type Response } from "express";
import zlib from "node:zlib";
import { fromUrl } from "geotiff";
import proj4 from "proj4";
import jpeg from "jpeg-js";
import { geminiChat } from "./ai";

/**
 * Satellite imagery on demand + NASA FIRMS thermal hotspots.
 *
 *  - NASA GIBS WMS (keyless)              daily VIIRS / MODIS true colour (250-375 m), HLS Landsat/Sentinel (30 m), VIIRS night lights.
 *  - Sentinel-2 L2A via Earth Search STAC (keyless)  10 m true colour, read straight from the public AWS COGs (TCI.tif).
 *  - Sentinel Hub (optional)              SENTINEL_HUB_CLIENT_ID / SENTINEL_HUB_CLIENT_SECRET (Copernicus Data Space OAuth client),
 *                                         least-cloud 10 m mosaic over a date window.
 *  - Gemini Vision (GEMINI_KEY)           compares two dates and returns located changes.
 *  - NASA FIRMS public CSVs (keyless)     VIIRS NOAA-20 / NOAA-21 / S-NPP + MODIS active fires, persistent cells = likely industrial.
 */

const router: IRouter = Router();

type BBox = [number, number, number, number]; // west, south, east, north

function parseBBox(raw: unknown): BBox | null {
  if (typeof raw !== "string") return null;
  const v = raw.split(",").map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n))) return null;
  const [w, s, e, n] = v;
  if (w >= e || s >= n || s < -85 || n > 85 || w < -180 || e > 180) return null;
  return [w, s, e, n];
}

const isDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

/** Output pixel size preserving ground aspect (equirectangular output, ok for boxes up to a few degrees). */
function outputSize(b: BBox, maxSide: number) {
  const latC = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  const gw = (b[2] - b[0]) * Math.cos(latC);
  const gh = b[3] - b[1];
  const ratio = gw / gh;
  return ratio >= 1
    ? { w: maxSide, h: Math.max(64, Math.round(maxSide / ratio)) }
    : { w: Math.max(64, Math.round(maxSide * ratio)), h: maxSide };
}

// ─── sources ─────────────────────────────────────────────────────────────────

interface SourceDef {
  id: string;
  label: string;
  provider: "gibs" | "s2" | "sh";
  resolutionM: number;
  maxSpanDeg: number;
  gibsLayer?: string;
  note: string;
}

const SOURCES: SourceDef[] = [
  { id: "s2", label: "Sentinel-2 L2A · 10 m", provider: "s2", resolutionM: 10, maxSpanDeg: 1.2, note: "ESA Copernicus via AWS Earth Search (keyless). Revisit ~5 days." },
  { id: "sh", label: "Sentinel Hub · S2 least-cloud 10 m", provider: "sh", resolutionM: 10, maxSpanDeg: 2.5, note: "Copernicus Data Space. Needs SENTINEL_HUB_CLIENT_ID/SECRET." },
  { id: "hls-s30", label: "HLS Sentinel-2 · 30 m", provider: "gibs", resolutionM: 30, maxSpanDeg: 4, gibsLayer: "HLS_S30_Nadir_BRDF_Adjusted_Reflectance", note: "NASA GIBS (keyless). Gaps on days without a pass." },
  { id: "hls-l30", label: "HLS Landsat 8/9 · 30 m", provider: "gibs", resolutionM: 30, maxSpanDeg: 4, gibsLayer: "HLS_L30_Nadir_BRDF_Adjusted_Reflectance", note: "NASA GIBS (keyless). ~8 day revisit." },
  { id: "viirs-n20", label: "VIIRS NOAA-20 · 375 m daily", provider: "gibs", resolutionM: 375, maxSpanDeg: 40, gibsLayer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor", note: "NASA GIBS (keyless). Global every day." },
  { id: "viirs-snpp", label: "VIIRS S-NPP · 375 m daily", provider: "gibs", resolutionM: 375, maxSpanDeg: 40, gibsLayer: "VIIRS_SNPP_CorrectedReflectance_TrueColor", note: "NASA GIBS (keyless). Global every day." },
  { id: "modis-terra", label: "MODIS Terra · 250 m daily", provider: "gibs", resolutionM: 250, maxSpanDeg: 40, gibsLayer: "MODIS_Terra_CorrectedReflectance_TrueColor", note: "NASA GIBS (keyless). Morning pass." },
  { id: "viirs-night", label: "VIIRS night lights · 750 m", provider: "gibs", resolutionM: 750, maxSpanDeg: 40, gibsLayer: "VIIRS_SNPP_DayNightBand_ENCC", note: "NASA GIBS (keyless). Night-time lights, flares, outages." },
];

const shConfigured = () => !!(process.env.SENTINEL_HUB_CLIENT_ID && process.env.SENTINEL_HUB_CLIENT_SECRET);

router.get("/imagery/sources", (_req, res) => {
  res.json({
    sources: SOURCES.map((s) => ({ ...s, available: s.provider !== "sh" || shConfigured() })),
    gemini: !!(process.env.GEMINI_API || process.env.GEMINI_KEY || process.env.GEMINI_API_KEY),
  });
});

// ─── image cache ─────────────────────────────────────────────────────────────

const imgCache = new Map<string, { buf: Buffer; meta: Record<string, string> }>();
const imgInflight = new Map<string, Promise<{ buf: Buffer; meta: Record<string, string> }>>();
const IMG_CACHE_MAX = 80;

async function cachedImage(key: string, make: () => Promise<{ buf: Buffer; meta: Record<string, string> }>) {
  const hit = imgCache.get(key);
  if (hit) {
    imgCache.delete(key);
    imgCache.set(key, hit);
    return hit;
  }
  let p = imgInflight.get(key);
  if (!p) {
    p = make().finally(() => imgInflight.delete(key));
    imgInflight.set(key, p);
  }
  const out = await p;
  imgCache.set(key, out);
  while (imgCache.size > IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value!);
  return out;
}

class ImgError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ─── GIBS ────────────────────────────────────────────────────────────────────

async function renderGibs(src: SourceDef, b: BBox, date: string, maxSide: number) {
  const { w, h } = outputSize(b, maxSide);
  const url =
    "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0" +
    `&LAYERS=${src.gibsLayer}&STYLES=&CRS=EPSG:4326&BBOX=${b[1]},${b[0]},${b[3]},${b[2]}` +
    `&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/jpeg&TIME=${date}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const type = r.headers.get("content-type") ?? "";
  if (!r.ok || !type.startsWith("image/")) throw new ImgError(502, `GIBS ${r.status}`);
  return { buf: Buffer.from(await r.arrayBuffer()), meta: { source: src.id, date, provider: "NASA GIBS" } };
}

// ─── Sentinel-2 COG (Earth Search) ───────────────────────────────────────────

const STAC = "https://earth-search.aws.element84.com/v1/search";

interface StacItem {
  id: string;
  bbox: BBox;
  properties: { datetime: string; "eo:cloud_cover"?: number; "proj:epsg"?: number; "proj:code"?: string };
  assets: { visual?: { href: string }; thumbnail?: { href: string } };
}

async function stacSearch(b: BBox, from: string, to: string, limit = 100): Promise<StacItem[]> {
  const r = await fetch(STAC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      collections: ["sentinel-2-l2a"],
      bbox: b,
      datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
      limit,
      sortby: [{ field: "properties.datetime", direction: "desc" }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new ImgError(502, `Earth Search ${r.status}`);
  const j = (await r.json()) as { features: StacItem[] };
  return j.features ?? [];
}

function overlapFrac(b: BBox, ib: BBox) {
  const w = Math.max(0, Math.min(b[2], ib[2]) - Math.max(b[0], ib[0]));
  const h = Math.max(0, Math.min(b[3], ib[3]) - Math.max(b[1], ib[1]));
  return (w * h) / ((b[2] - b[0]) * (b[3] - b[1]));
}

const passCache = new Map<string, { at: number; data: unknown }>();

router.get("/imagery/passes", async (req: Request, res: Response) => {
  const b = parseBBox(req.query.bbox);
  if (!b) return void res.status(400).json({ error: "bbox=w,s,e,n required" });
  const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
  const key = `${b.map((v) => v.toFixed(3)).join(",")}|${days}`;
  const hit = passCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return void res.json(hit.data);
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const items = await stacSearch(b, from, to, 200);
    const byDate = new Map<string, { date: string; cloud: number[]; coverage: number; scenes: number; thumb?: string; time: string }>();
    for (const it of items) {
      const date = it.properties.datetime.slice(0, 10);
      const e = byDate.get(date) ?? { date, cloud: [], coverage: 0, scenes: 0, time: it.properties.datetime };
      e.cloud.push(it.properties["eo:cloud_cover"] ?? 0);
      e.coverage = Math.min(1, e.coverage + overlapFrac(b, it.bbox));
      e.scenes++;
      e.thumb ??= it.assets.thumbnail?.href;
      byDate.set(date, e);
    }
    const passes = [...byDate.values()].map((p) => ({
      date: p.date,
      time: p.time,
      cloud: Math.round(p.cloud.reduce((a, c) => a + c, 0) / p.cloud.length),
      coverage: Math.round(p.coverage * 100),
      scenes: p.scenes,
      thumb: p.thumb,
    }));
    const data = { passes, from, to };
    passCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    const err = e as ImgError;
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

const utmDef = (epsg: number) => {
  const south = epsg >= 32701 && epsg <= 32760;
  const zone = epsg - (south ? 32700 : 32600);
  return `+proj=utm +zone=${zone}${south ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
};

function itemEpsg(it: StacItem) {
  return it.properties["proj:epsg"] ?? Number(String(it.properties["proj:code"] ?? "").replace("EPSG:", ""));
}

/** Reads the TCI COG of each scene for the bbox (UTM window, auto-overview) and resamples onto a lon/lat grid. */
async function renderSentinel2(b: BBox, date: string, maxSide: number) {
  const items = (await stacSearch(b, date, date, 20)).filter((i) => i.assets.visual?.href && itemEpsg(i));
  if (!items.length) throw new ImgError(404, `No Sentinel-2 pass on ${date} for this area`);
  items.sort((a, c) => overlapFrac(b, c.bbox) - overlapFrac(b, a.bbox) || (a.properties["eo:cloud_cover"] ?? 0) - (c.properties["eo:cloud_cover"] ?? 0));

  const { w, h } = outputSize(b, maxSide);
  const out = new Uint8Array(w * h * 4);
  const filled = new Uint8Array(w * h);
  let remaining = w * h;
  const G = 24; // coarse grid for lon/lat -> UTM interpolation

  for (const it of items.slice(0, 4)) {
    if (!remaining) break;
    const fwd = proj4("EPSG:4326", utmDef(itemEpsg(it))).forward;
    const grid: [number, number][] = [];
    for (let gy = 0; gy <= G; gy++)
      for (let gx = 0; gx <= G; gx++) {
        const lon = b[0] + ((b[2] - b[0]) * gx) / G;
        const lat = b[3] - ((b[3] - b[1]) * gy) / G;
        grid.push(fwd([lon, lat]) as [number, number]);
      }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of grid) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const rw = Math.round(w * 1.15), rh = Math.round(h * 1.15);
    const tiff = await fromUrl(it.assets.visual!.href, { allowFullFile: false });
    const raster = (await tiff.readRasters({ bbox: [minX, minY, maxX, maxY], width: rw, height: rh, interleave: true, fillValue: 0, resampleMethod: "bilinear" })) as unknown as Uint8Array;
    const bands = raster.length / (rw * rh);

    for (let py = 0; py < h; py++) {
      const fy = (py / (h - 1)) * G;
      const gy = Math.min(G - 1, Math.floor(fy)), ty = fy - gy;
      for (let px = 0; px < w; px++) {
        const o = py * w + px;
        if (filled[o]) continue;
        const fx = (px / (w - 1)) * G;
        const gx = Math.min(G - 1, Math.floor(fx)), tx = fx - gx;
        const p00 = grid[gy * (G + 1) + gx], p10 = grid[gy * (G + 1) + gx + 1];
        const p01 = grid[(gy + 1) * (G + 1) + gx], p11 = grid[(gy + 1) * (G + 1) + gx + 1];
        const x = (p00[0] * (1 - tx) + p10[0] * tx) * (1 - ty) + (p01[0] * (1 - tx) + p11[0] * tx) * ty;
        const y = (p00[1] * (1 - tx) + p10[1] * tx) * (1 - ty) + (p01[1] * (1 - tx) + p11[1] * tx) * ty;
        const sx = Math.round(((x - minX) / (maxX - minX)) * (rw - 1));
        const sy = Math.round(((maxY - y) / (maxY - minY)) * (rh - 1));
        if (sx < 0 || sy < 0 || sx >= rw || sy >= rh) continue;
        const i = (sy * rw + sx) * bands;
        const r = raster[i], g = raster[i + 1], bl = raster[i + 2];
        if (r === 0 && g === 0 && bl === 0) continue;
        out[o * 4] = r; out[o * 4 + 1] = g; out[o * 4 + 2] = bl; out[o * 4 + 3] = 255;
        filled[o] = 1;
        remaining--;
      }
    }
  }
  if (remaining === w * h) throw new ImgError(404, `Sentinel-2 scene on ${date} has no data over this box`);
  const buf = Buffer.from(jpeg.encode({ data: out, width: w, height: h }, 86).data);
  const lead = items[0];
  return {
    buf,
    meta: {
      source: "s2",
      date,
      provider: "ESA Sentinel-2 L2A (Earth Search)",
      scene: lead.id,
      time: lead.properties.datetime,
      cloud: String(Math.round(lead.properties["eo:cloud_cover"] ?? 0)),
      coverage: String(Math.round((1 - remaining / (w * h)) * 100)),
    },
  };
}

// ─── Sentinel Hub (optional) ─────────────────────────────────────────────────

let shToken: { token: string; exp: number } | null = null;

async function sentinelHubToken() {
  if (shToken && shToken.exp > Date.now() + 30_000) return shToken.token;
  const r = await fetch("https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SENTINEL_HUB_CLIENT_ID!,
      client_secret: process.env.SENTINEL_HUB_CLIENT_SECRET!,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new ImgError(502, `Sentinel Hub auth ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  shToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return shToken.token;
}

const SH_EVALSCRIPT = `//VERSION=3
function setup(){return{input:["B02","B03","B04","dataMask"],output:{bands:3}}}
function evaluatePixel(s){const g=2.6;return[g*s.B04,g*s.B03,g*s.B02].map(v=>Math.min(1,Math.pow(v,0.9)))}`;

async function renderSentinelHub(b: BBox, date: string, maxSide: number) {
  if (!shConfigured()) throw new ImgError(503, "Set SENTINEL_HUB_CLIENT_ID and SENTINEL_HUB_CLIENT_SECRET to use Sentinel Hub.");
  const { w, h } = outputSize(b, maxSide);
  const from = new Date(new Date(date).getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
  const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/process", {
    method: "POST",
    headers: { authorization: `Bearer ${await sentinelHubToken()}`, "content-type": "application/json", accept: "image/jpeg" },
    body: JSON.stringify({
      input: {
        bounds: { bbox: b, properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" } },
        data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from: `${from}T00:00:00Z`, to: `${date}T23:59:59Z` }, mosaickingOrder: "leastCC" } }],
      },
      output: { width: w, height: h, responses: [{ identifier: "default", format: { type: "image/jpeg" } }] },
      evalscript: SH_EVALSCRIPT,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new ImgError(502, `Sentinel Hub ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return { buf: Buffer.from(await r.arrayBuffer()), meta: { source: "sh", date, provider: `Sentinel Hub least-cloud ${from}..${date}` } };
}

async function renderImage(srcId: string, b: BBox, date: string, maxSide: number) {
  const src = SOURCES.find((s) => s.id === srcId);
  if (!src) throw new ImgError(400, "unknown source");
  const span = Math.max(b[2] - b[0], b[3] - b[1]);
  if (span > src.maxSpanDeg) throw new ImgError(400, `Box too large for ${src.label} (max ${src.maxSpanDeg}° side). Draw a smaller box or pick a coarser source.`);
  const key = `${srcId}|${b.map((v) => v.toFixed(4)).join(",")}|${date}|${maxSide}`;
  return cachedImage(key, () =>
    src.provider === "gibs" ? renderGibs(src, b, date, maxSide) : src.provider === "s2" ? renderSentinel2(b, date, maxSide) : renderSentinelHub(b, date, maxSide),
  );
}

router.get("/imagery/image", async (req: Request, res: Response) => {
  const b = parseBBox(req.query.bbox);
  const date = req.query.date;
  if (!b || !isDate(date)) return void res.status(400).json({ error: "bbox=w,s,e,n and date=YYYY-MM-DD required" });
  const size = Math.min(1280, Math.max(256, Number(req.query.size) || 1024));
  try {
    const out = await renderImage(String(req.query.src ?? "s2"), b, date, size);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("X-Imagery-Meta", encodeURIComponent(JSON.stringify(out.meta)));
    res.setHeader("Access-Control-Expose-Headers", "X-Imagery-Meta");
    res.end(out.buf);
  } catch (e) {
    const err = e as ImgError;
    res.status(err.status ?? 502).json({ error: err.message ?? "imagery failed" });
  }
});

// ─── Gemini Vision change detection ──────────────────────────────────────────

const COMPARE_SYSTEM = `You are a satellite imagery analyst (GEOINT). You get two co-registered satellite images of the SAME area:
IMAGE A (earlier) and IMAGE B (later). North is up. Identify real physical changes between A and B:
new / removed structures, construction, earthworks, roads, vehicles or vessels concentrations, burn scars, flooding,
vegetation clearing, damage, aircraft on aprons, etc. Ignore differences caused only by clouds, haze, shadows,
sun angle, seasonal colour or sensor/colour balance — but mention clouds in caveats when they hide the area.
Respond ONLY with compact JSON:
{"summary":"2-3 sentence plain-English assessment","changes":[{"label":"short title","type":"construction|demolition|vehicles|vessels|aircraft|fire|flood|vegetation|earthworks|infrastructure|other","detail":"one sentence","confidence":0.0-1.0,"box_2d":[ymin,xmin,ymax,xmax]}],"caveats":"clouds / resolution limits"}
box_2d uses 0-1000 normalised coordinates on IMAGE B. Max 8 changes, most significant first. Empty array if no real change.`;

router.post("/imagery/compare", async (req: Request, res: Response) => {
  const { bbox, a, b: later, focus } = (req.body ?? {}) as { bbox?: string; a?: { src: string; date: string }; b?: { src: string; date: string }; focus?: string };
  const box = parseBBox(bbox);
  if (!box || !a || !later || !isDate(a.date) || !isDate(later.date)) return void res.status(400).json({ error: "bbox, a{src,date}, b{src,date} required" });
  try {
    const [ia, ib] = await Promise.all([renderImage(a.src, box, a.date, 1024), renderImage(later.src, box, later.date, 1024)]);
    const latC = (box[1] + box[3]) / 2, lonC = (box[0] + box[2]) / 2;
    const out = await geminiChat({
      provider: "gemini",
      system: COMPARE_SYSTEM,
      tools: [],
      messages: [
        { role: "user", text: `IMAGE A — ${ia.meta.provider}, ${a.date}.`, images: [`data:image/jpeg;base64,${ia.buf.toString("base64")}`] },
        {
          role: "user",
          text:
            `IMAGE B — ${ib.meta.provider}, ${later.date}. Area centre ${latC.toFixed(4)}, ${lonC.toFixed(4)}; ` +
            `box ${(box[2] - box[0]).toFixed(3)}° x ${(box[3] - box[1]).toFixed(3)}°.` +
            (focus ? ` Analyst focus: ${String(focus).slice(0, 300)}` : "") +
            " Describe the changes from A to B.",
          images: [`data:image/jpeg;base64,${ib.buf.toString("base64")}`],
        },
      ],
    });
    const raw = out.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    let parsed: { summary?: string; caveats?: string; changes?: { label?: string; type?: string; detail?: string; confidence?: number; box_2d?: number[] }[] } = {};
    try {
      parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    } catch {
      parsed = { summary: raw, changes: [] };
    }
    const toLon = (x: number) => box[0] + ((box[2] - box[0]) * x) / 1000;
    const toLat = (y: number) => box[3] - ((box[3] - box[1]) * y) / 1000;
    const changes = (parsed.changes ?? [])
      .filter((c) => Array.isArray(c.box_2d) && c.box_2d.length === 4)
      .slice(0, 8)
      .map((c, i) => {
        const [y0, x0, y1, x1] = c.box_2d!.map((v) => Math.max(0, Math.min(1000, Number(v))));
        return {
          id: `chg-${i}`,
          label: String(c.label ?? "Change"),
          type: String(c.type ?? "other"),
          detail: String(c.detail ?? ""),
          confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0.5)),
          bbox: [toLon(Math.min(x0, x1)), toLat(Math.max(y0, y1)), toLon(Math.max(x0, x1)), toLat(Math.min(y0, y1))] as BBox,
        };
      });
    res.json({ summary: parsed.summary ?? "", caveats: parsed.caveats ?? "", changes, model: out.model, a: ia.meta, b: ib.meta, at: Date.now() });
  } catch (e) {
    const err = e as { status?: number; message?: string; retryAfterSec?: number };
    if (err.retryAfterSec) res.setHeader("Retry-After", String(err.retryAfterSec));
    res.status(err.status ?? 502).json({ error: err.message ?? "compare failed", retryAfterSec: err.retryAfterSec });
  }
});

// ─── NASA FIRMS ──────────────────────────────────────────────────────────────

const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire";
const FIRMS_FILES: Record<string, { path: string; sat: string }> = {
  n20: { path: "noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global", sat: "NOAA-20 VIIRS" },
  n21: { path: "noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global", sat: "NOAA-21 VIIRS" },
  snpp: { path: "suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global", sat: "S-NPP VIIRS" },
  modis: { path: "modis-c6.1/csv/MODIS_C6_1_Global", sat: "MODIS Terra/Aqua" },
};
const FIRMS_TTL = 60 * 60_000;
const PERSIST_TTL = 6 * 60 * 60_000;

/** Compact row: lat, lon, frp MW, confidence 0-2 (low/nominal/high), unix min, sat idx, day 1 / night 0. */
type Hot = [number, number, number, number, number, number, number];

function parseFirms(csv: string, satIdx: number, out: Hot[]) {
  const lines = csv.split("\n");
  const head = lines[0].split(",");
  const iLat = head.indexOf("latitude"), iLon = head.indexOf("longitude"), iFrp = head.indexOf("frp");
  const iConf = head.indexOf("confidence"), iDate = head.indexOf("acq_date"), iTime = head.indexOf("acq_time"), iDn = head.indexOf("daynight");
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(",");
    if (c.length < head.length) continue;
    const rawConf = c[iConf];
    const conf = /^\d+$/.test(rawConf) ? (Number(rawConf) >= 80 ? 2 : Number(rawConf) >= 30 ? 1 : 0) : rawConf[0] === "h" ? 2 : rawConf[0] === "n" ? 1 : 0;
    if (conf === 0) continue;
    const t = c[iTime].padStart(4, "0");
    const ms = Date.parse(`${c[iDate]}T${t.slice(0, 2)}:${t.slice(2)}:00Z`);
    out.push([Math.round(Number(c[iLat]) * 1e4) / 1e4, Math.round(Number(c[iLon]) * 1e4) / 1e4, Math.round(Number(c[iFrp]) * 10) / 10, conf, Math.round(ms / 60_000), satIdx, c[iDn] === "D" ? 1 : 0]);
  }
}

async function fetchCsv(path: string, range: string) {
  const r = await fetch(`${FIRMS_BASE}/${path}_${range}.csv`, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`FIRMS ${r.status}`);
  return r.text();
}

/** Cells (~1.1 km) seen hot on >= 4 distinct days in the last 7 days: gas flares, refineries, steel plants, volcanoes. */
let persist: { at: number; cells: Set<string> } | null = null;
let persistLoading: Promise<void> | null = null;
const cellKey = (lat: number, lon: number) => `${Math.round(lat * 90)}:${Math.round(lon * 90)}`;

function refreshPersistent() {
  if (persistLoading || (persist && Date.now() - persist.at < PERSIST_TTL)) return persistLoading;
  persistLoading = (async () => {
    const days = new Map<string, Set<string>>();
    const csv = await fetchCsv(FIRMS_FILES.n20.path, "7d");
    const lines = csv.split("\n");
    const head = lines[0].split(",");
    const iLat = head.indexOf("latitude"), iLon = head.indexOf("longitude"), iDate = head.indexOf("acq_date");
    for (let k = 1; k < lines.length; k++) {
      const c = lines[k].split(",");
      if (c.length < head.length) continue;
      const key = cellKey(Number(c[iLat]), Number(c[iLon]));
      let s = days.get(key);
      if (!s) { s = new Set(); days.set(key, s); }
      s.add(c[iDate]);
    }
    const cells = new Set<string>();
    for (const [k, s] of days) if (s.size >= 4) cells.add(k);
    persist = { at: Date.now(), cells };
  })()
    .catch(() => undefined)
    .finally(() => { persistLoading = null; });
  return persistLoading;
}

interface FirmsPayload { gz: Buffer; json: string; count: number; at: number }
const firmsCache = new Map<string, FirmsPayload>();
const firmsInflight = new Map<string, Promise<FirmsPayload>>();

async function buildFirms(range: "24h" | "48h"): Promise<FirmsPayload> {
  await Promise.race([refreshPersistent(), new Promise((r) => setTimeout(r, 25_000))]);
  const sats = ["n20", "n21", "snpp", "modis"] as const;
  const rows: Hot[] = [];
  const results = await Promise.allSettled(sats.map((s) => fetchCsv(FIRMS_FILES[s].path, range)));
  results.forEach((r, i) => { if (r.status === "fulfilled") parseFirms(r.value, i, rows); });
  if (!rows.length) throw new Error("FIRMS unavailable");
  const cells = persist?.cells;
  const persistent = rows.map((h) => (cells?.has(cellKey(h[0], h[1])) ? 1 : 0));
  const body = {
    range,
    at: Date.now(),
    sats: sats.map((s) => FIRMS_FILES[s].sat),
    fields: ["lat", "lon", "frp", "conf", "tmin", "sat", "day", "persistent"],
    rows: rows.map((h, i) => [...h, persistent[i]]),
    persistentReady: !!cells,
  };
  const json = JSON.stringify(body);
  return { json, gz: zlib.gzipSync(json, { level: 6 }), count: rows.length, at: body.at };
}

router.get("/firms", async (req: Request, res: Response) => {
  const range = req.query.range === "48h" ? "48h" : "24h";
  let hit = firmsCache.get(range);
  const stale = !hit || Date.now() - hit.at > FIRMS_TTL;
  if (stale && !firmsInflight.has(range)) {
    const p = buildFirms(range)
      .then((v) => { firmsCache.set(range, v); return v; })
      .finally(() => firmsInflight.delete(range));
    firmsInflight.set(range, p);
  }
  try {
    if (!hit) hit = await firmsInflight.get(range)!;
  } catch (e) {
    return void res.status(502).json({ error: (e as Error).message });
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=600");
  if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    res.setHeader("Content-Encoding", "gzip");
    res.end(hit.gz);
  } else res.end(hit.json);
});

export default router;
