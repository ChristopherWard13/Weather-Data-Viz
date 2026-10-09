import numpy as np

from wxtrend.store import encode_frame, gzip_frame


def physical(cfg, field_id, fill=0.0):
    """Band values for a field, filled with a constant (in physical units)."""
    shape = (cfg.domain.ny, cfg.domain.nx)
    f = cfg.field(field_id)
    return {b.name: np.full(shape, fill if b.wrap is None else 0.0) for b in f.bands}


def write(store, cfg, run_id, field_id, fhr, fill=0.0):
    shape = (cfg.domain.ny, cfg.domain.nx)
    gz = gzip_frame(encode_frame(cfg.field(field_id), physical(cfg, field_id, fill), shape))
    return store.write_frame(run_id, field_id, fhr, gz)
