import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type maplibregl from "maplibre-gl";
import { BoxSelect, Flame, Maximize2, RefreshCw, ScanSearch, Sparkles, X } from "lucide-react";
import { FloatingPanel } from "./FloatingPanel";
import { ImageryLayer } from "./ImageryLayer";
import { FirmsLayer } from "./FirmsLayer";
import {
  bboxKm,
  CHANGE_COLOR,
  clampBBox,
  compareImages,
  daysAgo,
  timeAgo,
  useFirms,
  useImagerySources,
  usePasses,
  useShot,
  type BBox,
  type CompareResult,
  type Shot,
} from "../lib/imagery";

const FONT = "'Share Tech Mono','Courier New',monospace";
const ACCENT = "#fb923c";
const TEXT = "#ffedd5";
const DIM = "rgba(254,215,170,0.55)";
const LINE = "rgba(251,146,60,0.28)";

type Slot = "a" | "b";
type FirmsFilter = "all" | "fires" | "industrial";

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  onClose: () => void;
}

/** Satellite imagery on demand (draw box -> latest pass, A/B swipe, Gemini change detection) + NASA FIRMS hotspots. */
export function ImageryWorkspace({ map, mapLoaded, onClose }: Props) {
  const sources = useImagerySources();
  const [srcId, setSrcId] = useState("s2");
  const [bbox, setBbox] = useState<BBox | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [dates, setDates] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });
  const [overlay, setOverlay] = useState<"off" | Slot>("b");
  const [opacity, setOpacity] = useState(1);
  const [swipe, setSwipe] = useState(50);
  const [focus, setFocus] = useState("");
  const [analysis, setAnalysis] = useState<CompareResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const [firmsOn, setFirmsOn] = useState(true);
  const [firmsRange, setFirmsRange] = useState<"24h" | "48h">("24h");
  const [firmsFilter, setFirmsFilter] = useState<FirmsFilter>("all");
  const [minFrp, setMinFrp] = useState(0);
  const firms = useFirms(firmsOn, firmsRange);

  const src = sources?.sources.find((s) => s.id === srcId);
  const isS2 = srcId === "s2";
  const passes = usePasses(bbox, isS2);

  const shotA = useShot(bbox ? srcId : null, bbox, dates.a);
  const shotB = useShot(bbox ? srcId : null, bbox, dates.b);

  // Default dates: S2 -> latest clear pass vs. a clear pass ~1 month+ earlier; daily sources -> yesterday vs. 30 days ago.
  useEffect(() => {
    if (!bbox) return;
    if (!isS2) {
      setDates({ a: daysAgo(31), b: daysAgo(1) });
      return;
    }
    const list = passes.passes;
    if (!list?.length) { setDates({ a: null, b: null }); return; }
    const good = list.filter((p) => p.cloud <= 30 && p.coverage >= 80);
    const latest = good[0] ?? list[0];
    const cutoff = Date.parse(latest.date) - 25 * 86_400_000;
    const earlier = good.find((p) => Date.parse(p.date) <= cutoff) ?? list.find((p) => Date.parse(p.date) <= cutoff) ?? list[list.length - 1];
    setDates({ a: earlier && earlier.date !== latest.date ? earlier.date : null, b: latest.date });
  }, [bbox, isS2, passes.passes]);

  useEffect(() => {
    setAnalysis(null);
    setSelectedChange(null);
    setAnalysisError(null);
  }, [bbox, srcId, dates.a, dates.b]);

  const setArea = (b: BBox) => {
    const max = src?.maxSpanDeg ?? 1.2;
    setBbox(clampBBox(b, max));
    setDrawing(false);
  };

  const useView = () => {
    if (!map) return;
    const bn = map.getBounds();
    setArea([bn.getWest(), bn.getSouth(), bn.getEast(), bn.getNorth()]);
  };

  const changeSource = (id: string) => {
    setSrcId(id);
    const next = sources?.sources.find((s) => s.id === id);
    if (next && bbox) setBbox(clampBBox(bbox, next.maxSpanDeg));
  };

  const fitTo = (b: BBox) => map?.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, duration: 1200, maxZoom: 16 });

  const runCompare = async () => {
    if (!bbox || !dates.a || !dates.b) return;
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const r = await compareImages(bbox, { src: srcId, date: dates.a }, { src: srcId, date: dates.b }, focus.trim() || undefined);
      setAnalysis(r);
      setOverlay("b");
    } catch (e) {
      setAnalysisError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  const visibleHotspots = useMemo(() => {
    const list = firms.data?.hotspots ?? [];
    return list.filter((h) => h.frp >= minFrp && (firmsFilter === "all" || (firmsFilter === "industrial" ? h.persistent : !h.persistent)));
  }, [firms.data, minFrp, firmsFilter]);

  const aoiHotspots = useMemo(() => {
    if (!bbox) return [];
    return visibleHotspots
      .filter((h) => h.lon >= bbox[0] && h.lon <= bbox[2] && h.lat >= bbox[1] && h.lat <= bbox[3])
      .sort((x, y) => y.frp - x.frp);
  }, [visibleHotspots, bbox]);

  const persistentCount = useMemo(() => (firms.data?.hotspots ?? []).filter((h) => h.persistent).length, [firms.data]);

  const overlayShot = overlay === "a" ? shotA : overlay === "b" ? shotB : null;
  const km = bbox ? bboxKm(bbox) : null;

  return (
    <>
      <ImageryLayer
        map={map}
        mapLoaded={mapLoaded}
        bbox={bbox}
        drawing={drawing}
        onDrawn={setArea}
        overlayUrl={overlayShot?.status === "ready" ? overlayShot.url : null}
        overlayOpacity={opacity}
        changes={analysis?.changes ?? []}
        selectedChange={selectedChange}
        onSelectChange={setSelectedChange}
      />
      {firmsOn && <FirmsLayer map={map} mapLoaded={mapLoaded} hotspots={visibleHotspots} />}

      <FloatingPanel title="SAT IMAGERY / THERMAL" initialX={54} initialY={14} width={360} accentColor={ACCENT} onClose={onClose}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "10px 12px 14px", fontFamily: FONT, color: TEXT, overflowY: "auto", minHeight: 0 }}>
          <Section title="AREA OF INTEREST" right={km ? `${km.w.toFixed(1)} × ${km.h.toFixed(1)} KM` : "NONE"}>
            <div style={{ display: "flex", gap: 6 }}>
              <Btn active={drawing} onClick={() => setDrawing((d) => !d)} icon={<BoxSelect size={13} aria-hidden />}>
                {drawing ? "DRAG ON MAP…" : "DRAW BOX"}
              </Btn>
              <Btn onClick={useView} icon={<Maximize2 size={13} aria-hidden />}>USE VIEW</Btn>
              {bbox && (
                <Btn onClick={() => { setBbox(null); setDates({ a: null, b: null }); }} icon={<X size={13} aria-hidden />} title="Clear area">
                  CLEAR
                </Btn>
              )}
            </div>
            <p style={{ margin: "6px 0 0", fontSize: 9.5, color: DIM }}>
              {bbox
                ? `${((bbox[1] + bbox[3]) / 2).toFixed(4)}, ${((bbox[0] + bbox[2]) / 2).toFixed(4)} · max ${src?.maxSpanDeg ?? "?"}° side for this source`
                : "Draw a box on the map (press, drag, release) or use the current view. The latest satellite pass loads automatically."}
            </p>
          </Section>

          <Section title="SENSOR">
            <select
              aria-label="Imagery source"
              value={srcId}
              onChange={(e) => changeSource(e.target.value)}
              style={{ width: "100%", background: "#0b0705", color: TEXT, border: `1px solid ${LINE}`, fontFamily: FONT, fontSize: 11, padding: "6px 6px" }}
            >
              {(sources?.sources ?? []).map((s) => (
                <option key={s.id} value={s.id} disabled={!s.available}>
                  {s.label}{s.available ? "" : " (needs key)"}
                </option>
              ))}
            </select>
            {src && <p style={{ margin: "6px 0 0", fontSize: 9.5, color: DIM }}>{src.note}</p>}
          </Section>

          {bbox && (
            <Section title={isS2 ? "SENTINEL-2 PASSES · 120 D" : "DATES"} right={isS2 && passes.loading ? "SEARCHING" : undefined}>
              {isS2 ? (
                <PassList
                  passes={passes.passes}
                  error={passes.error}
                  dates={dates}
                  onPick={(slot, date) => setDates((d) => ({ ...d, [slot]: date }))}
                />
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  {(["a", "b"] as const).map((slot) => (
                    <label key={slot} style={{ flex: 1, fontSize: 9.5, color: DIM, display: "flex", flexDirection: "column", gap: 3 }}>
                      {slot === "a" ? "BEFORE (A)" : "AFTER (B)"}
                      <input
                        type="date"
                        value={dates[slot] ?? ""}
                        max={daysAgo(0)}
                        onChange={(e) => setDates((d) => ({ ...d, [slot]: e.target.value || null }))}
                        style={{ background: "#0b0705", color: TEXT, border: `1px solid ${LINE}`, fontFamily: FONT, fontSize: 11, padding: "4px 6px", colorScheme: "dark" }}
                      />
                    </label>
                  ))}
                </div>
              )}
            </Section>
          )}

          {bbox && (shotA || shotB) && (
            <Section
              title="BEFORE / AFTER"
              right={
                <button type="button" onClick={() => setExpanded(true)} style={iconBtn} aria-label="Open large compare view">
                  <Maximize2 size={12} aria-hidden />
                </button>
              }
            >
              <SwipeCompare a={shotA} b={shotB} swipe={swipe} onSwipe={setSwipe} height={200} />
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 9.5, color: DIM }}>
                <span>MAP OVERLAY</span>
                {(["off", "a", "b"] as const).map((o) => (
                  <Chip key={o} active={overlay === o} onClick={() => setOverlay(o)}>{o.toUpperCase()}</Chip>
                ))}
                <input
                  type="range"
                  min={0.2}
                  max={1}
                  step={0.05}
                  value={opacity}
                  onChange={(e) => setOpacity(Number(e.target.value))}
                  aria-label="Overlay opacity"
                  style={{ flex: 1, accentColor: ACCENT }}
                />
                {bbox && <button type="button" style={iconBtn} onClick={() => fitTo(bbox)} aria-label="Zoom to area"><ScanSearch size={12} aria-hidden /></button>}
              </div>
            </Section>
          )}

          {bbox && (
            <Section title="CHANGE DETECTION · GEMINI VISION" right={analysis ? analysis.model : undefined}>
              <input
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                placeholder="Optional focus, e.g. new buildings near the runway"
                aria-label="Analysis focus"
                style={{ width: "100%", boxSizing: "border-box", background: "#0b0705", color: TEXT, border: `1px solid ${LINE}`, fontFamily: FONT, fontSize: 10.5, padding: "6px 7px", marginBottom: 6 }}
              />
              <Btn
                full
                active
                disabled={analyzing || !dates.a || !dates.b || shotA?.status !== "ready" || shotB?.status !== "ready" || sources?.gemini === false}
                onClick={runCompare}
                icon={analyzing ? <RefreshCw size={13} className="animate-spin" aria-hidden /> : <Sparkles size={13} aria-hidden />}
              >
                {analyzing ? "ANALYSING A → B…" : `ANALYSE CHANGES ${dates.a ?? "?"} → ${dates.b ?? "?"}`}
              </Btn>
              {sources?.gemini === false && <p style={{ margin: "6px 0 0", fontSize: 9.5, color: "#fca5a5" }}>GEMINI_KEY is not set on the server.</p>}
              {analysisError && <p style={{ margin: "6px 0 0", fontSize: 9.5, color: "#fca5a5" }}>{analysisError}</p>}
              {analysis && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                  <p style={{ margin: 0, fontSize: 11, lineHeight: 1.45 }}>{analysis.summary || "No summary returned."}</p>
                  {analysis.changes.length === 0 && <p style={{ margin: 0, fontSize: 9.5, color: DIM }}>No significant physical change detected.</p>}
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                    {analysis.changes.map((c, i) => {
                      const color = CHANGE_COLOR[c.type] ?? CHANGE_COLOR.other;
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => { setSelectedChange(c.id); fitTo(c.bbox); }}
                            style={{
                              width: "100%", textAlign: "left", cursor: "pointer", fontFamily: FONT, color: TEXT, padding: "6px 8px",
                              background: selectedChange === c.id ? `${color}22` : "rgba(255,255,255,0.02)", border: `1px solid ${color}66`,
                            }}
                          >
                            <span style={{ display: "flex", justifyContent: "space-between", fontSize: 11, letterSpacing: "0.06em" }}>
                              <span style={{ color }}>{i + 1}. {c.label}</span>
                              <span style={{ color: DIM, fontSize: 9.5 }}>{c.type.toUpperCase()} · {Math.round(c.confidence * 100)}%</span>
                            </span>
                            {c.detail && <span style={{ display: "block", fontSize: 9.5, color: DIM, marginTop: 2 }}>{c.detail}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {analysis.caveats && <p style={{ margin: 0, fontSize: 9, color: DIM }}>CAVEATS: {analysis.caveats}</p>}
                </div>
              )}
            </Section>
          )}

          <Section
            title="THERMAL HOTSPOTS · NASA FIRMS"
            right={
              <button type="button" onClick={() => setFirmsOn((v) => !v)} style={{ ...iconBtn, color: firmsOn ? ACCENT : DIM }} aria-pressed={firmsOn} aria-label="Toggle FIRMS layer">
                <Flame size={13} aria-hidden />
              </button>
            }
          >
            {firmsOn ? (
              <>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(["24h", "48h"] as const).map((r) => <Chip key={r} active={firmsRange === r} onClick={() => setFirmsRange(r)}>{r.toUpperCase()}</Chip>)}
                  <span style={{ width: 6 }} />
                  {(["all", "fires", "industrial"] as const).map((f) => <Chip key={f} active={firmsFilter === f} onClick={() => setFirmsFilter(f)}>{f.toUpperCase()}</Chip>)}
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 9.5, color: DIM }}>
                  MIN FRP
                  <input type="range" min={0} max={100} step={1} value={minFrp} onChange={(e) => setMinFrp(Number(e.target.value))} style={{ flex: 1, accentColor: ACCENT }} />
                  <span style={{ color: TEXT, width: 44, textAlign: "right" }}>{minFrp} MW</span>
                </label>
                <p style={{ margin: "6px 0 0", fontSize: 9.5, color: DIM }}>
                  {firms.status === "loading" && !firms.data
                    ? "Loading global VIIRS + MODIS detections…"
                    : firms.error && !firms.data
                      ? `FIRMS unavailable: ${firms.error}`
                      : firms.data
                        ? `${visibleHotspots.length.toLocaleString()} shown · ${firms.data.hotspots.length.toLocaleString()} total · ${persistentCount.toLocaleString()} persistent (industrial) · fetched ${timeAgo(firms.data.at)}`
                        : ""}
                </p>
                <Legend />
                {bbox && aoiHotspots.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 9.5, color: ACCENT, letterSpacing: "0.12em", marginBottom: 4 }}>{aoiHotspots.length} IN AREA · STRONGEST</div>
                    {aoiHotspots.slice(0, 5).map((h, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => map?.flyTo({ center: [h.lon, h.lat], zoom: 13, duration: 1200 })}
                        style={{ width: "100%", display: "flex", justifyContent: "space-between", fontFamily: FONT, fontSize: 10, color: TEXT, background: "transparent", border: "none", borderBottom: `1px solid ${LINE}`, padding: "4px 0", cursor: "pointer" }}
                      >
                        <span style={{ color: h.persistent ? "#c084fc" : ACCENT }}>{h.frp} MW {h.persistent ? "PERSISTENT" : "FIRE"}</span>
                        <span style={{ color: DIM }}>{h.sat} · {timeAgo(h.t)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 9.5, color: DIM }}>Layer off. Toggle the flame to show worldwide fires and industrial heat sources.</p>
            )}
          </Section>
        </div>
      </FloatingPanel>

      {expanded && (
        <div
          role="dialog"
          aria-label="Before and after comparison"
          style={{ position: "fixed", inset: 0, zIndex: 3000, background: "rgba(5,3,2,0.88)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 24, fontFamily: FONT }}
          onKeyDown={(e) => e.key === "Escape" && setExpanded(false)}
        >
          <div style={{ width: "min(92vw, 1100px)", display: "flex", justifyContent: "space-between", color: TEXT, fontSize: 12, letterSpacing: "0.12em" }}>
            <span>A {dates.a} ⟷ B {dates.b} · {src?.label}</span>
            <button type="button" onClick={() => setExpanded(false)} style={{ ...iconBtn, color: TEXT }} aria-label="Close" autoFocus>
              <X size={16} aria-hidden />
            </button>
          </div>
          <div style={{ width: "min(92vw, 1100px)" }}>
            <SwipeCompare a={shotA} b={shotB} swipe={swipe} onSwipe={setSwipe} height="min(78vh, 760px)" changes={analysis?.changes} bbox={bbox} />
          </div>
        </div>
      )}
    </>
  );
}

function PassList({
  passes,
  error,
  dates,
  onPick,
}: {
  passes: { date: string; cloud: number; coverage: number; scenes: number }[] | null;
  error: string | null;
  dates: { a: string | null; b: string | null };
  onPick: (slot: Slot, date: string) => void;
}) {
  if (error) return <p style={{ margin: 0, fontSize: 9.5, color: "#fca5a5" }}>{error}</p>;
  if (!passes) return <p style={{ margin: 0, fontSize: 9.5, color: DIM }}>Searching Sentinel-2 catalogue…</p>;
  if (!passes.length) return <p style={{ margin: 0, fontSize: 9.5, color: DIM }}>No passes in the last 120 days.</p>;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column" }}>
      {passes.map((p) => (
        <li key={p.date} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, padding: "3px 0", borderBottom: `1px solid ${LINE}` }}>
          <span style={{ flex: 1 }}>{p.date}</span>
          <span style={{ width: 62, color: p.cloud > 50 ? "#fca5a5" : p.cloud > 20 ? "#fde68a" : "#86efac" }}>☁ {p.cloud}%</span>
          <span style={{ width: 52, color: p.coverage < 80 ? "#fde68a" : DIM }}>{p.coverage}% AOI</span>
          <Chip active={dates.a === p.date} onClick={() => onPick("a", p.date)}>A</Chip>
          <Chip active={dates.b === p.date} onClick={() => onPick("b", p.date)}>B</Chip>
        </li>
      ))}
    </ul>
  );
}

function SwipeCompare({
  a,
  b,
  swipe,
  onSwipe,
  height,
  changes,
  bbox,
}: {
  a: Shot | null;
  b: Shot | null;
  swipe: number;
  onSwipe: (v: number) => void;
  height: number | string;
  changes?: CompareResult["changes"];
  bbox?: BBox | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const setFromEvent = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    onSwipe(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };
  const status = (s: Shot | null, label: string) =>
    !s ? `${label}: pick a date` : s.status === "loading" ? `${label}: rendering…` : s.status === "error" ? `${label}: ${s.error}` : null;
  const img = (s: Shot | null) => (s?.status === "ready" ? <img src={s.url} alt="" draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "fill" }} /> : null);

  return (
    <div
      ref={ref}
      onPointerDown={(e) => { dragging.current = true; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setFromEvent(e.clientX); }}
      onPointerMove={(e) => dragging.current && setFromEvent(e.clientX)}
      onPointerUp={() => { dragging.current = false; }}
      style={{ position: "relative", height, background: "#050302", border: `1px solid ${LINE}`, overflow: "hidden", cursor: "ew-resize", touchAction: "none", userSelect: "none" }}
    >
      {img(b)}
      <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 ${100 - swipe}% 0 0)` }}>{img(a)}</div>
      {changes && bbox &&
        changes.map((c, i) => {
          const color = CHANGE_COLOR[c.type] ?? CHANGE_COLOR.other;
          const left = ((c.bbox[0] - bbox[0]) / (bbox[2] - bbox[0])) * 100;
          const right = ((c.bbox[2] - bbox[0]) / (bbox[2] - bbox[0])) * 100;
          const top = ((bbox[3] - c.bbox[3]) / (bbox[3] - bbox[1])) * 100;
          const bottom = ((bbox[3] - c.bbox[1]) / (bbox[3] - bbox[1])) * 100;
          return (
            <div key={c.id} style={{ position: "absolute", left: `${left}%`, top: `${top}%`, width: `${right - left}%`, height: `${bottom - top}%`, border: `2px solid ${color}`, pointerEvents: "none" }}>
              <span style={{ position: "absolute", top: -16, left: -2, background: color, color: "#05090a", fontSize: 10, padding: "0 4px", whiteSpace: "nowrap" }}>{i + 1}. {c.label}</span>
            </div>
          );
        })}
      <div style={{ position: "absolute", top: 0, bottom: 0, left: `${swipe}%`, width: 2, marginLeft: -1, background: ACCENT, boxShadow: `0 0 8px ${ACCENT}` }} />
      <span style={tag("left")}>A {a?.date ?? ""}</span>
      <span style={tag("right")}>B {b?.date ?? ""}</span>
      {(status(a, "A") || status(b, "B")) && (
        <div style={{ position: "absolute", left: 6, right: 6, bottom: 6, display: "flex", flexDirection: "column", gap: 2, fontSize: 9.5, color: TEXT, textShadow: "0 1px 2px #000" }}>
          {status(a, "A") && <span>{status(a, "A")}</span>}
          {status(b, "B") && <span>{status(b, "B")}</span>}
        </div>
      )}
      {b?.meta?.cloud && (
        <span style={{ position: "absolute", right: 6, bottom: 6, fontSize: 9, color: TEXT, background: "rgba(0,0,0,0.55)", padding: "1px 4px" }}>
          B cloud {b.meta.cloud}% · {b.meta.time?.slice(11, 16)}Z
        </span>
      )}
    </div>
  );
}

const tag = (side: "left" | "right") =>
  ({ position: "absolute", top: 6, [side]: 6, fontSize: 10, letterSpacing: "0.1em", color: "#05090a", background: ACCENT, padding: "1px 5px" }) as const;

function Legend() {
  const items: [string, string][] = [["#fde047", "< 8 MW"], ["#fb923c", "8-30"], ["#ef4444", "30-150"], ["#fff1f2", "> 150"]];
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6, fontSize: 9, color: DIM }}>
      {items.map(([c, l]) => (
        <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: 8, background: c }} />{l}
        </span>
      ))}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: 8, border: "1.6px solid #c084fc" }} />persistent / industrial
      </span>
    </div>
  );
}

const iconBtn = { background: "transparent", border: "none", color: DIM, cursor: "pointer", padding: 2, display: "inline-flex" } as const;

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${LINE}`, paddingBottom: 4, marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 10, letterSpacing: "0.16em", color: ACCENT, fontWeight: 400 }}>{title}</h3>
        {typeof right === "string" ? <span style={{ fontSize: 9, color: DIM, letterSpacing: "0.1em" }}>{right}</span> : right}
      </header>
      {children}
    </section>
  );
}

function Btn({ children, onClick, active, disabled, icon, full, title }: { children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean; icon?: ReactNode; full?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        flex: full ? undefined : 1,
        width: full ? "100%" : undefined,
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
        padding: "6px 8px", fontFamily: FONT, fontSize: 10.5, letterSpacing: "0.1em", cursor: disabled ? "not-allowed" : "pointer",
        color: active ? "#1a0d04" : TEXT, background: active ? ACCENT : "rgba(251,146,60,0.06)", border: `1px solid ${active ? ACCENT : LINE}`,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

function Chip({ children, active, onClick }: { children: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontFamily: FONT, fontSize: 9.5, letterSpacing: "0.08em", padding: "2px 7px", cursor: "pointer",
        color: active ? "#1a0d04" : TEXT, background: active ? ACCENT : "transparent", border: `1px solid ${active ? ACCENT : LINE}`,
      }}
    >
      {children}
    </button>
  );
}
