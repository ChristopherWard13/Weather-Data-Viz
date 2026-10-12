"""Regrid a source grid to a display grid: barycentric weights, nearest neighbour for categories.

Products whose source is already on the display grid's spacing (0.25° for
``na025``) are cropped by ``fields.crop_to_domain``; everything else comes
through here (GEFS 0.5° now; GDPS, ICON and the regionals later).

- **Build once per source grid.** A Delaunay triangulation of the source
  points (in lon/lat degrees, near the display grid), then for every display
  point the 3 source points of the triangle around it with its barycentric
  weights, and its nearest source point. Display points outside the
  triangulation are nodata (NaN).
- **Apply** is a weighted sum (continuous fields) or a lookup of the nearest
  source point (categorical ones: never interpolate codes).
- **Cache** the weights as ``.npz``, keyed by a hash of the source grid and the
  display grid. They're derived, never a source of truth: a missing or stale
  file is rebuilt. Workflows keep the directory in the Actions cache.

Barycentric interpolation is exact for fields linear in lon/lat and has an
error of at most ½·M·d² inside a triangle, where d is its longest edge and M
bounds the field's second derivatives (``tests/test_regrid.py`` checks both).
"""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .config import REPO_ROOT, Grid

log = logging.getLogger(__name__)

# Bump when the weights' meaning changes, so cached files aren't reused.
VERSION = 1
# Source points this far (degrees) outside the display grid are triangulated
# too, so display points on its edges fall inside the triangulation.
MARGIN_DEG = 2.0

DEFAULT_CACHE_DIR = REPO_ROOT / ".cache" / "regrid"


def cache_dir() -> Path:
    return Path(os.environ.get("WXTREND_REGRID_CACHE") or DEFAULT_CACHE_DIR)


@dataclass(frozen=True)
class Weights:
    """How to sample a source grid at every display-grid point (rows north to south)."""

    shape: tuple[int, int]  # display grid (ny, nx)
    source_size: int  # number of source points the indices refer to
    vertices: np.ndarray  # (n, 3) flat source indices of each point's triangle
    weights: np.ndarray  # (n, 3) barycentric weights, summing to 1
    nearest: np.ndarray  # (n,) flat source index of the nearest point
    inside: np.ndarray  # (n,) False where the point is outside the triangulation

    def _flat(self, field) -> np.ndarray:
        flat = np.asarray(field, dtype=np.float64).ravel()
        if flat.size != self.source_size:
            raise ValueError(f"field has {flat.size} points; the weights were built for {self.source_size}")
        return flat

    def apply(self, field) -> np.ndarray:
        """A continuous field on the display grid; NaN outside the source."""
        out = np.einsum("nk,nk->n", self._flat(field)[self.vertices], self.weights)
        out[~self.inside] = np.nan
        return out.reshape(self.shape)

    def apply_nearest(self, field) -> np.ndarray:
        """A categorical field on the display grid (nearest source point); NaN outside the source."""
        out = self._flat(field)[self.nearest].copy()
        out[~self.inside] = np.nan
        return out.reshape(self.shape)


def display_points(grid: Grid) -> tuple[np.ndarray, np.ndarray]:
    """2-D latitudes and longitudes of a display grid, rows north to south."""
    lats = grid.lat_max - grid.resolution * np.arange(grid.ny)
    lons = grid.lon_min + grid.resolution * np.arange(grid.nx)
    return np.meshgrid(lats, lons, indexing="ij")


def _source_points(lats, lons) -> tuple[np.ndarray, np.ndarray]:
    lats = np.asarray(lats, dtype=np.float64)
    lons = np.asarray(lons, dtype=np.float64)
    if lats.ndim == 1 and lons.ndim == 1:  # a regular grid's axes
        return np.meshgrid(lats, lons, indexing="ij")
    if lats.shape != lons.shape:
        raise ValueError(f"2-D latitudes {lats.shape} and longitudes {lons.shape} must have the same shape")
    return lats, lons


def grid_key(lats, lons, grid: Grid) -> str:
    """A hash of the source grid's points and the display grid's definition."""
    lat2, lon2 = _source_points(lats, lons)
    h = hashlib.sha256()
    h.update(f"v{VERSION}:{lat2.shape}:{grid}".encode())
    h.update(np.ascontiguousarray(lat2).tobytes())
    h.update(np.ascontiguousarray(lon2).tobytes())
    return h.hexdigest()[:24]


def build_weights(lats, lons, grid: Grid, margin: float = MARGIN_DEG) -> Weights:
    """Barycentric and nearest-neighbour weights from source points to ``grid``.

    ``lats``/``lons`` are a regular grid's 1-D axes or 2-D arrays of every
    source point (curvilinear and unstructured grids). Source longitudes may
    use any convention (0..360 or -180..180).
    """
    from scipy.spatial import Delaunay, cKDTree  # deferred: only regridded products need scipy

    lat2, lon2 = _source_points(lats, lons)
    # Longitudes into a 360° window centred on the display grid, so it never
    # straddles the window's seam
    centre = (grid.lon_min + grid.lon_max) / 2
    lon2 = (lon2 - centre + 180.0) % 360.0 - 180.0 + centre
    near = ((lat2 >= grid.lat_min - margin) & (lat2 <= grid.lat_max + margin)
            & (lon2 >= grid.lon_min - margin) & (lon2 <= grid.lon_max + margin))
    sel = np.flatnonzero(near.ravel())
    if sel.size < 3:
        raise ValueError(f"the source grid has {sel.size} points near display grid {grid.id}")
    points = np.column_stack([lon2.ravel()[sel], lat2.ravel()[sel]])

    tlat, tlon = display_points(grid)
    targets = np.column_stack([tlon.ravel(), tlat.ravel()])

    tri = Delaunay(points)
    simplex = tri.find_simplex(targets)
    inside = simplex >= 0
    s = np.where(inside, simplex, 0)
    T = tri.transform[s]  # affine map to the first two barycentric coordinates
    b = np.einsum("nij,nj->ni", T[:, :2], targets - T[:, 2])
    weights = np.column_stack([b, 1.0 - b.sum(axis=1)])
    vertices = sel[tri.simplices[s]]
    weights[~inside] = 0.0

    # Nearest neighbour on the unit sphere, so distances are true distances
    def xyz(lat, lon):
        la, lo = np.radians(lat), np.radians(lon)
        return np.column_stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])

    _, k = cKDTree(xyz(points[:, 1], points[:, 0])).query(xyz(targets[:, 1], targets[:, 0]))
    return Weights(
        shape=(grid.ny, grid.nx),
        source_size=lat2.size,
        vertices=vertices.astype(np.int64),
        weights=weights,
        nearest=sel[k].astype(np.int64),
        inside=inside,
    )


def save_weights(w: Weights, path: Path) -> None:
    """Write atomically: workers building the same weights at once never see a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".npz.tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            np.savez(f, shape=np.array(w.shape), source_size=np.array(w.source_size), vertices=w.vertices,
                     weights=w.weights, nearest=w.nearest, inside=w.inside)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def load_weights(path: Path) -> Weights:
    with np.load(path) as z:
        return Weights(shape=tuple(int(x) for x in z["shape"]), source_size=int(z["source_size"]),
                       vertices=z["vertices"], weights=z["weights"], nearest=z["nearest"], inside=z["inside"])


_memo: dict[str, Weights] = {}  # per process: each worker reads the file once


def weights_for(lats, lons, grid: Grid, directory: Path | None = None) -> Weights:
    """Cached weights for this source grid and display grid: memory, then ``.npz``, then built."""
    key = grid_key(lats, lons, grid)
    if key in _memo:
        return _memo[key]
    path = (directory or cache_dir()) / f"{grid.id}-{key}.npz"
    w = None
    if path.exists():
        try:
            w = load_weights(path)
        except Exception as e:  # noqa: BLE001 - derived data (a truncated .npz raises BadZipFile or EOFError): rebuild
            log.warning("regrid weights %s unreadable (%s); rebuilding", path.name, e)
    if w is None:
        log.info("building regrid weights for %s (%s)", grid.id, key)
        w = build_weights(lats, lons, grid)
        save_weights(w, path)
    _memo[key] = w
    return w
