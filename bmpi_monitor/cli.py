"""Command line: seed | collect | compute | run.

  python -m bmpi_monitor.cli run            # collect missing GDELT intervals, recompute, write docs/data
  python -m bmpi_monitor.cli collect --max-days 3
  python -m bmpi_monitor.cli compute
  python -m bmpi_monitor.cli seed --campaign usa-congress-2026 --dir seed/
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yaml

from . import gdelt, method
from .store import Store

ROOT = Path(__file__).resolve().parent.parent
log = logging.getLogger("bmpi")


def load_config(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    return cfg


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def last_collect_day(c: dict) -> date:
    el = date.fromisoformat(c["election_date"])
    return min(utc_today() - timedelta(days=1), el - timedelta(days=1))


def domains(c: dict) -> set[str] | None:
    p = c.get("english_domain_whitelist")
    if not p:
        return None
    lines = (ROOT / p).read_text(encoding="utf-8").splitlines()
    return {x.strip().lower() for x in lines if x.strip() and not x.startswith("#")}


# --------------------------------------------------------------------------- seed
def cmd_seed(cfg, args):
    c = next(x for x in cfg["campaigns"] if x["id"] == args.campaign)
    st = Store(ROOT / "data", c["id"])
    for s in c["streams"]:
        m = Path(args.dir) / f"mentions_{s}.csv.gz"
        if m.exists():
            d = pd.read_csv(m, dtype={"gkg_stamp": str})
            st.add_mentions(s, d)
            log.info("seed %s: %d mentions", s, len(d))
        sp = Path(args.dir) / f"state_{s}.csv"
        if sp.exists():  # research-pipeline state is per day: expand fully-OK days to 96 intervals
            old = pd.read_csv(sp)
            rows = []
            for _, r in old[old.status == "OK"].iterrows():
                for dt in gdelt.intervals(date.fromisoformat(r["date"])):
                    rows.append((gdelt.stamp(dt), "OK", 0))
            st.set_state(s, rows)
            log.info("seed %s: %d intervals marked OK", s, len(rows))


# --------------------------------------------------------------------------- collect
def pending(st: Store, stream: str, c: dict, give_up: int) -> list[datetime]:
    state = st.state(stream)
    done = set(state.loc[state.status.isin(["OK", "MISSING"]), "stamp"])
    out = []
    d = date.fromisoformat(c["data_start"])
    last = last_collect_day(c)
    while d <= last:
        out += [dt for dt in gdelt.intervals(d) if gdelt.stamp(dt) not in done]
        d += timedelta(days=1)
    return out


def cmd_collect(cfg, args):
    g = cfg["gdelt"]
    for c in cfg["campaigns"]:
        if not c.get("active", True) or (args.campaign and c["id"] != args.campaign):
            continue
        st = Store(ROOT / "data", c["id"])
        for s in c["streams"]:
            m = gdelt.Matcher(c, domains(c) if s == "english" else None)
            todo = pending(st, s, c, g["give_up_after_days"])
            if args.max_days:
                days = sorted({dt.date() for dt in todo})[: args.max_days]
                todo = [dt for dt in todo if dt.date() in days]
            log.info("%s/%s: %d intervals to fetch", c["id"], s, len(todo))
            # process day by day so progress is saved
            by_day: dict[date, list[datetime]] = {}
            for dt in todo:
                by_day.setdefault(dt.date(), []).append(dt)
            for day, dts in sorted(by_day.items()):
                t0 = time.time()
                states, frames = [], []
                for stamp, status, df in gdelt.collect_many(dts, s, m, g):
                    if status == "NOTFOUND":
                        age = (utc_today() - day).days
                        status = "MISSING" if age > g["give_up_after_days"] else "NOTFOUND"
                    states.append((stamp, status, len(df)))
                    if len(df):
                        frames.append(df)
                if frames:
                    st.add_mentions(s, pd.concat(frames, ignore_index=True))
                st.set_state(s, states)
                ok = sum(1 for x in states if x[1] == "OK")
                log.info("  %s %s: %d/%d intervals OK, %d mentions, %.0fs", s, day, ok, len(states),
                         sum(x[2] for x in states), time.time() - t0)


# --------------------------------------------------------------------------- compute
def last_complete_day(st: Store, streams: list[str], c: dict) -> date | None:
    ends = []
    for s in streams:
        state = st.state(s)
        if state.empty:
            return None
        state = state[state.status.isin(["OK", "MISSING"])]
        per_day = state.stamp.str[:8].value_counts()
        full = sorted(d for d, n in per_day.items() if n >= 90)
        if not full:
            return None
        ends.append(datetime.strptime(full[-1], "%Y%m%d").date())
    return min(ends)


def missing_share(st: Store, streams: list[str], d0: date, d1: date) -> dict:
    out = {}
    exp = ((d1 - d0).days + 1) * 96
    for s in streams:
        state = st.state(s)
        day = pd.to_datetime(state.stamp.str[:8], format="%Y%m%d").dt.date if len(state) else pd.Series([], dtype=object)
        ok = int(((state.status == "OK") & (day >= d0) & (day <= d1)).sum()) if len(state) else 0
        out[s] = round(100 * (1 - ok / exp), 2) if exp > 0 else None
    return out


def cmd_compute(cfg, args):
    out_dir = ROOT / "docs" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    index = []
    for c in cfg["campaigns"]:
        if args.campaign and c["id"] != args.campaign:
            continue
        st = Store(ROOT / "data", c["id"])
        end = last_complete_day(st, c["streams"], c)
        if end is None:
            log.warning("%s: no complete day yet, skipped", c["id"])
            continue
        ment = {s: st.mentions(s) for s in c["streams"]}
        t0 = time.time()
        res = method.analyse(ment, c, cfg["method"], pd.Timestamp(end))
        last = date.fromisoformat(res["window"][1])
        el = date.fromisoformat(c["election_date"])
        payload = dict(
            generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            campaign=dict(id=c["id"], name=c["name"], election_date=c["election_date"],
                          data_start=c["data_start"], window_start=c["window_start"],
                          favourite=c["favorite"],
                          actors=[{k: a[k] for k in ("id", "label", "color", "color_dark")} for a in c["actors"]]),
            last_data_day=str(last), days_to_election=(el - utc_today()).days,
            missing_pct=missing_share(st, c["streams"], date.fromisoformat(c["data_start"]), last),
            method=cfg["method"], **res)
        (out_dir / f"{c['id']}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        # history of headline numbers, one row per data day
        hp = out_dir / f"{c['id']}_history.json"
        hist = json.loads(hp.read_text(encoding="utf-8")) if hp.exists() else []
        hist = [h for h in hist if h["last_data_day"] != str(last)]
        hist.append(dict(last_data_day=str(last), cp_date=res["changepoint"]["date"], t=res["changepoint"]["t"],
                         p=res["changepoint"]["p"], favours=res["changepoint"]["favours"],
                         level=res["level"]["value"], D10=res["ddm"]["D_to_counter"], M10=res["ddm"]["M_to_counter"],
                         typology=res["ddm"]["typology"]))
        hist.sort(key=lambda h: h["last_data_day"])
        hp.write_text(json.dumps(hist, ensure_ascii=False, indent=1), encoding="utf-8")
        index.append(dict(id=c["id"], name=c["name"], election_date=c["election_date"], last_data_day=str(last),
                          active=c.get("active", True)))
        log.info("%s: computed through %s in %.0fs (p=%.3f, %s)", c["id"], last, time.time() - t0,
                 res["changepoint"]["p"], res["ddm"]["typology"])
    site = cfg.get("site", {})
    (out_dir / "index.json").write_text(json.dumps(dict(site=site, campaigns=index,
                                         generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")),
                                         ensure_ascii=False, indent=1), encoding="utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="bmpi_monitor")
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--campaign")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("seed"); s.add_argument("--dir", required=True)
    s = sub.add_parser("collect"); s.add_argument("--max-days", type=int, default=0)
    sub.add_parser("compute")
    s = sub.add_parser("run"); s.add_argument("--max-days", type=int, default=0)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    cfg = load_config(Path(args.config))
    if args.cmd == "seed":
        if not args.campaign:
            ap.error("seed needs --campaign")
        cmd_seed(cfg, args)
    elif args.cmd == "collect":
        cmd_collect(cfg, args)
    elif args.cmd == "compute":
        cmd_compute(cfg, args)
    elif args.cmd == "run":
        cmd_collect(cfg, args)
        cmd_compute(cfg, args)


if __name__ == "__main__":
    main()
