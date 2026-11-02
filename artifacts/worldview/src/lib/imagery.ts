import { useCallback, useEffect, useRef, useState } from "react";
import { apiBase } from "./cctv";

export type BBox = [number, number, number, number]; // west, south, east, north

export interface ImagerySource {
  id: string;
  label: string;
  provider: "gibs" | "s2" | "sh";
  resolutionM: number;
  maxSpanDeg: number;
  note: string;
  available: boolean;
}

export interface Pass {
  date: string;
  time: string;
  cloud: number;
  coverage: number;
  scenes: number;
  thumb?: string;
}

export interface ImageMeta {
  source: string;
  date: string;
  provider: string;
  scene?: string;
  time?: string;
  cloud?: string;
  coverage?: string;
}

export interface Shot {
  src: string;
  date: string;
  url: string;
  status: "loading" | "ready" | "error";
  meta?: ImageMeta;
  error?: string;
}

export interface Change {
  id: string;
  label: string;
  type: string;
  detail: string;
  confidence: number;
  bbox: BBox;
}

export interface CompareResult {
  summary: string;
  caveats: string;
  changes: Change[];
  model: string;
  at: number;
}

export interface Hotspot {
  lat: number;
  lon: number;
  frp: number;
  conf: number;
  t: number;
  sat: string;
  day: boolean;
  persistent: boolean;
}

export const CHANGE_COLOR: Record<string, string> = {
  construction: "#22d3ee",
  demolition: "#f87171",
  vehicles: "#facc15",
  vessels: "#38bdf8",
  aircraft: "#a78bfa",
  fire: "#fb923c",
  flood: "#60a5fa",
  vegetation: "#4ade80",
  earthworks: "#fbbf24",
  infrastructure: "#2dd4bf",
  other: "#e5e7eb",
};

export const bboxParam = (b: BBox) => b.map((v) => v.toFixed(5)).join(",");

export const today = () => new Date().toISOString().slice(0, 10);
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export function bboxKm(b: BBox) {
  const latC = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  return { w: (b[2] - b[0]) * 111.32 * Math.cos(latC), h: (b[3] - b[1]) * 110.57 };
}

/** Clamp a bbox around its centre so the longest side fits a source's limit. */
export function clampBBox(b: BBox, maxSpanDeg: number): BBox {
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const hw = Math.min((b[2] - b[0]) / 2, maxSpanDeg / 2);
  const hh = Math.min((b[3] - b[1]) / 2, maxSpanDeg / 2);
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

export function imageUrl(src: string, b: BBox, date: string, size = 1024) {
  return `${apiBase()}/api/imagery/image?src=${src}&bbox=${bboxParam(b)}&date=${date}&size=${size}`;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}

export function useImagerySources() {
  const [data, setData] = useState<{ sources: ImagerySource[]; gemini: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    getJson<{ sources: ImagerySource[]; gemini: boolean }>(`${apiBase()}/api/imagery/sources`)
      .then((d) => live && setData(d))
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return data;
}

export function usePasses(bbox: BBox | null, enabled: boolean) {
  const [passes, setPasses] = useState<Pass[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = bbox && enabled ? bboxParam(bbox) : null;
  useEffect(() => {
    if (!key) { setPasses(null); return; }
    let live = true;
    setLoading(true);
    setError(null);
    getJson<{ passes: Pass[] }>(`${apiBase()}/api/imagery/passes?bbox=${key}&days=120`)
      .then((d) => live && setPasses(d.passes))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [key]);
  return { passes, error, loading };
}

/** Loads one rendered image as an object URL (so the map and the panel share a single download). */
export function useShot(src: string | null, bbox: BBox | null, date: string | null): Shot | null {
  const [shot, setShot] = useState<Shot | null>(null);
  const key = src && bbox && date ? `${src}|${bboxParam(bbox)}|${date}` : null;
  useEffect(() => {
    if (!key || !src || !bbox || !date) { setShot(null); return; }
    let live = true;
    let objectUrl: string | null = null;
    setShot({ src, date, url: "", status: "loading" });
    (async () => {
      try {
        const r = await fetch(imageUrl(src, bbox, date));
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
        }
        const metaRaw = r.headers.get("X-Imagery-Meta");
        const meta = metaRaw ? (JSON.parse(decodeURIComponent(metaRaw)) as ImageMeta) : undefined;
        objectUrl = URL.createObjectURL(await r.blob());
        if (live) setShot({ src, date, url: objectUrl, status: "ready", meta });
      } catch (e) {
        if (live) setShot({ src, date, url: "", status: "error", error: (e as Error).message });
      }
    })();
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return shot;
}

export async function compareImages(bbox: BBox, a: { src: string; date: string }, b: { src: string; date: string }, focus?: string): Promise<CompareResult> {
  const r = await fetch(`${apiBase()}/api/imagery/compare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bbox: bboxParam(bbox), a, b, focus }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const retry = (j as { retryAfterSec?: number }).retryAfterSec;
    throw new Error(((j as { error?: string }).error ?? `HTTP ${r.status}`) + (retry ? ` (retry in ${retry}s)` : ""));
  }
  return j as CompareResult;
}

// ─── FIRMS ───────────────────────────────────────────────────────────────────

export interface FirmsData {
  hotspots: Hotspot[];
  at: number;
  range: string;
  persistentReady: boolean;
}

/** Polls NASA FIRMS (server caches upstream for 1 h; client re-checks every 20 min). */
export function useFirms(active: boolean, range: "24h" | "48h") {
  const [data, setData] = useState<FirmsData | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (!active || busy.current) return;
    busy.current = true;
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const j = await getJson<{ rows: number[][]; sats: string[]; at: number; range: string; persistentReady: boolean }>(`${apiBase()}/api/firms?range=${range}`);
      const hotspots = j.rows.map((r) => ({
        lat: r[0], lon: r[1], frp: r[2], conf: r[3], t: r[4] * 60_000, sat: j.sats[r[5]] ?? "?", day: r[6] === 1, persistent: r[7] === 1,
      }));
      setData({ hotspots, at: j.at, range: j.range, persistentReady: j.persistentReady });
      setError(null);
      setStatus("ready");
    } catch (e) {
      setError((e as Error).message);
      setStatus((s) => (s === "ready" ? s : "error"));
    } finally {
      busy.current = false;
    }
  }, [active, range]);

  useEffect(() => {
    if (!active) return;
    load();
    const id = setInterval(load, 20 * 60_000);
    return () => clearInterval(id);
  }, [active, load]);

  return { data, status, error, reload: load };
}

export function hotspotsToGeoJSON(list: Hotspot[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: list.map((h) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [h.lon, h.lat] },
      properties: { frp: h.frp, conf: h.conf, t: h.t, sat: h.sat, day: h.day ? 1 : 0, persistent: h.persistent ? 1 : 0 },
    })),
  };
}

export function timeAgo(ms: number) {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
