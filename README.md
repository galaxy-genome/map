# Galaxy Genome Map

An unofficial map of every reachable star system in
[Galaxy Genome](https://play.google.com/store/apps/details?id=com.skvgames.GalaxyGenome),
the space sim by SKV Games. Pan and zoom, hover a system for its ores, planets
and stations, and plan a route at your ship's jump range.

**[Open the map](https://galaxy-genome.github.io/map/)**

Published with the developer's permission. Galaxy Genome and all of its data
belong to SKV Games.

## What it shows

- **The whole galaxy** — the 5,340 catalogued systems, and the millions the game
  generates around them, produced in your browser from the same seeds it uses
- **Ores** — all three minerals in every asteroid belt, with percentages
- **Planets** — type, scan value, and whether you can land
- **Stations** — which modules each one sells, and at what grade
- **Routes** — fewest jumps between any two systems at your jump range, warp gates
  included, across the whole galaxy rather than the catalogue alone
- **Five languages**, using the game's own words

A **spoilers** switch hides the things the game means you to discover: named
landmarks, warp gates, engineer postings and expedition targets. It is off by
default.

## Translations

Every string the map shows comes from `docs/data/lang/`, one file per language.
Fixing a translation is a one-file pull request — no code, no build step:

```json
{
  "strings": { "GoodsAlexandrite": "Александрит" },
  "ui":      { "mining": "Добыча" }
}
```

`strings` are the game's own keys, taken from its language files. `ui` is this
map's own wording. A key that is missing falls back to English, so a partial
translation still reads.

Run `python3 src/check_lang.py` before opening a pull request. CI runs it too:
malformed JSON, an unknown key, or a placeholder that does not match English
will fail the check. Missing keys are only a warning.

## The data

`docs/data/galaxy.json` holds every system, belt, station and route the map draws.
It is generated from the game's own files, which are not in this repository.

The numbers reproduce the game's own generator: the same seeded sequence, cell by
cell, so a system holds what it holds in game. Ore composition was checked against
54 belts recorded in game and 52 match exactly, and generated system names and
positions were checked against in-game readings around Rakdos.

Planet listings are the least verified part. Treat belt data as reliable and
planet layouts as a good estimate.

## Licence

The code is MIT. The game data is not ours to license: it belongs to SKV Games
and is published here with their permission.
