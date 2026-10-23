"""Which fields each daily game shows (build plan G3).

Wx Marks the Spot's reveal colours every station by its value, and Station
ID's clues are station values from the same day. A field shown in both would
let a player look Station ID's answer up on the pin game's map. So the day's
weather is split into families, one quantity each, and the two games never
share one: each day Station ID keeps the high or the low (its first clue, the
one players can place on a map), Wx Marks the Spot draws five of the other
seven, and Station ID uses only the families that the pin game's finished
puzzle didn't show (its dry-day swap can change which, so Station ID reads the
puzzle rather than the draw). The times of the high and low, normals and
records are Station ID's alone; they aren't families.

The day-to-day change is the high minus the day before's, so it never goes
to Station ID, and the pin game draws it only on days Station ID keeps the
low: with the high kept, today's change plus yesterday's pin game high would
rebuild today's highs at every station (the 2026-10-23 review).

The draw is seeded by the date, so a day's split is the same however often
it's made.
"""

from __future__ import annotations

import random
from datetime import date

# Round order in Wx Marks the Spot
FAMILIES = ("high", "low", "gust", "rain", "dew", "wind", "humid", "change")
SPOT_ROUNDS = 5
TEMPERATURES = ("high", "low")
# Days before this keep Wx Marks the Spot's first five rounds (spot.plan_rounds)
FROM = date(2026, 10, 23)

KIND_FAMILY = {
    "hottest": "high", "coolhigh": "high",
    "coldest": "low",
    "gust": "gust",
    "wettest": "rain",
    "muggiest": "dew", "lowdew": "dew",
    "windiest": "wind",
    "lowhumid": "humid",
    "warmup": "change", "cooldown": "change",
}


def station_temperature(day: date) -> str:
    """The temperature family Station ID keeps for ``day``: "high" or "low"."""
    return random.Random(f"temperature:{day.isoformat()}").choice(TEMPERATURES)


def kept_from_spot(day: date) -> set[str]:
    """The families Wx Marks the Spot may not show on ``day``."""
    kept = station_temperature(day)
    return {kept, "change"} if kept == "high" else {kept}


def spot_families(day: date) -> list[str]:
    """The families Wx Marks the Spot draws for ``day``, in round order."""
    pool = [f for f in FAMILIES if f not in kept_from_spot(day)]
    drawn = set(random.Random(f"families:{day.isoformat()}").sample(pool, SPOT_ROUNDS))
    return [f for f in FAMILIES if f in drawn]


def families_shown(spot_puzzle: dict) -> set[str]:
    """The families a finished Wx Marks the Spot puzzle shows."""
    return {KIND_FAMILY[r["kind"]] for r in spot_puzzle["rounds"]}
