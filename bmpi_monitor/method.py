"""BMPI protocol (primary specification of the article).

pBMPI per actor:  L(t) = 1 / (1 + exp(z(t))),  z = rolling z-score of the daily mean GDELT tone
(W = 30 days, >= 15 observations, clipped to +/-4). Higher L = stronger unfavourable media pressure.
Field balance:    ΔpBMPI(t) = -(L_A(t) - L_B(t));  > 0 means the field is tilted in favour of actor A.
Change point:     max |t| of the before/after mean difference (trimmed 20 % at each end);
                  p from a moving-block bootstrap (B = 1999), calibrated against AR(1) surrogates (300);
                  95 % CI of the date from a residual block bootstrap of the two-segment model.
Projections:      ΔD = z_A - z_B (direction of tone), ΔM = |z_A| - |z_B| (pressure / salience),
                  averaged over the last 10 days and oriented towards the counter-candidate.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


# --------------------------------------------------------------------------- core statistics
def roll_z(x: np.ndarray, W: int, mp: int, clip: float = 4.0) -> np.ndarray:
    n = len(x)
    cs = np.concatenate([[0], np.cumsum(x)])
    cs2 = np.concatenate([[0], np.cumsum(x * x)])
    i = np.arange(n)
    lo = np.maximum(i - W, 0)
    cnt = (i - lo).astype(float)
    s = cs[i] - cs[lo]
    s2 = cs2[i] - cs2[lo]
    with np.errstate(invalid="ignore", divide="ignore"):
        m = s / np.maximum(cnt, 1)
        v = np.maximum(s2 / np.maximum(cnt, 1) - m * m, 0) * cnt / np.maximum(cnt - 1, 1)
        z = (x - m) / np.where(np.sqrt(v) > 1e-12, np.sqrt(v), np.nan)
    z = np.nan_to_num(np.clip(z, -clip, clip))
    z[cnt < mp] = 0.0
    return z


def cp_min(y: np.ndarray, lo: int):
    n = len(y)
    k = np.arange(lo, n - lo + 1)
    s = np.cumsum(y)
    ss = np.cumsum(y * y)
    ma = s[k - 1] / k
    mb = (s[-1] - s[k - 1]) / (n - k)
    va = np.maximum((ss[k - 1] - k * ma * ma) / (k - 1), 0)
    vb = np.maximum((ss[-1] - ss[k - 1] - (n - k) * mb * mb) / (n - k - 1), 0)
    den = np.sqrt(va / k + vb / (n - k))
    t = np.divide(mb - ma, den, out=np.zeros_like(ma), where=den > 1e-14)
    i = int(np.argmax(np.abs(t)))
    return int(k[i]), float(t[i]), float(mb[i] - ma[i])


def mbb(x: np.ndarray, L: int, rng, B: int) -> np.ndarray:
    n = len(x)
    nb = int(np.ceil(n / L))
    st = rng.integers(0, n - L + 1, size=(B, nb))
    idx = (st[:, :, None] + np.arange(L)).reshape(B, -1)[:, :n]
    return x[idx]


def cp_p(y, lo, L, rng, B):
    k, t, d = cp_min(y, lo)
    tn = np.array([cp_min(s, lo)[1] for s in mbb(y - y.mean(), L, rng, B)])
    return k, t, d, (1 + np.sum(np.abs(tn) >= abs(t) - 1e-12)) / (B + 1)


def ar1(rho, sd, n, S, rng):
    burn = 200
    e = rng.normal(0, sd, size=(S, n + burn))
    x = np.zeros((S, n + burn))
    for i in range(1, n + burn):
        x[:, i] = rho * x[:, i - 1] + e[:, i]
    return x[:, burn:]


def changepoint(adv: np.ndarray, mcfg: dict, seed: int) -> dict:
    n = len(adv)
    lo = max(5, n // 5)
    L = max(4, min(14, n // 4))
    rng = np.random.default_rng(seed)
    k, t, delta, p_raw = cp_p(adv, lo, L, rng, mcfg["bootstrap_B"])
    r1 = float(np.corrcoef(adv[:-1], adv[1:])[0, 1])
    r1 = 0.0 if not np.isfinite(r1) else r1
    sd = float(np.std(adv[1:] - r1 * adv[:-1], ddof=1))
    sim = np.array([cp_p(z, lo, L, rng, mcfg["inner_B"])[3]
                    for z in ar1(r1, sd, n, mcfg["ar1_surrogates"], rng)])
    p = float((1 + np.sum(sim <= p_raw)) / (len(sim) + 1))
    fit = np.r_[np.full(k, adv[:k].mean()), np.full(n - k, adv[k:].mean())]
    e = adv - fit
    ks = np.array([cp_min(fit + s, lo)[0] for s in mbb(e - e.mean(), L, rng, mcfg["bootstrap_B"])])
    ci = np.percentile(ks, [2.5, 97.5])
    return dict(k=k, t=t, delta=delta, p=p, p_raw=float(p_raw), size=float((sim < 0.05).mean()),
                ci_lo=int(np.floor(ci[0])), ci_hi=min(int(np.ceil(ci[1])), n - 1),
                pre=float(adv[:k].mean()), post=float(adv[k:].mean()))


# --------------------------------------------------------------------------- campaign analysis
def stream_symmetry(ment: dict[str, pd.DataFrame], actors: list[str], w0, w1, min_ratio: float) -> dict:
    out = {}
    for s, d in ment.items():
        d = d[(d.date >= w0) & (d.date <= w1)].drop_duplicates(subset=["candidate", "url"])
        c = {a: int((d.candidate == a).sum()) for a in actors}
        mx = max(c.values())
        ratio = (min(c.values()) / mx) if mx else 0.0
        out[s] = dict(counts=c, ratio=round(ratio, 3), usable=bool(ratio >= min_ratio))
    return out


def choose_streams(sym: dict) -> list[str]:
    usable = [s for s, v in sym.items() if v["usable"]]
    if usable:
        return usable
    return [max(sym, key=lambda s: sym[s]["ratio"])] if sym else []


def daily(ment: dict[str, pd.DataFrame], streams: list[str]) -> pd.DataFrame:
    d = pd.concat([ment[s] for s in streams], ignore_index=True)
    d = d.drop_duplicates(subset=["candidate", "url"])
    d["date"] = pd.to_datetime(d["date"])
    return d.groupby(["date", "candidate"]).agg(tone=("tone", "mean"), n=("tone", "size")).reset_index()


def actor_series(g: pd.DataFrame, actor: str, start, end, mcfg: dict):
    h = g[g.candidate == actor].set_index("date").reindex(pd.date_range(start, end))
    tone = h.tone.interpolate().ffill().bfill()
    if tone.isna().all():
        tone = tone.fillna(0.0)
    z = roll_z(tone.to_numpy(), mcfg["z_window"], mcfg["z_min_obs"], mcfg["z_clip"])
    return pd.Series(z, index=h.index), h.n.fillna(0).astype(int), tone


TYPOLOGY = {
    (True, True): ("full reversal", "Direction and pressure both move towards the counter-candidate."),
    (False, True): ("quiet challenge", "Tone favours the favourite, but media pressure concentrates on the counter-candidate."),
    (True, False): ("tonal shift without pressure", "Tone moves towards the counter-candidate, but pressure stays on the favourite."),
    (False, False): ("consolidation", "Direction and pressure both stay with the favourite."),
}


def analyse(ment: dict[str, pd.DataFrame], campaign: dict, mcfg: dict, end: pd.Timestamp,
            streams: list[str] | None = None, seed: int | None = None, full: bool = True) -> dict:
    A, B = (a["id"] for a in campaign["actors"])
    fav = campaign["favorite"]["actor"]
    C = B if fav == A else A
    d0 = pd.Timestamp(campaign["data_start"])
    w0 = pd.Timestamp(campaign["window_start"])
    el = pd.Timestamp(campaign["election_date"])
    end = min(pd.Timestamp(end), el - pd.Timedelta(days=1))
    for s in ment:
        ment[s] = ment[s].copy()
        ment[s]["date"] = pd.to_datetime(ment[s]["date"])
    sym = stream_symmetry(ment, [A, B], w0, end, mcfg["min_ratio"])
    used = streams or choose_streams(sym)
    g = daily(ment, used)
    Z, N, T = {}, {}, {}
    for a in (A, B):
        Z[a], N[a], T[a] = actor_series(g, a, d0, end, mcfg)
    Lx = {a: 1 / (1 + np.exp(Z[a])) for a in (A, B)}
    idx = pd.date_range(w0, end)
    adv = (-(Lx[A] - Lx[B])).reindex(idx).to_numpy()
    cp = changepoint(adv, mcfg, seed if seed is not None else mcfg["seed"])
    D = (Z[A] - Z[B]).reindex(idx)
    M = (Z[A].abs() - Z[B].abs()).reindex(idx)
    k = mcfg["ddm_days"]
    sgn = 1 if C == A else -1            # orient towards the counter-candidate
    Dc, Mc = float(sgn * D[-k:].mean()), float(sgn * M[-k:].mean())
    typ = TYPOLOGY[(Dc > 0, Mc > 0)]
    lvl = float(adv[-mcfg["level_days"]:].mean())
    res = dict(
        streams_used=used,
        window=[str(w0.date()), str(end.date())], n=len(idx),
        changepoint=dict(date=str(idx[cp["k"]].date()), t=round(cp["t"], 3), delta=round(cp["delta"], 4),
                         p=round(cp["p"], 4), p_raw=round(cp["p_raw"], 4), test_size=round(cp["size"], 3),
                         ci=[str(idx[cp["ci_lo"]].date()), str(idx[cp["ci_hi"]].date())],
                         favours=A if cp["delta"] > 0 else B,
                         pre_mean=round(cp["pre"], 4), post_mean=round(cp["post"], 4)),
        level=dict(days=mcfg["level_days"], value=round(lvl, 4), leader=A if lvl > 0 else B),
        ddm=dict(days=k, window=[str(idx[-k].date()), str(idx[-1].date())],
                 D_to_counter=round(Dc, 4), M_to_counter=round(Mc, 4),
                 D_days_to_counter=int(((sgn * D[-k:]) > 0).sum()), M_days_to_counter=int(((sgn * M[-k:]) > 0).sum()),
                 typology=typ[0], typology_text=typ[1]),
    )
    if not full:
        return res
    # H4: upset signal = mean(|z_C| - |z_F|) over the 10 days before election day
    h4_w = pd.date_range(el - pd.Timedelta(days=k), el - pd.Timedelta(days=1))
    active = end >= h4_w[0]
    avail = h4_w[h4_w <= end]
    MtoC = float((Z[C].abs() - Z[fav].abs()).reindex(avail).mean()) if len(avail) else None
    res["h4"] = dict(window=[str(h4_w[0].date()), str(h4_w[-1].date())], active=bool(active),
                     complete=bool(end >= h4_w[-1]), days_available=int(len(avail)),
                     M_to_counter=None if MtoC is None else round(MtoC, 4),
                     signal=None if MtoC is None else bool(MtoC > 0),
                     provisional_M_to_counter=round(Mc, 4))
    res["symmetry"] = sym
    res["actors"] = dict(A=A, B=B, favourite=fav, counter=C)
    res["series"] = dict(
        dates=[str(x.date()) for x in idx],
        L_A=np.round(Lx[A].reindex(idx).to_numpy(), 4).tolist(),
        L_B=np.round(Lx[B].reindex(idx).to_numpy(), 4).tolist(),
        dp=np.round(adv, 4).tolist(),
        D=np.round(D.to_numpy(), 4).tolist(),
        M=np.round(M.to_numpy(), 4).tolist(),
        n_A=N[A].reindex(idx).fillna(0).astype(int).tolist(),
        n_B=N[B].reindex(idx).fillna(0).astype(int).tolist(),
        tone_A=np.round(T[A].reindex(idx).to_numpy(), 3).tolist(),
        tone_B=np.round(T[B].reindex(idx).to_numpy(), 3).tolist(),
    )
    # sensitivity: each stream alone
    sens = []
    for i, s in enumerate(ment):
        if not len(ment[s]):
            continue
        r = analyse({k2: v for k2, v in ment.items()}, campaign, mcfg, end, streams=[s],
                    seed=(seed or mcfg["seed"]) + 101 + i, full=False)
        sens.append(dict(variant=f"{s} only", **_brief(r)))
    res["sensitivity"] = [dict(variant="+".join(used) + " (stream rule)", **_brief(res))] + sens
    return res


def _brief(r: dict) -> dict:
    c = r["changepoint"]
    return dict(cp_date=c["date"], t=c["t"], p=c["p"], favours=c["favours"],
                D_to_counter=r["ddm"]["D_to_counter"], M_to_counter=r["ddm"]["M_to_counter"],
                typology=r["ddm"]["typology"])
