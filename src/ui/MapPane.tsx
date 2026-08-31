// Ported from intent-transition-mcp route-map MapPane (ADR-0003), simplified:
// desktop-only, no host insets, straight-line legs; adds pending (amber ring),
// candidate (amber outline) and resolving (dashed) pin styles for ADR-0004.
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LegMode } from "../store/types.js";

const TILE_URL = "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

export interface MapMarker {
  id: string;
  name: string;
  lat: number;
  lng: number;
  kind: "stop" | "lodging" | "candidate" | "resolving";
  /** Visit number for stop markers. */
  order?: number;
  pending?: boolean;
  selected?: boolean;
}

export interface MapLeg {
  from: [number, number];
  to: [number, number];
  mode: LegMode;
  /** Transit sub-segments ([lat,lng]) when fetched. */
  path?: { mode: "walk" | "transit"; coords: [number, number][] }[];
}

function pinHtml(inner: string, bg: string, extra = ""): string {
  return `<div style="width:28px;height:28px;background:${bg};color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;font-family:sans-serif;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);${extra}">${inner}</div>`;
}

function iconFor(m: MapMarker): L.DivIcon {
  const ring = m.pending ? "box-shadow:0 0 0 4px rgba(245,158,11,.5),0 1px 4px rgba(0,0,0,.4);" : "";
  const sel = m.selected ? "box-shadow:0 0 0 4px rgba(226,96,63,.4),0 1px 4px rgba(0,0,0,.4);" : "";
  if (m.kind === "lodging") {
    return L.divIcon({
      className: "",
      html: `<div style="width:26px;height:26px;background:#0f172a;color:#fff;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:13px;border:2px solid #fff;${sel || ring}box-shadow:0 1px 4px rgba(0,0,0,.4);">\u{1F3E8}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  }
  if (m.kind === "candidate") {
    return L.divIcon({
      className: "",
      html: `<div style="width:26px;height:26px;background:#fef3c7;border:2px solid #f59e0b;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#92400e;${sel}box-shadow:0 1px 4px rgba(0,0,0,.35);">c</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  }
  if (m.kind === "resolving") {
    return L.divIcon({
      className: "",
      html: `<div style="width:22px;height:22px;background:#e2e8f0;border:2px dashed #64748b;border-radius:50%;opacity:.85;"></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }
  const bg = m.selected ? "#e2603f" : m.pending ? "#f59e0b" : "#2563eb";
  return L.divIcon({
    className: "",
    html: pinHtml(String(m.order ?? ""), bg, m.selected ? sel : ring),
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

export function MapPane({
  markers,
  legs,
  onSelect,
}: {
  markers: MapMarker[];
  legs: MapLeg[];
  onSelect?: (id: string) => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fitKeyRef = useRef("");
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current).setView([35.681, 139.767], 12);
    L.tileLayer(TILE_URL, {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 20,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(elRef.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    for (const m of markers) {
      L.marker([m.lat, m.lng], { icon: iconFor(m) })
        .bindPopup(`<b>${m.order != null ? `${m.order}. ` : ""}${m.name}</b>`)
        .on("click", () => onSelectRef.current?.(m.id))
        .addTo(layer);
    }

    for (const leg of legs) {
      if (leg.mode === "transit" && leg.path?.length) {
        for (const sub of leg.path) {
          if (sub.coords.length < 2) continue;
          L.polyline(sub.coords as L.LatLngExpression[], sub.mode === "transit"
            ? { color: "#6366f1", weight: 4, opacity: 0.85 }
            : { color: "#94a3b8", weight: 3, opacity: 0.8, dashArray: "6 8" },
          ).addTo(layer);
        }
      } else if (leg.mode === "walk" || leg.mode === "transit") {
        L.polyline([leg.from, leg.to], {
          color: leg.mode === "transit" ? "#6366f1" : "#94a3b8",
          weight: 3, opacity: 0.8, dashArray: "6 8",
        }).addTo(layer);
      } else {
        L.polyline([leg.from, leg.to], { color: "#2563eb", weight: 3, opacity: 0.8 }).addTo(layer);
      }
    }

    // fitBounds guard: refit only when the marker set actually changes.
    const pts = markers.map((m) => [m.lat, m.lng] as [number, number]);
    const fitKey = JSON.stringify(pts);
    if (pts.length > 0 && fitKey !== fitKeyRef.current) {
      fitKeyRef.current = fitKey;
      map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
    }
    map.invalidateSize();
  }, [markers, legs]);

  return (
    <div className="relative h-full w-full" style={{ minHeight: 300 }}>
      <div ref={elRef} className="h-full w-full" style={{ minHeight: 300 }} />
      <div className="pointer-events-none absolute bottom-2 left-2 z-[1000] rounded border border-slate-200 bg-white/90 px-2 py-1 text-[11px] leading-relaxed text-slate-600">
        <span className="text-blue-600">━</span> drive&ensp;
        <span className="text-indigo-500">━</span> transit&ensp;
        <span className="text-slate-400">┈</span> walk
      </div>
    </div>
  );
}
