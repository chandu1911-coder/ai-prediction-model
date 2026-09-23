import React, { useState, useEffect, useMemo, useCallback } from "react";

const API_BASE = "http://localhost:5000";

const C = {
  bgOuter: "#F3EEE2",
  panel: "#FBF8EF",
  border: "#D8D0BC",
  ink: "#2B2A22",
  inkDim: "#8A8471",
  moss: "#5C7A63",
  gold: "#B8A055",
  amber: "#B8823A",
  rust: "#A5453A",
  paperMap: "#EDE6D3",
  contour: "#D8CEB0",
};

const CATEGORY_COLOR = { Good: C.moss, Moderate: C.gold, Poor: C.amber, Critical: C.rust };
const SEASONS = ["winter", "summer", "pre_monsoon", "monsoon", "post_monsoon"];
const serif = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";
const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif";

function recommendAction(node, acc) {
  if (!acc) return "";
  if (acc.road_connectivity_degree <= 1) {
    return "Single point of failure — no alternate route if this road is cut. Priority candidate for a second connecting road.";
  }
  if (acc.landslide_prone) {
    return "Sits on a landslide-prone corridor. Recommend pre-monsoon road stabilization and a monitored alternate route.";
  }
  if (acc.avg_connecting_road_quality < 0.4) {
    return "Poor connecting road surface is the main driver of low accessibility. Road-quality investment would raise this score fastest.";
  }
  if (acc.dist_to_hospital_km > 25) {
    return "Long distance to nearest hospital. Consider a mobile health outreach schedule tied to safe-season windows.";
  }
  return "Moderate accessibility — monitor seasonally, no urgent single fix identified.";
}

export default function IntelligenceDashboard() {
  const [network, setNetwork] = useState(null);
  const [accessibility, setAccessibility] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [layer, setLayer] = useState("accessibility"); // accessibility | risk | quality
  const [selectedId, setSelectedId] = useState(null);
  const [seasonalRisk, setSeasonalRisk] = useState(null);
  const [seasonalLoading, setSeasonalLoading] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [netRes, accRes] = await Promise.all([
        fetch(`${API_BASE}/api/network`),
        fetch(`${API_BASE}/api/accessibility`),
      ]);
      if (!netRes.ok || !accRes.ok) throw new Error("Server responded with an error.");
      const net = await netRes.json();
      const acc = await accRes.json();
      setNetwork(net);
      setAccessibility(acc);
    } catch (err) {
      setLoadError(err.message || "Could not reach the local API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const accessByNodeId = useMemo(() => {
    const map = {};
    if (accessibility) accessibility.forEach((a) => { map[a.node_id] = a; });
    return map;
  }, [accessibility]);

  const criticalVillages = useMemo(() => {
    if (!accessibility) return [];
    return [...accessibility].sort((a, b) => a.accessibility_score - b.accessibility_score).slice(0, 6);
  }, [accessibility]);

  const bounds = useMemo(() => {
    if (!network || !network.nodes.length) return null;
    const lats = network.nodes.map((n) => n.lat);
    const lons = network.nodes.map((n) => n.lon);
    return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };
  }, [network]);

  const W = 620, H = 380, PAD = 30;

  const project = useCallback((lat, lon) => {
    if (!bounds) return [0, 0];
    const { minLat, maxLat, minLon, maxLon } = bounds;
    const x = PAD + ((lon - minLon) / (maxLon - minLon || 1)) * (W - 2 * PAD);
    const y = PAD + (1 - (lat - minLat) / (maxLat - minLat || 1)) * (H - 2 * PAD);
    return [x, y];
  }, [bounds]);

  const nodePos = useMemo(() => {
    if (!network) return {};
    const pos = {};
    network.nodes.forEach((n) => { pos[n.id] = project(n.lat, n.lon); });
    return pos;
  }, [network, project]);

  function edgeColor(edge) {
    if (layer === "quality") {
      const q = edge.road_surface_quality;
      return q > 0.66 ? C.moss : q > 0.33 ? C.gold : C.rust;
    }
    if (edge.landslide_history === 1) return C.rust;
    if (edge.avg_slope_pct > 15) return C.amber;
    return C.moss;
  }

  const highRiskSegmentCount = useMemo(() => {
    if (!network) return 0;
    return network.edges.filter((e) => e.landslide_history === 1).length;
  }, [network]);

  const selectedNode = useMemo(() => {
    if (!network || selectedId == null) return null;
    return network.nodes.find((n) => n.id === selectedId) || null;
  }, [network, selectedId]);

  const selectedAcc = selectedId != null ? accessByNodeId[selectedId] : null;

  useEffect(() => {
    if (!network || selectedId == null) {
      setSeasonalRisk(null);
      return;
    }
    const connectingEdges = network.edges.filter(
      (e) => e.source === selectedId || e.target === selectedId
    );
    if (connectingEdges.length === 0) {
      setSeasonalRisk(null);
      return;
    }
    let cancelled = false;
    setSeasonalLoading(true);
    (async () => {
      try {
        const results = [];
        for (const season of SEASONS) {
          const risks = await Promise.all(
            connectingEdges.map((e) =>
              fetch(`${API_BASE}/api/predict/risk`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ u: e.source, v: e.target, season }),
              })
                .then((r) => r.json())
                .then((d) => d.disruption_risk_prob ?? 0)
                .catch(() => 0)
            )
          );
          const avg = risks.reduce((a, b) => a + b, 0) / risks.length;
          results.push({ season, risk: avg });
        }
        if (!cancelled) setSeasonalRisk(results);
      } finally {
        if (!cancelled) setSeasonalLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [network, selectedId]);

  const seasonalPath = useMemo(() => {
    if (!seasonalRisk) return "";
    const w = 190, h = 46;
    const step = w / (seasonalRisk.length - 1);
    return seasonalRisk
      .map((d, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)},${(h - d.risk * h).toFixed(1)}`)
      .join(" ");
  }, [seasonalRisk]);

  return (
    <div style={{ background: C.bgOuter, minHeight: "100vh", fontFamily: sans, padding: 20 }}>
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", maxWidth: 1100, margin: "0 auto" }}>

        <div style={{ padding: "16px 22px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: serif, fontSize: 20, color: C.ink }}>NE Logistics and Accessibility Intelligence</div>
            <div style={{ fontSize: 11.5, color: C.inkDim, marginTop: 2 }}>Live data from your trained models at {API_BASE}</div>
          </div>
          <button onClick={loadAll} style={{ border: `1px solid ${C.border}`, background: C.panel, color: C.inkDim, fontSize: 11.5, padding: "7px 14px", borderRadius: 6, cursor: "pointer" }}>
            Reload
          </button>
        </div>

        {loading && <div style={{ padding: 40, color: C.inkDim, fontSize: 14 }}>Loading from {API_BASE} …</div>}

        {loadError && !loading && (
          <div style={{ padding: 24 }}>
            <div style={{ background: "#F7E8E5", border: `1px solid ${C.rust}`, borderRadius: 8, padding: 16, maxWidth: 520 }}>
              <div style={{ color: C.rust, fontFamily: serif, fontSize: 16, marginBottom: 6 }}>Can't reach the local API</div>
              <div style={{ fontSize: 12.5, color: C.ink, lineHeight: 1.6 }}>
                Make sure <code>python3 src/app.py</code> is running with CORS enabled, on port 5000.
              </div>
              <button onClick={loadAll} style={{ marginTop: 10, background: C.rust, border: "none", color: "#FBF8EF", fontSize: 12.5, padding: "7px 14px", borderRadius: 6, cursor: "pointer" }}>
                Try again
              </button>
            </div>
          </div>
        )}

        {network && !loading && !loadError && (
          <>
            <div style={{ display: "flex" }}>
              <div style={{ width: 200, borderRight: `1px solid ${C.border}`, padding: 18 }}>
                <div style={{ fontSize: 10.5, color: C.inkDim, marginBottom: 8 }}>Map layer</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 18 }}>
                  {[
                    ["accessibility", "Accessibility", C.amber],
                    ["risk", "Disruption risk", C.rust],
                    ["quality", "Road quality", C.moss],
                  ].map(([id, label, color]) => (
                    <button
                      key={id}
                      onClick={() => setLayer(id)}
                      style={{
                        display: "flex", alignItems: "center", gap: 7, fontSize: 11.5,
                        color: layer === id ? C.ink : C.inkDim, background: layer === id ? "#EDE6D3" : "transparent",
                        border: "none", textAlign: "left", padding: "6px 8px", borderRadius: 5, cursor: "pointer",
                      }}
                    >
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: color, display: "inline-block" }} />
                      {label}
                    </button>
                  ))}
                </div>

                <div style={{ fontSize: 10.5, color: C.inkDim, marginBottom: 8 }}>Critical villages</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {criticalVillages.map((v) => (
                    <button
                      key={v.node_id}
                      onClick={() => setSelectedId(v.node_id)}
                      style={{
                        textAlign: "left", background: selectedId === v.node_id ? "#EDE6D3" : C.panel,
                        border: `1px solid ${C.border}`, borderLeft: `2px solid ${CATEGORY_COLOR[v.accessibility_category]}`,
                        padding: "6px 8px", borderRadius: 4, cursor: "pointer",
                      }}
                    >
                      <div style={{ fontSize: 11, color: C.ink }}>{v.name}</div>
                      <div style={{ fontSize: 9.5, color: C.inkDim }}>
                        score {v.accessibility_score.toFixed(0)} · {v.road_connectivity_degree === 1 ? "1 road only" : `${v.road_connectivity_degree} roads`}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ flex: 1, padding: 18, borderRight: `1px solid ${C.border}` }}>
                <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: C.paperMap, borderRadius: 6 }}>
                  <path d={`M0 60 Q ${W * 0.3} 30 ${W * 0.55} 65 T ${W} 45`} stroke={C.contour} fill="none" />
                  <path d={`M0 ${H * 0.5} Q ${W * 0.32} ${H * 0.4} ${W * 0.58} ${H * 0.52} T ${W} ${H * 0.46}`} stroke={C.contour} fill="none" />
                  <path d={`M0 ${H * 0.82} Q ${W * 0.35} ${H * 0.72} ${W * 0.6} ${H * 0.84} T ${W} ${H * 0.76}`} stroke={C.contour} fill="none" />

                  {network.edges.map((e, i) => {
                    const a = nodePos[e.source], b = nodePos[e.target];
                    if (!a || !b) return null;
                    return (
                      <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
                        stroke={edgeColor(e)} strokeWidth={2} strokeOpacity={0.6} strokeLinecap="round" />
                    );
                  })}

                  {network.nodes.map((n) => {
                    const pos = nodePos[n.id];
                    if (!pos) return null;
                    const acc = accessByNodeId[n.id];
                    const color = layer === "accessibility" && acc ? CATEGORY_COLOR[acc.accessibility_category] : C.moss;
                    const isSelected = n.id === selectedId;
                    const r = n.node_type === "hub_city" ? 7 : n.node_type === "town" ? 5 : 3.5;
                    return (
                      <g key={n.id} onClick={() => setSelectedId(n.id)} style={{ cursor: "pointer" }}>
                        {isSelected && <circle cx={pos[0]} cy={pos[1]} r={r + 6} fill="none" stroke={C.ink} strokeWidth={1.3} />}
                        <circle cx={pos[0]} cy={pos[1]} r={r} fill={color} stroke={C.paperMap} strokeWidth={1} />
                      </g>
                    );
                  })}
                </svg>
              </div>

              <div style={{ width: 240, padding: 18 }}>
                {!selectedNode && (
                  <div style={{ fontSize: 12.5, color: C.inkDim }}>Click a village on the map, or pick one from the critical list, to see its detail.</div>
                )}
                {selectedNode && selectedAcc && (
                  <>
                    <div style={{ fontSize: 10.5, color: C.inkDim, marginBottom: 6 }}>Selected: {selectedNode.name}</div>
                    <div style={{ background: "#EDE6D3", border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
                      <div style={{ fontSize: 9, color: C.inkDim }}>Accessibility score</div>
                      <div style={{ fontFamily: serif, fontSize: 26, color: CATEGORY_COLOR[selectedAcc.accessibility_category] }}>
                        {selectedAcc.accessibility_score.toFixed(0)} <span style={{ fontSize: 12, color: C.inkDim, fontFamily: sans }}>/ 100</span>
                      </div>
                      <div style={{ fontSize: 10, color: C.inkDim, marginTop: 4 }}>
                        {selectedAcc.dist_to_hospital_km} km to hospital · {selectedAcc.road_connectivity_degree} connecting road{selectedAcc.road_connectivity_degree !== 1 ? "s" : ""}
                      </div>
                    </div>

                    <div style={{ fontSize: 10.5, color: C.inkDim, marginBottom: 6 }}>Recommended action</div>
                    <div style={{ fontSize: 11.5, color: C.ink, lineHeight: 1.5, marginBottom: 14 }}>
                      {recommendAction(selectedNode, selectedAcc)}
                    </div>

                    <div style={{ fontSize: 10.5, color: C.inkDim, marginBottom: 6 }}>
                      Risk by season {seasonalLoading && <span style={{ fontSize: 9.5 }}>(loading…)</span>}
                    </div>
                    {seasonalRisk && (
                      <svg viewBox="0 0 190 46" width="100%" height="46">
                        <path d={seasonalPath} fill="none" stroke={C.rust} strokeWidth={1.6} />
                        {seasonalRisk.map((d, i) => {
                          const step = 190 / (seasonalRisk.length - 1);
                          return <circle key={i} cx={i * step} cy={46 - d.risk * 46} r={2} fill={C.rust} />;
                        })}
                      </svg>
                    )}
                    {seasonalRisk && (
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, color: C.inkDim, marginTop: 2 }}>
                        {seasonalRisk.map((d) => <span key={d.season}>{d.season.slice(0, 3)}</span>)}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            <div style={{ borderTop: `1px solid ${C.border}`, padding: "12px 22px", display: "flex", gap: 26 }}>
              <div><span style={{ fontFamily: serif, fontSize: 17, color: C.ink }}>{criticalVillages.length}</span><span style={{ fontSize: 10.5, color: C.inkDim }}> shown critical (of {accessibility.length})</span></div>
              <div><span style={{ fontFamily: serif, fontSize: 17, color: C.ink }}>{highRiskSegmentCount}</span><span style={{ fontSize: 10.5, color: C.inkDim }}> high-risk road segments</span></div>
              <div><span style={{ fontFamily: serif, fontSize: 17, color: C.ink }}>{network.edges.length}</span><span style={{ fontSize: 10.5, color: C.inkDim }}> total road segments modeled</span></div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
