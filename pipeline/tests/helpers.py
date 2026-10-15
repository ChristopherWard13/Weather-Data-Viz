import numpy as np

from wxtrend.cycles import cycle_id
from wxtrend.store import encode_frame, gzip_frame


def physical(product, field_id, fill=0.0):
    """Band values for a field, filled with a constant (in physical units)."""
    shape = (product.grid.ny, product.grid.nx)
    f = product.field(field_id)
    return {b.name: np.full(shape, fill if b.wrap is None else 0.0) for b in f.bands}


def frame(product, field_id, fill=0.0):
    """One frame's gzip bytes, its bands filled with a constant."""
    shape = (product.grid.ny, product.grid.nx)
    return gzip_frame(encode_frame(product.field(field_id), physical(product, field_id, fill), shape))


def write(store, product, run_id, field_id, fhr, fill=0.0):
    """Stage a frame in a local store (packed into a run file by the next update or repack)."""
    return store.stage_frame(run_id, field_id, fhr, frame(product, field_id, fill))


def write_legacy(store, product, run_id, field_id, fhr, fill=0.0):
    """A frame in the schema-3 layout: one file per frame."""
    path = store.legacy_path(run_id, field_id, fhr)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(frame(product, field_id, fill))
    return path


def listing(store, product):
    """The product's frames in a local store."""
    return store.listing([f.id for f in product.fields])


def always(url):
    return True


class FakeFetch:
    """Stands in for fetch_hour: records calls, returns constant fields."""

    def __init__(self, fail=(), gone=()):
        self.calls = []
        self.fail = set(fail)
        self.gone = set(gone)  # (run, fhr) the source doesn't have

    def __call__(self, product, init, fhr, field_ids, work_dir):
        self.calls.append((cycle_id(init), fhr, tuple(field_ids)))
        if (cycle_id(init), fhr) in self.fail:
            raise RuntimeError("boom")
        if (cycle_id(init), fhr) in self.gone:
            from wxtrend.fetch import NotPublished

            raise NotPublished("404")
        return {fid: physical(product, fid, fill=fhr % 200) for fid in field_ids}

    def hours(self):
        return [(r, f) for r, f, _ in self.calls]


def no_sleep(_):
    pass
