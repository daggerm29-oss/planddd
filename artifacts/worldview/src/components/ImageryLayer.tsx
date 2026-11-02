import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { CHANGE_COLOR, type BBox, type Change } from "../lib/imagery";

const SRC_IMG = "imz-image";
const L_IMG = "imz-image-layer";
const SRC_AOI = "imz-aoi";
const L_AOI_FILL = "imz-aoi-fill";
const L_AOI_LINE = "imz-aoi-line";
const SRC_CHG = "imz-changes";
const L_CHG_FILL = "imz-chg-fill";
const L_CHG_LINE = "imz-chg-line";
const L_CHG_LABEL = "imz-chg-label";
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const ring = (b: BBox): GeoJSON.Position[] => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]];
const boxFeature = (b: BBox, props: Record<string, unknown> = {}): GeoJSON.Feature => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [ring(b)] },
  properties: props,
});

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  bbox: BBox | null;
  drawing: boolean;
  onDrawn: (b: BBox) => void;
  overlayUrl: string | null;
  overlayOpacity: number;
  changes: Change[];
  selectedChange: string | null;
  onSelectChange: (id: string) => void;
}

/** AOI box drawing, imagery overlay pinned to the AOI corners, and Gemini change boxes. */
export function ImageryLayer({ map, mapLoaded, bbox, drawing, onDrawn, overlayUrl, overlayOpacity, changes, selectedChange, onSelectChange }: Props) {
  const onDrawnRef = useRef(onDrawn);
  onDrawnRef.current = onDrawn;
  const onSelectRef = useRef(onSelectChange);
  onSelectRef.current = onSelectChange;

  // AOI + change sources/layers
  useEffect(() => {
    if (!map || !mapLoaded) return;
    if (!map.getSource(SRC_AOI)) map.addSource(SRC_AOI, { type: "geojson", data: EMPTY });
    if (!map.getSource(SRC_CHG)) map.addSource(SRC_CHG, { type: "geojson", data: EMPTY });
    if (!map.getLayer(L_AOI_FILL)) map.addLayer({ id: L_AOI_FILL, type: "fill", source: SRC_AOI, paint: { "fill-color": "#fb923c", "fill-opacity": ["case", ["==", ["get", "draft"], 1], 0.12, 0.03] } });
    if (!map.getLayer(L_AOI_LINE)) map.addLayer({ id: L_AOI_LINE, type: "line", source: SRC_AOI, paint: { "line-color": "#fb923c", "line-width": 1.6, "line-dasharray": [3, 2] } });
    if (!map.getLayer(L_CHG_FILL)) {
      map.addLayer({
        id: L_CHG_FILL,
        type: "fill",
        source: SRC_CHG,
        paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["==", ["get", "selected"], 1], 0.28, 0.1] },
      });
    }
    if (!map.getLayer(L_CHG_LINE)) {
      map.addLayer({
        id: L_CHG_LINE,
        type: "line",
        source: SRC_CHG,
        paint: { "line-color": ["get", "color"], "line-width": ["case", ["==", ["get", "selected"], 1], 2.6, 1.4] },
      });
    }
    if (!map.getLayer(L_CHG_LABEL)) {
      map.addLayer({
        id: L_CHG_LABEL,
        type: "symbol",
        source: SRC_CHG,
        layout: { "text-field": ["get", "label"], "text-size": 11, "text-anchor": "bottom-left", "text-offset": [0, -0.3], "text-allow-overlap": true, "text-font": ["Noto Sans Regular"] },
        paint: { "text-color": ["get", "color"], "text-halo-color": "#05090a", "text-halo-width": 1.4 },
      });
    }
    const click = (e: maplibregl.MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id;
      if (id) onSelectRef.current(String(id));
    };
    const enter = () => { map.getCanvas().style.cursor = "pointer"; };
    const leave = () => { map.getCanvas().style.cursor = ""; };
    map.on("click", L_CHG_FILL, click);
    map.on("mouseenter", L_CHG_FILL, enter);
    map.on("mouseleave", L_CHG_FILL, leave);
    return () => {
      map.off("click", L_CHG_FILL, click);
      map.off("mouseenter", L_CHG_FILL, enter);
      map.off("mouseleave", L_CHG_FILL, leave);
      if (!map.getStyle()) return;
      for (const id of [L_CHG_LABEL, L_CHG_LINE, L_CHG_FILL, L_AOI_LINE, L_AOI_FILL]) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [SRC_CHG, SRC_AOI]) if (map.getSource(id)) map.removeSource(id);
    };
  }, [map, mapLoaded]);

  useEffect(() => {
    if (!map || !mapLoaded) return;
    (map.getSource(SRC_AOI) as maplibregl.GeoJSONSource | undefined)?.setData(bbox ? { type: "FeatureCollection", features: [boxFeature(bbox)] } : EMPTY);
  }, [map, mapLoaded, bbox]);

  useEffect(() => {
    if (!map || !mapLoaded) return;
    (map.getSource(SRC_CHG) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: changes.map((c, i) =>
        boxFeature(c.bbox, { id: c.id, label: `${i + 1}. ${c.label}`, color: CHANGE_COLOR[c.type] ?? CHANGE_COLOR.other, selected: c.id === selectedChange ? 1 : 0 }),
      ),
    });
  }, [map, mapLoaded, changes, selectedChange]);

  // Imagery overlay (MapLibre image source pinned to the AOI corners)
  useEffect(() => {
    if (!map || !mapLoaded) return;
    const remove = () => {
      if (!map.getStyle()) return;
      if (map.getLayer(L_IMG)) map.removeLayer(L_IMG);
      if (map.getSource(SRC_IMG)) map.removeSource(SRC_IMG);
    };
    if (!overlayUrl || !bbox) { remove(); return; }
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
      [bbox[0], bbox[3]], [bbox[2], bbox[3]], [bbox[2], bbox[1]], [bbox[0], bbox[1]],
    ];
    const src = map.getSource(SRC_IMG) as maplibregl.ImageSource | undefined;
    if (src) src.updateImage({ url: overlayUrl, coordinates });
    else {
      map.addSource(SRC_IMG, { type: "image", url: overlayUrl, coordinates });
      map.addLayer({ id: L_IMG, type: "raster", source: SRC_IMG, paint: { "raster-opacity": overlayOpacity, "raster-fade-duration": 0 } }, map.getLayer(L_AOI_FILL) ? L_AOI_FILL : undefined);
    }
    // The image decodes asynchronously; an idle map would otherwise not redraw until the next interaction.
    const onData = (e: maplibregl.MapSourceDataEvent) => { if (e.sourceId === SRC_IMG) map.triggerRepaint(); };
    map.on("sourcedata", onData);
    const t = setTimeout(() => map.triggerRepaint(), 400);
    return () => { map.off("sourcedata", onData); clearTimeout(t); };
  }, [map, mapLoaded, overlayUrl, bbox]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!map || !mapLoaded || !map.getLayer(L_IMG)) return;
    map.setPaintProperty(L_IMG, "raster-opacity", overlayOpacity);
  }, [map, mapLoaded, overlayOpacity, overlayUrl]);

  useEffect(() => () => {
    if (!map || !map.getStyle()) return;
    if (map.getLayer(L_IMG)) map.removeLayer(L_IMG);
    if (map.getSource(SRC_IMG)) map.removeSource(SRC_IMG);
  }, [map]);

  // Box drawing: press-drag-release on the map while `drawing` is on.
  useEffect(() => {
    if (!map || !mapLoaded || !drawing) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = "crosshair";
    map.dragPan.disable();
    map.boxZoom.disable();
    let start: maplibregl.LngLat | null = null;
    const draft = (a: maplibregl.LngLat, b: maplibregl.LngLat): BBox => [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)];
    const setDraft = (b: BBox) =>
      (map.getSource(SRC_AOI) as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [boxFeature(b, { draft: 1 })] });
    const down = (e: maplibregl.MapMouseEvent) => { start = e.lngLat; };
    const move = (e: maplibregl.MapMouseEvent) => { if (start) setDraft(draft(start, e.lngLat)); };
    const up = (e: maplibregl.MapMouseEvent) => {
      if (!start) return;
      const b = draft(start, e.lngLat);
      start = null;
      const px = Math.abs(map.project([b[0], b[1]]).x - map.project([b[2], b[3]]).x);
      if (px > 8) onDrawnRef.current(b);
    };
    map.on("mousedown", down);
    map.on("mousemove", move);
    map.on("mouseup", up);
    return () => {
      map.off("mousedown", down);
      map.off("mousemove", move);
      map.off("mouseup", up);
      canvas.style.cursor = "";
      map.dragPan.enable();
      map.boxZoom.enable();
    };
  }, [map, mapLoaded, drawing]);

  return null;
}
