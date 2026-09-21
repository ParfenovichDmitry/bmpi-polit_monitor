"""GDELT GKG 2.1 collector.

Downloads the 15-minute GKG files (English and Translingual streams), keeps only
records that mention a configured actor, and appends them to a per-campaign store.
Matching reproduces the research pipeline used in the article:
  * search text = GKG fields 5-14, 23, 24 (counts, themes, locations, persons,
    organizations, all names, amounts), lower-cased, Polish diacritics folded;
  * an actor matches when any of its keywords is a substring of the search text;
  * the English stream is restricted to a whitelist of US domestic outlets;
  * tone = first element of V2Tone (field 15).
"""
from __future__ import annotations

import io
import re
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

import pandas as pd
import requests

SEARCH_FIELDS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 23, 24]
URL_COL, SOURCE_COL, TONE_COL, TRANSLATION_COL = 4, 3, 15, 25
FOLD = str.maketrans({"ą": "a", "ć": "c", "ę": "e", "ł": "l", "ń": "n", "ó": "o", "ś": "s", "ż": "z", "ź": "z"})
STREAM_SUFFIX = {"english": ".gkg.csv.zip", "translation": ".translation.gkg.csv.zip"}


def norm(s: str) -> str:
    return s.lower().translate(FOLD)


def intervals(day: date) -> list[datetime]:
    start = datetime(day.year, day.month, day.day)
    return [start + timedelta(minutes=15 * i) for i in range(96)]


def stamp(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H%M%S")


class Matcher:
    def __init__(self, campaign: dict, domains: set[str] | None):
        self.actors = [a["id"] for a in campaign["actors"]]
        self.patterns = {
            a["id"]: re.compile("|".join(re.escape(norm(k)) for k in a["keywords"]))
            for a in campaign["actors"]
        }
        self.domains = domains

    def domain_ok(self, dom: pd.Series) -> pd.Series:
        if self.domains is None:
            return pd.Series(True, index=dom.index)
        d = dom.str.replace(r"^www\.", "", regex=True)
        return d.apply(lambda x: any(x == b or x.endswith("." + b) for b in self.domains))


def _domain(url: pd.Series) -> pd.Series:
    return url.fillna("").str.replace(r"^https?://", "", regex=True).str.split("/").str[0].str.lower()


def fetch(url: str, timeout: int, retries: int) -> bytes | None:
    """Return the file content, or None when GDELT answers 404 (file not published)."""
    last = None
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(url, timeout=timeout)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.content
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(2.0 * attempt)
    raise RuntimeError(f"failed after {retries} attempts: {last}")


def read_gkg(content: bytes) -> pd.DataFrame:
    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        name = zf.namelist()[0]
        raw = zf.read(name)
    for enc in ("utf-8", "latin1"):
        try:
            return pd.read_csv(io.BytesIO(raw), sep="\t", header=None, dtype=str, quoting=3,
                               encoding=enc, on_bad_lines="skip")
        except UnicodeDecodeError:
            continue
    return pd.DataFrame()


def extract(df: pd.DataFrame, dt: datetime, stream: str, m: Matcher) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()
    cols = [c for c in SEARCH_FIELDS if c in df.columns]
    text = df[cols].fillna("").agg(" ".join, axis=1).map(norm)
    url = df[URL_COL].fillna("") if URL_COL in df.columns else pd.Series("", index=df.index)
    dom = _domain(url)
    if SOURCE_COL in df.columns:
        dom = dom.where(dom != "", _domain(df[SOURCE_COL]))
    keep_dom = m.domain_ok(dom)
    tone = pd.to_numeric(df[TONE_COL].fillna("").str.split(",").str[0], errors="coerce") \
        if TONE_COL in df.columns else pd.Series(float("nan"), index=df.index)
    lang = ""
    if stream == "translation" and TRANSLATION_COL in df.columns:
        lang = df[TRANSLATION_COL].fillna("").str.extract(r"srclc:([^;]*)")[0].fillna("")
    out = []
    for actor in m.actors:
        hit = text.str.contains(m.patterns[actor], regex=True) & keep_dom
        if not hit.any():
            continue
        part = pd.DataFrame({
            "date": dt.date().isoformat(),
            "datetime_15m": dt.strftime("%Y-%m-%d %H:%M:%S"),
            "candidate": actor,
            "url": url[hit].values,
            "domain": dom[hit].values,
            "tone": tone[hit].values,
            "gkg_stamp": stamp(dt),
        })
        if stream == "translation":
            part["source_language"] = lang[hit].values if isinstance(lang, pd.Series) else ""
        out.append(part)
    if not out:
        return pd.DataFrame()
    return pd.concat(out, ignore_index=True).drop_duplicates(subset=["datetime_15m", "candidate", "url"])


def collect_interval(dt: datetime, stream: str, m: Matcher, cfg: dict) -> tuple[str, str, pd.DataFrame]:
    url = f"{cfg['base_url']}/{stamp(dt)}{STREAM_SUFFIX[stream]}"
    try:
        content = fetch(url, cfg["timeout"], cfg["retries"])
        if content is None:
            return stamp(dt), "NOTFOUND", pd.DataFrame()
        return stamp(dt), "OK", extract(read_gkg(content), dt, stream, m)
    except Exception as exc:  # noqa: BLE001
        return stamp(dt), f"ERROR: {type(exc).__name__}", pd.DataFrame()


def collect_many(dts: list[datetime], stream: str, m: Matcher, cfg: dict):
    with ThreadPoolExecutor(max_workers=cfg.get("workers", 4)) as ex:
        yield from ex.map(lambda d: collect_interval(d, stream, m, cfg), dts)
