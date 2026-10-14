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
            start_step: int | None = None, centre: int = 98, res: float = 0.25, number: int | None = None) -> bytes:
    """One GRIB2 message. ``start_step`` makes it an accumulation/max over start_step-step;
    ``number`` makes it that perturbed member of a 50-member ensemble."""
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
        if number is not None:
            eccodes.codes_set(h, "productDefinitionTemplateNumber", 11 if start_step is not None else 1)
            eccodes.codes_set(h, "typeOfEnsembleForecast", 3)  # positively perturbed
            eccodes.codes_set(h, "perturbationNumber", number)
            eccodes.codes_set(h, "numberOfForecastsInEnsemble", 50)
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


def file_message(param: tuple[int, int, int], type_of_level: str, level: float | None, values, *, step: int = 6,
                 stat: int | None = None, start_step: int | None = None, res: float | None = 1.5,
                 uuid: str | None = None, cells: int | None = None, run: tuple[int, int] = (20261009, 0),
                 missing: float | None = None) -> bytes:
    """One message as a per-file source publishes it, by WMO parameter (discipline,
    category, number): ``stat`` 1 makes it an accumulation over start_step-step, 2 a
    maximum. On a regular grid scanned south to north from 0°E, as GDPS's is (``res``),
    or with ``uuid`` on an unstructured grid of ``cells`` points, as ICON's is. ``run``
    is its (dataDate, dataTime); values equal to ``missing`` are left out by a bitmap."""
    import eccodes

    if uuid is None:
        h = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
        ny, nx = int(round(180 / res)) + 1, int(round(360 / res))
        for k, v in {
            "Ni": nx, "Nj": ny, "jScansPositively": 1,
            "latitudeOfFirstGridPointInDegrees": -90, "longitudeOfFirstGridPointInDegrees": 0,
            "latitudeOfLastGridPointInDegrees": 90, "longitudeOfLastGridPointInDegrees": 360 - res,
            "iDirectionIncrementInDegrees": res, "jDirectionIncrementInDegrees": res,
        }.items():
            eccodes.codes_set(h, k, v)
        shape = (ny, nx)
    else:
        h = eccodes.codes_grib_new_from_samples("GRIB2")
        eccodes.codes_set(h, "gridDefinitionTemplateNumber", 101)
        eccodes.codes_set(h, "numberOfGridUsed", 26)
        eccodes.codes_set(h, "numberOfGridInReference", 1)
        eccodes.codes_set_string(h, "uuidOfHGrid", uuid)
        shape = (cells,)
    try:
        eccodes.codes_set(h, "dataDate", run[0])
        eccodes.codes_set(h, "dataTime", run[1])
        if stat is not None:
            eccodes.codes_set(h, "productDefinitionTemplateNumber", 8)
            eccodes.codes_set(h, "typeOfStatisticalProcessing", stat)
            eccodes.codes_set(h, "stepRange", f"{start_step if start_step is not None else step - 1}-{step}")
        else:
            eccodes.codes_set(h, "step", step)
        for k, v in zip(("discipline", "parameterCategory", "parameterNumber"), param):
            eccodes.codes_set(h, k, v)
        eccodes.codes_set(h, "typeOfLevel", type_of_level)
        if level is not None:
            eccodes.codes_set(h, "level", level)
        eccodes.codes_set(h, "bitsPerValue", 24)
        if missing is not None:
            eccodes.codes_set(h, "bitmapPresent", 1)
            eccodes.codes_set(h, "missingValue", missing)
        values = np.broadcast_to(np.asarray(values, dtype=np.float64), shape)
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
