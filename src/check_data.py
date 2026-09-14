#!/usr/bin/env python3
"""Sanity-check the published map data, so a broken export cannot reach the site."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "docs", "data", "galaxy.json")


def main():
    d = json.load(open(DATA, encoding="utf-8"))
    errors = []

    def need(cond, message):
        if not cond:
            errors.append(message)

    need(len(d["systems"]) > 5000, "too few systems")
    need(len(d["types"]) == len(d["palette"]) == len(d["typeKeys"]),
         "star type, palette and key lists disagree in length")
    need(len(d["ores"]) == len(d["oreKeys"]) == len(d["oreMin"]),
         "ore lists disagree in length")
    need(len(d["modules"]) == len(d["moduleKeys"]), "module lists disagree in length")

    names = {s[0] for s in d["systems"]}
    for a, b in d["gates"]:
        need(a in names and b in names, f"warp gate references unknown system: {a} / {b}")
    for label, index, kind in d["aliases"]:
        need(0 <= index < len(d["systems"]), f"alias '{label}' points outside the systems list")

    SCAN, STARV, PB, ST = 12, 20, 21, 10
    for s in d["systems"]:
        need(len(s) == 23, f"system row for {s[0]} has {len(s)} fields, expected 23")
        break

    # A system is worth its stars plus its planets, and a pre-explored one is
    # worth nothing at all. Every consumer derives both halves from these, so a
    # row that breaks the relation breaks the tooltips and the filters alike.
    for s in d["systems"]:
        need(s[STARV] <= s[SCAN],
             f"{s[0]}: star value {s[STARV]} exceeds the system total {s[SCAN]}")
        need(len(s[PB]) % 2 == 0, f"{s[0]}: planet payload is not orbit/value pairs")
        need(s[SCAN] or not (s[STARV] or s[PB]),
             f"{s[0]} is explored but still carries value")
        need(bool(s[ST]) == (s[0] in d["stations"]),
             f"{s[0]}: station count and station list disagree")

    need(len(d["purposeStock"]) == len(d["purposes"]),
         "purpose stock lists disagree with the purpose list")
    need(len(d["sectorBounds"]) == len(d["sectorAnchors"]["sectors"]),
         "sector bounds and sector names disagree")
    need(len(d["scanners"]) >= 2, "scanner table is missing")

    belts = sum(1 for s in d["systems"] if s[8])
    print(f"{len(d['systems']):,} systems, {belts:,} with belts, "
          f"{len(d['aliases']):,} aliases, {len(d['gates'])} warp gates")
    for e in errors:
        print(f"  ✗ {e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
