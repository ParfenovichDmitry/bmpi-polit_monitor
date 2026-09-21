# BMPI Election Monitor

A small bot that collects GDELT GKG 2.1 news metadata for an election campaign every day,
computes the BMPI media-pressure diagnostics from the article *“Hidden media reversal in election campaigns”*,
and publishes a dashboard to GitHub Pages.

```
server (daily, systemd timer)                         GitHub
┌──────────────────────────────────────────┐          ┌──────────────────────────┐
│ collect  GDELT 15-min GKG files (EN + TR) │          │ repo: docs/  ──► Pages    │
│ compute  pBMPI, ΔpBMPI, change point,    │ git push │ index.html + app.js       │
│          ΔD/ΔM, typology, H4, sensitivity├─────────►│ data/<campaign>.json      │
│ store    data/<campaign>/ (server only)  │          │ data/<campaign>_history   │
└──────────────────────────────────────────┘          └──────────────────────────┘
```

## What is in the repository

| Path | Purpose |
|---|---|
| `config.yaml` | campaigns, actors, keywords, poll favourite, method parameters |
| `us_domains.txt` | whitelist of US domestic outlets for the English stream |
| `bmpi_monitor/gdelt.py` | downloads and filters 15-minute GKG files |
| `bmpi_monitor/method.py` | the statistical protocol (primary specification of the article) |
| `bmpi_monitor/cli.py` | `seed`, `collect`, `compute`, `run` commands |
| `docs/` | the static website served by GitHub Pages (tabs: Overview · Charts · Details · How to read; no build step, no external scripts) |
| `seed/` | mentions already collected for US Congress 2026 (Jun 1 – Sep 19, 2026) |
| `deploy/` | install script, daily job, systemd service and timer |

Raw collected data (`data/`) stays on the server and is not committed; only `docs/data/*.json` is published.

## Setup

### 1. GitHub repository and Pages

1. Create a **public** repository, e.g. `bmpi-monitor`, and push this folder to it:
   ```bash
   git init && git add . && git commit -m "BMPI monitor"
   git branch -M main
   git remote add origin git@github.com:<you>/bmpi-monitor.git
   git push -u origin main
   ```
2. In the repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   branch `main`, folder `/docs`. The site appears at `https://<you>.github.io/bmpi-monitor/`.
3. Optional: put that repository URL in `config.yaml → site.repo_url` (adds a “source code” link).

### 2. Server (Ubuntu / Debian)

1. Create a user and a deploy key that can push to the repository:
   ```bash
   sudo adduser --disabled-password bmpi
   sudo -iu bmpi
   ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
   cat ~/.ssh/id_ed25519.pub
   ```
   Add the printed key in GitHub: **Settings → Deploy keys → Add deploy key**, tick **Allow write access**.
2. Clone and install (as `bmpi`):
   ```bash
   git clone git@github.com:<you>/bmpi-monitor.git
   cd bmpi-monitor
   git config user.name "bmpi-bot" && git config user.email "bmpi-bot@users.noreply.github.com"
   ./deploy/install.sh          # creates .venv, installs packages, imports seed/ history
   ./deploy/run_daily.sh        # first run: backfills from Sep 20, computes, pushes
   ```
   The first run downloads every missing day (2 × 96 files per day). Each GDELT file is downloaded,
   filtered in memory and discarded; only matched rows are kept. Backfill time depends on bandwidth.
3. Schedule the daily job (as root):
   ```bash
   sudo cp deploy/bmpi-monitor.service deploy/bmpi-monitor.timer /etc/systemd/system/
   sudo nano /etc/systemd/system/bmpi-monitor.service     # check User= and paths
   sudo systemctl daemon-reload
   sudo systemctl enable --now bmpi-monitor.timer
   systemctl list-timers bmpi-monitor.timer                # next run
   journalctl -u bmpi-monitor -n 100                       # logs of the last run
   ```
   The job runs at 03:30 UTC, when the previous UTC day is complete in GDELT.
   `Persistent=true` makes it catch up after the server was off.

The server needs outbound HTTP access to `data.gdeltproject.org` and SSH access to `github.com`.

## Daily operation

- `run_daily.sh` = `collect` (all missing 15-minute intervals up to yesterday) → `compute` → commit and push `docs/data`.
- Failed downloads are retried on the next run. A file GDELT never published (404 for more than 2 days) is recorded as `MISSING`;
  the page shows the share of missing intervals per stream.
- Manual commands:
  ```bash
  source .venv/bin/activate
  python -m bmpi_monitor.cli collect --max-days 3     # limit a backfill
  python -m bmpi_monitor.cli compute                  # recompute from stored data
  python -m bmpi_monitor.cli --campaign usa-congress-2026 run
  ```
- Collection stops the day before the election. The last computation is the confirmatory reading of the campaign.

## Updating the poll favourite

The favourite is part of the method (it orients ΔD, ΔM and H4) and is **set by hand** in `config.yaml → favorite`,
following the article’s rule: mean of public polls in the 30 days before the end of the window.
Update `value`, `source` and `as_of`, commit and push; the next run uses it.

## Adding a campaign

Copy the campaign block in `config.yaml` and set:

- `id`, `name`, `election_date`;
- `data_start` (at least 30 days before `window_start`, for the z-score warm-up) and `window_start`;
- two `actors` with `label`, colours and `keywords` (matched as lower-case substrings in the GKG
  themes / persons / organisations / names fields; Polish diacritics are folded);
- `streams` and, for the English stream, an optional `english_domain_whitelist` (omit it to use all English sources);
- `favorite` from polls.

Set `active: false` on a finished campaign: it stays on the site but is no longer collected.

## Method summary

| Step | Definition |
|---|---|
| Tone | mean GDELT tone of the day’s matched articles per actor (duplicate URLs removed) |
| pBMPI | `L = 1/(1+e^z)`, `z` = rolling z-score of tone, W = 30 days, ≥ 15 obs, clipped ±4 |
| Field balance | `ΔpBMPI = −(L_A − L_B)` |
| Change point (H1) | max \|t\| mean shift, 20 % trimming; p from moving-block bootstrap (B = 1999) calibrated by 300 AR(1) surrogates; 95 % CI of the date from a residual block bootstrap |
| Direction / pressure | `ΔD = z_A − z_B`, `ΔM = \|z_A\| − \|z_B\|`, 10-day means oriented to the counter-candidate |
| Typology | full reversal / quiet challenge / tonal shift without pressure / consolidation |
| Upset signal (H4) | ΔM towards the counter-candidate over the 10 days before election day, > 0 = signal |
| Stream rule | min/max mention ratio per stream; < 0.10 unusable; usable streams are combined |

The page recomputes the change-point test every day on a growing window. Repeatedly checking a p-value inflates false alarms:
intermediate values are descriptive, and the confirmatory test is the one on the complete window.
