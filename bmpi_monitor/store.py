"""On-disk store: one folder per campaign with mentions and per-interval download state."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

MENTION_COLS = ["date", "datetime_15m", "candidate", "url", "domain", "tone", "gkg_stamp", "source_language"]
STATE_COLS = ["stamp", "status", "rows", "updated_at"]


class Store:
    def __init__(self, root: Path, campaign_id: str):
        self.dir = Path(root) / campaign_id
        self.dir.mkdir(parents=True, exist_ok=True)

    def mentions_path(self, stream: str) -> Path:
        return self.dir / f"mentions_{stream}.csv.gz"

    def state_path(self, stream: str) -> Path:
        return self.dir / f"state_{stream}.csv"

    # -- mentions -------------------------------------------------------------
    def mentions(self, stream: str) -> pd.DataFrame:
        p = self.mentions_path(stream)
        if not p.exists():
            return pd.DataFrame(columns=MENTION_COLS)
        return pd.read_csv(p, dtype={"gkg_stamp": str})

    def add_mentions(self, stream: str, new: pd.DataFrame) -> None:
        if new is None or new.empty:
            return
        cur = self.mentions(stream)
        out = pd.concat([cur, new], ignore_index=True)
        out = out.drop_duplicates(subset=["datetime_15m", "candidate", "url"], keep="last")
        out = out.sort_values(["datetime_15m", "candidate", "url"])
        tmp = self.mentions_path(stream).with_suffix(".tmp")
        out.to_csv(tmp, index=False, compression="gzip")
        tmp.replace(self.mentions_path(stream))

    # -- state ------------------------------------------------------------------
    def state(self, stream: str) -> pd.DataFrame:
        p = self.state_path(stream)
        if not p.exists():
            return pd.DataFrame(columns=STATE_COLS)
        return pd.read_csv(p, dtype={"stamp": str})

    def set_state(self, stream: str, rows: list[tuple[str, str, int]]) -> None:
        if not rows:
            return
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        new = pd.DataFrame([(s, st, n, now) for s, st, n in rows], columns=STATE_COLS)
        out = pd.concat([self.state(stream), new], ignore_index=True).drop_duplicates("stamp", keep="last")
        out.sort_values("stamp").to_csv(self.state_path(stream), index=False)
