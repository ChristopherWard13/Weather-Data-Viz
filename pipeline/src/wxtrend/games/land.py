"""Which Lower 48 state a point is in, from the site's own basemap.

The games leave out offshore stations: IEM lists Gulf oil platforms in the
Louisiana and Texas networks, with a state and county like any airport. The
basemap's ``statePolys`` (Natural Earth 1:50m, built by ``npm run basemap``) are
the state outlines the player sees, so "on land" means on the map's land. Those
outlines are simplified, so a coastal airport can fall just outside its state:
``slack_km`` lets a point that close to an outline count as inside.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from ..config import REPO_ROOT

BASEMAP = REPO_ROOT / "web" / "src" / "assets" / "basemap-50m.topo.json"
KM_PER_DEG = 111.195  # on a sphere of radius 6371 km


def _decode_arcs(topo: dict) -> list[np.ndarray]:
    (sx, sy), (tx, ty) = topo["transform"]["scale"], topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        q = np.cumsum(np.asarray(arc, dtype=float), axis=0)  # quantized, delta-encoded
        arcs.append(np.column_stack([q[:, 0] * sx + tx, q[:, 1] * sy + ty]))
    return arcs


def _ring(arcs: list[np.ndarray], indexes: list[int]) -> np.ndarray:
    parts = []
    for k, i in enumerate(indexes):
        pts = arcs[i] if i >= 0 else arcs[~i][::-1]
        parts.append(pts if k == 0 else pts[1:])  # each arc starts where the last ended
    return np.concatenate(parts)


class StateOutlines:
    """The Lower 48's state outlines as rings of (lon, lat)."""

    def __init__(self, path: Path = BASEMAP):
        topo = json.loads(Path(path).read_text())
        arcs = _decode_arcs(topo)
        self.states: list[tuple[str, list[np.ndarray], tuple[float, float, float, float]]] = []
        for geom in topo["objects"]["statePolys"]["geometries"]:
            polys = geom["arcs"] if geom["type"] == "MultiPolygon" else [geom["arcs"]]
            rings = [_ring(arcs, ring) for poly in polys for ring in poly]
            allpts = np.concatenate(rings)
            box = (allpts[:, 0].min(), allpts[:, 0].max(), allpts[:, 1].min(), allpts[:, 1].max())
            self.states.append((str(geom["id"]).upper(), rings, box))

    def state_at(self, lon: float, lat: float, slack_km: float = 0.0) -> str | None:
        """The state containing the point, or within ``slack_km`` of it; None offshore or abroad."""
        pad_lat = slack_km / KM_PER_DEG
        pad_lon = pad_lat / max(math.cos(math.radians(lat)), 0.1)
        near = []
        for state, rings, (w, e, s, n) in self.states:
            if w - pad_lon <= lon <= e + pad_lon and s - pad_lat <= lat <= n + pad_lat:
                if _inside(rings, lon, lat):
                    return state
                near.append((state, rings))
        if slack_km <= 0:
            return None
        best = None
        for state, rings in near:
            d = _distance_km(rings, lon, lat)
            if d <= slack_km and (best is None or d < best[0]):
                best = (d, state)
        return best[1] if best else None

    def land_mask(self, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
        """Which points of a grid (latitudes by row, longitudes by column) are in a Lower 48 state."""
        lon2, lat2 = np.meshgrid(lons, lats)
        lon_f, lat_f = lon2.ravel(), lat2.ravel()
        out = np.zeros(lon_f.size, dtype=bool)
        for _, rings, (w, e, s, n) in self.states:
            near = np.flatnonzero((lon_f >= w) & (lon_f <= e) & (lat_f >= s) & (lat_f <= n) & ~out)
            if near.size:
                out[near[_inside_many(rings, lon_f[near], lat_f[near])]] = True
        return out.reshape(lat2.shape)


def _inside_many(rings: list[np.ndarray], lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """``_inside`` for many points at once: a loop over edges, vectorized over points."""
    crossings = np.zeros(lon.size, dtype=np.int64)
    for r in rings:
        for (x0, y0), (x1, y1) in zip(r[:-1], r[1:]):
            if y0 == y1:
                continue
            spans = (y0 > lat) != (y1 > lat)
            x_at = x0 + (lat - y0) * (x1 - x0) / (y1 - y0)
            crossings += spans & (lon < x_at)
    return crossings % 2 == 1


def _inside(rings: list[np.ndarray], lon: float, lat: float) -> bool:
    """Even-odd rule over every ring, so holes (lakes in a polygon) count as outside."""
    crossings = 0
    for r in rings:
        x0, y0 = r[:-1, 0], r[:-1, 1]
        x1, y1 = r[1:, 0], r[1:, 1]
        spans = (y0 > lat) != (y1 > lat)
        with np.errstate(divide="ignore", invalid="ignore"):
            x_at = x0 + (lat - y0) * (x1 - x0) / (y1 - y0)
        crossings += int(np.count_nonzero(spans & (lon < x_at)))
    return crossings % 2 == 1


def _distance_km(rings: list[np.ndarray], lon: float, lat: float) -> float:
    """Shortest distance to any ring's edge, on a local flat projection (fine at a few km)."""
    kx = KM_PER_DEG * math.cos(math.radians(lat))
    best = math.inf
    for r in rings:
        ax, ay = (r[:-1, 0] - lon) * kx, (r[:-1, 1] - lat) * KM_PER_DEG
        bx, by = (r[1:, 0] - lon) * kx, (r[1:, 1] - lat) * KM_PER_DEG
        dx, dy = bx - ax, by - ay
        length2 = dx * dx + dy * dy
        with np.errstate(divide="ignore", invalid="ignore"):
            t = np.clip(np.where(length2 > 0, -(ax * dx + ay * dy) / length2, 0.0), 0.0, 1.0)
        px, py = ax + t * dx, ay + t * dy
        best = min(best, float(np.sqrt(px * px + py * py).min()))
    return best
