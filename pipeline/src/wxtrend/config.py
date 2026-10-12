"""Load and validate the shared configuration in ``config/`` at the repository root.

    config/site.json         map projection, view settings, pipeline settings
    config/fields.json       the canonical field catalog: labels, bands, encodings
    config/grids.json        display grids
    config/models/<id>.json  one model: source, cycles, hours, lags, the fields it
                             provides (with their GRIB search strings for Herbie
                             sources), its products

A **product** is a model on one display grid. It is the unit the pipeline
fetches and the site shows. The frontend bundles the same files, so every
tunable lives in one place. Derived quantities (retention window, fetch range)
are computed here rather than stored, so they can never disagree with the lags
they come from.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG_DIR = REPO_ROOT / "config"

DTYPES = {"uint8": 255, "uint16": 65535}

# How a model's files are fetched (see fetch.py):
#   herbie          Herbie reads a wgrib2-style .idx; each field has a search regex
#   ecmwf_opendata  ECMWF open data: an eccodes .index (JSON lines) next to each
#                   GRIB2 file; messages are picked from catalog.py's recipes
ADAPTERS = ("herbie", "ecmwf_opendata")

_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")  # field and grid ids
_PRODUCT_ID_RE = re.compile(r"^[a-z][a-z0-9-]*$")  # model and product ids, e.g. nam-conus


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Grid:
    """A regular lat/lon display grid. Rows run north to south, columns west to east."""

    id: str
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float
    resolution: float

    @property
    def nx(self) -> int:
        return _steps(self.lon_max - self.lon_min, self.resolution) + 1

    @property
    def ny(self) -> int:
        return _steps(self.lat_max - self.lat_min, self.resolution) + 1


@dataclass(frozen=True)
class Band:
    """One stored layer: value = stored * scale + offset (in ``units``)."""

    name: str
    units: str
    dtype: str
    scale: float
    offset: float
    wrap: float | None = None  # e.g. 360 for directions: stored modulo, never clipped
    categories: tuple[str, ...] | None = None
    nodata: int | None = None  # the dtype's top value, reserved for missing samples

    @property
    def max_stored(self) -> int:
        """Largest stored value of a valid sample (one below ``nodata`` if the band has it)."""
        top = DTYPES[self.dtype]
        return top - 1 if self.nodata is not None else top

    @property
    def itemsize(self) -> int:
        return 1 if self.dtype == "uint8" else 2

    def manifest(self) -> dict:
        out = {"name": self.name, "units": self.units, "dtype": self.dtype, "scale": self.scale, "offset": self.offset}
        if self.wrap is not None:
            out["wrap"] = self.wrap
        if self.categories is not None:
            out["categories"] = list(self.categories)
        if self.nodata is not None:
            out["nodata"] = self.nodata
        return out


@dataclass(frozen=True)
class FieldSpec:
    """A group of bands fetched together and stored in one file per hour.

    The label and bands come from the catalog; the search string and first
    hour come from the model that provides the field.
    """

    id: str
    label: str
    search: str | None  # Herbie regex template; {f} = forecast hour, {a} = f - step (bucket start)
    min_fhr: int
    bands: tuple[Band, ...]

    def search_for(self, fhr: int, step: int) -> str:
        if self.search is None:
            raise ValueError(f"{self.id} has no search string (only Herbie sources use one)")
        return self.search.format(f=fhr, a=fhr - step)

    def frame_bytes(self, nx: int, ny: int) -> int:
        return sum(b.itemsize for b in self.bands) * nx * ny


@dataclass(frozen=True)
class Model:
    """A forecast model and where its files are published."""

    id: str
    name: str  # display name, e.g. "GFS"
    adapter: str  # one of ADAPTERS
    index_url: str  # template for one hour's index file: {init:%Y%m%d}, {fhr}, {fhr:03d}, ...
    herbie_model: str | None = None  # Herbie's model template, e.g. "gfs"
    herbie_product: str | None = None  # Herbie's product, e.g. "pgrb2.0p25"
    source: str | None = None  # Herbie source to fetch from, e.g. "aws"
    max_connections: int | None = None  # cap on concurrent requests to the source (None: no cap)

    def index_url_for(self, init: datetime, fhr: int) -> str:
        """Where the hour's index is published; it existing means the hour is posted."""
        return self.index_url.format(init=init, fhr=fhr)


@dataclass(frozen=True)
class Product:
    """A model on one display grid: what the pipeline fetches and the site shows."""

    id: str
    model: Model
    grid: Grid
    cycle_interval_hours: int
    fhr_min: int
    fhr_max: int  # last displayed hour
    fhr_step: int
    model_max: int  # last hour the model outputs
    lags: tuple[int, ...]
    default_lag: int
    fields: tuple[FieldSpec, ...]  # catalog order, only the fields the model provides
    lookback_cycles: int
    workers: int
    retries: int

    @property
    def max_lag(self) -> int:
        return max(self.lags)

    @property
    def retained_runs(self) -> int:
        """Current run plus enough older runs to reach the longest lag."""
        return 1 + self.max_lag // self.cycle_interval_hours

    @property
    def display_hours(self) -> list[int]:
        return list(range(self.fhr_min, self.fhr_max + 1, self.fhr_step))

    @property
    def fetch_hours(self) -> list[int]:
        """Hours each run must provide.

        A run is shown as "current" for ``fhr_min..fhr_max`` and used as the
        older comparison run at ``f + L``, so it needs hours out to
        ``fhr_max + max_lag``, but never past the model's last hour. Showing a
        model's full range makes the two equal; comparisons that would need an
        hour past the older run's end are "unavailable".
        """
        last = min(self.fhr_max + self.max_lag, self.model_max)
        return list(range(self.fhr_min, last + 1, self.fhr_step))

    def field(self, field_id: str) -> FieldSpec:
        for f in self.fields:
            if f.id == field_id:
                return f
        raise KeyError(field_id)

    def fields_for_hour(self, fhr: int) -> list[FieldSpec]:
        """Fields that exist at this hour (accumulations start after F000)."""
        return [f for f in self.fields if fhr >= f.min_fhr]

    def search_for(self, fhr: int, field_ids: list[str] | None = None) -> str:
        """One regex selecting every needed GRIB message for this hour (Herbie sources)."""
        fields = [f for f in self.fields_for_hour(fhr) if field_ids is None or f.id in field_ids]
        return "|".join(f.search_for(fhr, self.fhr_step) for f in fields)


@dataclass(frozen=True)
class Config:
    """Everything under ``config/`` that the pipeline uses."""

    grids: dict[str, Grid]
    models: dict[str, Model]
    products: dict[str, Product]

    def product(self, product_id: str) -> Product:
        try:
            return self.products[product_id]
        except KeyError:
            raise ConfigError(f"unknown product {product_id!r}; configured: {', '.join(self.products)}") from None


def _steps(span: float, res: float) -> int:
    n = span / res
    if abs(n - round(n)) > 1e-6:
        raise ConfigError(f"span {span} is not a multiple of resolution {res}")
    return int(round(n))


def load_config(path: str | os.PathLike | None = None) -> Config:
    """Load the config directory (default: ``config/`` at the repo root, or $WXTREND_CONFIG)."""
    root = Path(path or os.environ.get("WXTREND_CONFIG") or DEFAULT_CONFIG_DIR)
    return parse_config(read_config(root))


def read_config(root: Path) -> dict:
    """The config files as one dict: ``{site, fields, grids, models: {id: model}}``."""

    def load(p: Path) -> dict:
        with open(p) as f:
            return json.load(f)

    return {
        "site": load(root / "site.json"),
        "fields": load(root / "fields.json"),
        "grids": load(root / "grids.json"),
        "models": {p.stem: load(p) for p in sorted((root / "models").glob("*.json"))},
    }


def _band(raw: dict) -> Band:
    cats = raw.get("categories")
    return Band(
        name=raw["name"],
        units=raw["units"],
        dtype=raw["dtype"],
        scale=float(raw["scale"]),
        offset=float(raw["offset"]),
        wrap=float(raw["wrap"]) if raw.get("wrap") is not None else None,
        categories=tuple(cats) if cats is not None else None,
        nodata=int(raw["nodata"]) if raw.get("nodata") is not None else None,
    )


def parse_config(raw: dict) -> Config:
    try:
        pipeline = raw["site"]["pipeline"]
        catalog = {fid: (f["label"], tuple(_band(b) for b in f["bands"])) for fid, f in raw["fields"].items()}
        grids = {
            gid: Grid(
                id=gid,
                lat_min=float(g["lat_min"]),
                lat_max=float(g["lat_max"]),
                lon_min=float(g["lon_min"]),
                lon_max=float(g["lon_max"]),
                resolution=float(g["resolution_deg"]),
            )
            for gid, g in raw["grids"].items()
        }
        models: dict[str, Model] = {}
        products: dict[str, Product] = {}
        for mid, m in raw["models"].items():
            src = m["source"]
            if src["adapter"] not in ADAPTERS:
                raise ConfigError(f"model {mid}: adapter must be one of {ADAPTERS}")
            herbie = src["adapter"] == "herbie"
            model = Model(
                id=mid,
                name=m["name"],
                adapter=src["adapter"],
                index_url=src["index_url"],
                herbie_model=src["herbie_model"] if herbie else None,
                herbie_product=src["herbie_product"] if herbie else None,
                source=src["priority"] if herbie else None,
                max_connections=int(src["max_connections"]) if src.get("max_connections") else None,
            )
            models[mid] = model
            fields = _model_fields(mid, m["fields"], catalog, needs_search=herbie)
            fh = m["forecast_hours"]
            if not m["products"]:
                raise ConfigError(f"model {mid} has no products")
            for pid, p in m["products"].items():
                if pid in products:
                    raise ConfigError(f"product {pid} is defined by both {products[pid].model.id} and {mid}")
                if p["grid"] not in grids:
                    raise ConfigError(f"product {pid}: unknown grid {p['grid']!r}")
                products[pid] = Product(
                    id=pid,
                    model=model,
                    grid=grids[p["grid"]],
                    cycle_interval_hours=int(m["cycle_interval_hours"]),
                    fhr_min=int(fh["min"]),
                    fhr_max=int(fh["max"]),
                    fhr_step=int(fh["step"]),
                    model_max=int(fh["model_max"]),
                    lags=tuple(sorted(int(x) for x in m["lags_hours"])),
                    default_lag=int(m["default_lag_hours"]),
                    fields=fields,
                    lookback_cycles=int(pipeline["lookback_cycles"]),
                    workers=min(int(pipeline["workers"]), model.max_connections or int(pipeline["workers"])),
                    retries=int(pipeline["retries"]),
                )
    except KeyError as e:
        raise ConfigError(f"missing config key: {e}") from e
    if not products:
        raise ConfigError("at least one model with a product is required")
    for fid, (_, bands) in catalog.items():
        _validate_field(fid, bands)
    for grid in grids.values():
        _validate_grid(grid)
    for product in products.values():
        _validate_product(product)
    return Config(grids=grids, models=models, products=products)


def _model_fields(model_id: str, provided: dict, catalog: dict, needs_search: bool) -> tuple[FieldSpec, ...]:
    """The catalog fields this model provides, in catalog order."""
    unknown = sorted(set(provided) - set(catalog))
    if unknown:
        raise ConfigError(f"model {model_id}: fields not in fields.json: {unknown}")
    for fid, spec in provided.items():
        if needs_search != ("search" in spec):
            raise ConfigError(
                f"model {model_id}.{fid}: " + ("a Herbie source needs a search regex" if needs_search
                                               else "only Herbie sources take a search regex")
            )
    return tuple(
        FieldSpec(
            id=fid,
            label=label,
            search=provided[fid].get("search"),
            min_fhr=int(provided[fid].get("min_fhr", 0)),
            bands=bands,
        )
        for fid, (label, bands) in catalog.items()
        if fid in provided
    )


def _validate_field(fid: str, bands: tuple[Band, ...]) -> None:
    if not _ID_RE.match(fid):
        raise ConfigError(f"field id {fid!r} must match {_ID_RE.pattern}")
    if not bands:
        raise ConfigError(f"field {fid} has no bands")
    if len({b.name for b in bands}) != len(bands):
        raise ConfigError(f"field {fid} has duplicate band names")
    for b in bands:
        where = f"{fid}.{b.name}"
        if b.dtype not in DTYPES:
            raise ConfigError(f"{where}: dtype must be one of {sorted(DTYPES)}")
        if b.scale <= 0:
            raise ConfigError(f"{where}: scale must be positive")
        if b.wrap is not None and b.offset != 0:
            raise ConfigError(f"{where}: wrapped bands must have offset 0")
        if b.nodata is not None:
            if b.nodata != DTYPES[b.dtype]:
                raise ConfigError(f"{where}: nodata must be the dtype's top value, {DTYPES[b.dtype]}")
            if b.wrap is not None and round(b.wrap / b.scale) > b.nodata:
                raise ConfigError(
                    f"{where}: a wrapped band uses {round(b.wrap / b.scale)} codes, so none is free for nodata"
                )


def _validate_grid(grid: Grid) -> None:
    if not _ID_RE.match(grid.id):
        raise ConfigError(f"grid id {grid.id!r} must match {_ID_RE.pattern}")
    if not (-90 <= grid.lat_min < grid.lat_max <= 90):
        raise ConfigError(f"grid {grid.id}: latitudes must satisfy -90 <= lat_min < lat_max <= 90")
    if not (grid.lon_min < grid.lon_max and grid.lon_max - grid.lon_min < 360):
        raise ConfigError(f"grid {grid.id}: longitudes must satisfy lon_min < lon_max, span < 360")
    grid.nx, grid.ny  # raises if not on the resolution grid


def _validate_product(product: Product) -> None:
    pid = product.id
    for kind, ident in (("model", product.model.id), ("product", pid)):
        if not _PRODUCT_ID_RE.match(ident):
            raise ConfigError(f"{kind} id {ident!r} must match {_PRODUCT_ID_RE.pattern}")
    if not product.lags:
        raise ConfigError(f"{pid}: lags_hours must not be empty")
    if product.default_lag not in product.lags:
        raise ConfigError(f"{pid}: default_lag_hours must be one of lags_hours")
    if product.fhr_step <= 0 or (product.fhr_max - product.fhr_min) % product.fhr_step:
        raise ConfigError(f"{pid}: forecast_hours max-min must be a multiple of step")
    if product.model_max < product.fhr_max:
        raise ConfigError(f"{pid}: forecast_hours model_max must be at least max")
    if product.model.max_connections is not None and product.model.max_connections < 1:
        raise ConfigError(f"{pid}: max_connections must be at least 1")
    try:
        product.model.index_url_for(datetime(2026, 1, 1, 12), product.fhr_step)
    except (KeyError, IndexError, ValueError) as e:
        raise ConfigError(f"{pid}: bad index_url template ({e}); it may use {{init:...}} and {{fhr}}") from e
    for lag in product.lags:
        if lag <= 0 or lag % product.cycle_interval_hours or lag % product.fhr_step:
            raise ConfigError(
                f"{pid}: lag {lag} must be positive and a multiple of both the cycle "
                f"interval ({product.cycle_interval_hours} h) and the forecast-hour "
                f"step ({product.fhr_step} h)"
            )
    if not product.fields:
        raise ConfigError(f"{pid}: the model must provide at least one field")
    for f in product.fields:
        if f.search is None:
            continue
        try:
            f.search_for(product.fhr_step, product.fhr_step)
        except (KeyError, IndexError, ValueError) as e:
            raise ConfigError(f"{pid}.{f.id}: bad search template ({e}); escape literal braces as {{{{ }}}}") from e
