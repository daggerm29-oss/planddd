import { useEffect } from "react";
import maplibregl from "maplibre-gl";
import { hotspotsToGeoJSON, timeAgo, type Hotspot } from "../lib/imagery";

const SRC = "firms-hot";
const L_HEAT = "firms-heat";
const L_GLOW = "firms-glow";
const L_DOT = "firms-dot";
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const FRP_COLOR: maplibregl.ExpressionSpecification = [
  "interpolate", ["linear"], ["get", "frp"],
  0, "#fde047",
  8, "#fb923c",
  30, "#ef4444",
  150, "#fff1f2",
];

interface Props {
  map: maplibregl.Map | null;
  mapLoaded: boolean;
  hotspots: Hotspot[];
}

/** NASA FIRMS active fire / thermal anomaly layer: heatmap when zoomed out, FRP-coloured dots when zoomed in. */
export function FirmsLayer({ map, mapLoaded, hotspots }: Props) {
  useEffect(() => {
    if (!map || !mapLoaded) return;
    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY, buffer: 0, tolerance: 0.5 });
    if (!map.getLayer(L_HEAT)) {
      map.addLayer({
        id: L_HEAT,
        type: "heatmap",
        source: SRC,
        maxzoom: 6,
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["get", "frp"], 0, 0.15, 50, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 5, 1.4],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 3, 5, 9],
          "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0.85, 6, 0],
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(0,0,0,0)",
            0.15, "rgba(250,204,21,0.45)",
            0.4, "rgba(251,146,60,0.75)",
            0.7, "rgba(239,68,68,0.9)",
            1, "rgba(255,241,242,1)",
          ],
        },
      });
    }
    if (!map.getLayer(L_GLOW)) {
      map.addLayer({
        id: L_GLOW,
        type: "circle",
        source: SRC,
        minzoom: 3.5,
        paint: {
          "circle-color": FRP_COLOR,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, ["interpolate", ["linear"], ["get", "frp"], 0, 3, 100, 8], 10, ["interpolate", ["linear"], ["get", "frp"], 0, 8, 100, 22]],
          "circle-blur": 1,
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 3.5, 0, 5, 0.45],
        },
      });
    }
    if (!map.getLayer(L_DOT)) {
      map.addLayer({
        id: L_DOT,
        type: "circle",
        source: SRC,
        paint: {
          "circle-color": FRP_COLOR,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 0.8, 4, 1.6, 10, ["interpolate", ["linear"], ["get", "frp"], 0, 3, 100, 7]],
          "circle-stroke-color": ["case", ["==", ["get", "persistent"], 1], "#c084fc", "rgba(0,0,0,0.6)"],
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 3, 0, 4.5, ["case", ["==", ["get", "persistent"], 1], 1.6, 0.5]],
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.55, 4.5, 1],
        },
      });
    }

    const popup = new maplibregl.Popup({ closeButton: false, className: "sig-popup", offset: 8 });
    const click = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as { frp: number; conf: number; t: number; sat: string; day: number; persistent: number };
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
      const kind = p.persistent ? "PERSISTENT HEAT SOURCE" : "ACTIVE FIRE / THERMAL ANOMALY";
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div class="sig-pop-title" style="color:${p.persistent ? "#c084fc" : "#fb923c"}">${kind}</div>` +
            `<div class="sig-pop-row"><b>${p.frp} MW</b> fire radiative power · ${["low", "nominal", "high"][p.conf]} confidence</div>` +
            `<div class="sig-pop-row">${p.sat} · ${p.day ? "day" : "night"} pass · ${timeAgo(Number(p.t))}</div>` +
            `<div class="sig-pop-row">${lat.toFixed(4)}, ${lon.toFixed(4)}</div>` +
            (p.persistent ? `<div class="sig-pop-row">Hot on 4+ of the last 7 days: likely gas flare, refinery, steel plant, power station or volcano.</div>` : ""),
        )
        .addTo(map);
    };
    const enter = () => { map.getCanvas().style.cursor = "pointer"; };
    const leave = () => { map.getCanvas().style.cursor = ""; };
    map.on("click", L_DOT, click);
    map.on("mouseenter", L_DOT, enter);
    map.on("mouseleave", L_DOT, leave);
    return () => {
      map.off("click", L_DOT, click);
      map.off("mouseenter", L_DOT, enter);
      map.off("mouseleave", L_DOT, leave);
      popup.remove();
      if (!map.getStyle()) return;
      for (const id of [L_DOT, L_GLOW, L_HEAT]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
    };
  }, [map, mapLoaded]);

  useEffect(() => {
    if (!map || !mapLoaded) return;
    (map.getSource(SRC) as maplibregl.GeoJSONSource | undefined)?.setData(hotspotsToGeoJSON(hotspots));
  }, [map, mapLoaded, hotspots]);

  return null;
}
