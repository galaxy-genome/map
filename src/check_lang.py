#!/usr/bin/env python3
"""Validate the language files. Run in CI so a bad translation fails the pull
request instead of the site.

    python3 src/check_lang.py            # check every language
    python3 src/check_lang.py ru         # check one
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LANG_DIR = os.path.join(HERE, "..", "docs", "data", "lang")
BASE = "en"
PLACEHOLDER = re.compile(r"\{(\w+)\}")


def load(code):
    with open(os.path.join(LANG_DIR, f"{code}.json"), encoding="utf-8") as f:
        return json.load(f)


def check(code, base):
    """Returns (errors, warnings).

    An error is something a contributor did wrong and must fix. A gap in
    coverage is a warning: the game's own Spanish file is short of keys, and
    that is not a reason to reject a pull request.
    """
    problems, warnings = [], []
    try:
        data = load(code)
    except json.JSONDecodeError as e:
        return [f"{code}.json is not valid JSON: {e}"], []
    except FileNotFoundError:
        return [f"{code}.json is missing"], []

    for section in ("strings", "ui"):
        if section not in data:
            problems.append(f"{code}: no '{section}' section")
            continue
        missing = sorted(set(base[section]) - set(data[section]))
        if missing:
            warnings.append(
                f"{len(missing)} {section} keys fall back to English, "
                f"e.g. {', '.join(missing[:4])}")
        for key, text in data[section].items():
            if key not in base[section]:
                problems.append(f"{code}: unknown key '{key}' in {section}")
                continue
            if not text.strip():
                problems.append(f"{code}: '{key}' is empty")
            want = set(PLACEHOLDER.findall(base[section][key]))
            got = set(PLACEHOLDER.findall(text))
            if want != got:
                problems.append(
                    f"{code}: '{key}' placeholders {sorted(got) or 'none'} "
                    f"do not match English {sorted(want) or 'none'}")
    return problems, warnings


def main(argv):
    base = load(BASE)
    codes = argv[1:] or [f[:-5] for f in sorted(os.listdir(LANG_DIR))
                         if f.endswith(".json")]
    failed = False
    for code in codes:
        problems, warnings = check(code, base) if code != BASE else ([], [])
        data = load(code)
        have = len(data.get("strings", {})) + len(data.get("ui", {}))
        total = len(base["strings"]) + len(base["ui"])
        pct = 100 * have / total
        print(f"{code}: {have}/{total} keys ({pct:.0f}%)")
        for w in warnings:
            print(f"  · {w}")
        for p in problems:
            print(f"  ✗ {p}")
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
