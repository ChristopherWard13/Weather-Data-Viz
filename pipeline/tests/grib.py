"""Tiny synthetic GRIB2 messages for adapter tests, built with ecCodes.

Messages are on a global grid, north to south: by default the 0.25° grid most
sources use (721 x 1440), or another spacing (``res=0.5`` for GEFS). Constant
fields pack to about 200 bytes; a varying 0.25° field is about 2 MB.
"""

from __future__ import annotations

import json

import numpy as np

NY, NX = 721, 1440
LATS = np.linspace(90, -90, NY)
LONS = np.arange(NX) * 0.25 - 180  # -180 .. 179.75, as ECMWF publishes


def lats_for(res: float) -> np.ndarray:
    return np.linspace(90, -90, int(round(180 / res)) + 1)


def message(short: str, type_of_level: str, level: float | None, values, *, step: int = 6,
            start_step: int | None = None, centre: int = 98, res: float = 0.25) -> bytes:
    """One GRIB2 message. ``start_step`` makes it an accumulation/max over start_step-step."""
    import eccodes

    ny, nx = int(round(180 / res)) + 1, int(round(360 / res))
    h = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    try:
        eccodes.codes_set(h, "centre", centre)
        for k, v in {
            "Ni": nx, "Nj": ny,
            "latitudeOfFirstGridPointInDegrees": 90, "longitudeOfFirstGridPointInDegrees": 180,
            "latitudeOfLastGridPointInDegrees": -90, "longitudeOfLastGridPointInDegrees": 180 - res,
            "iDirectionIncrementInDegrees": res, "jDirectionIncrementInDegrees": res,
            "dataDate": 20261009, "dataTime": 0,
        }.items():
            eccodes.codes_set(h, k, v)
        eccodes.codes_set(h, "typeOfLevel", type_of_level)
        if level is not None:
            eccodes.codes_set(h, "level", level)
        eccodes.codes_set(h, "shortName", short)
        if start_step is not None:
            eccodes.codes_set(h, "stepRange", f"{start_step}-{step}")
        else:
            eccodes.codes_set(h, "step", step)
        eccodes.codes_set(h, "bitsPerValue", 16)
        values = np.broadcast_to(np.asarray(values, dtype=np.float64), (ny, nx))
        eccodes.codes_set_values(h, np.ascontiguousarray(values).ravel())
        return eccodes.codes_get_message(h)
    finally:
        eccodes.codes_release(h)


def eccodes_index(messages: list[tuple[dict, bytes]], step: int) -> tuple[str, bytes]:
    """(index text, file bytes) for messages given as ({param, levtype, levelist?}, bytes)."""
    lines, blob, offset = [], b"", 0
    for keys, data in messages:
        row = {"domain": "g", "date": "20261009", "time": "0000", "expver": "0001", "class": "od",
               "type": "fc", "stream": "oper", "step": str(step), **keys,
               "_offset": offset, "_length": len(data)}
        lines.append(json.dumps(row))
        blob += data
        offset += len(data)
    return "\n".join(lines) + "\n", blob


def wgrib2_index(messages: list[tuple[str, bytes]], init: str = "2026100900") -> tuple[str, bytes]:
    """(.idx text, file bytes) for messages given as ("VAR:level:time:", bytes), as NCEP publishes them."""
    lines, blob = [], b""
    for i, (desc, data) in enumerate(messages, 1):
        lines.append(f"{i}:{len(blob)}:d={init}:{desc}")
        blob += data
    return "\n".join(lines) + "\n", blob
