/* BMPI Election Monitor — front end. Reads data/index.json and data/<campaign>.json.
   No external dependencies: charts are drawn as inline SVG. */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, text) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const isDark = () => {
    const t = document.documentElement.getAttribute("data-theme");
    if (t) return t === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const MIN = "−";
  const fmt = (x, d = 3, sign = true) => {
    if (x === null || x === undefined || Number.isNaN(x)) return "–";
    const s = Math.abs(x).toFixed(d);
    if (!sign) return (x < 0 ? MIN : "") + s;
    return (x > 0 ? "+" : x < 0 ? MIN : "±") + s;
  };
  const STREAM = { english: "EN", translation: "TR" };
  const variantName = (v) => v.replace(/english|translation/g, (m) => STREAM[m]).replace("+", " + ").replace("(stream rule)", "— stream rule");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dshort = (s) => { const [, m, d] = s.split("-"); return `${MONTHS[+m - 1]} ${+d}`; };
  const dlong = (s) => { const [y, m, d] = s.split("-"); return `${MONTHS[+m - 1]} ${+d}, ${y}`; };

  let STATE = { index: null, data: null, hist: null };

  // ------------------------------------------------------------------ theme
  const themeBtn = $("#theme");
  themeBtn.addEventListener("click", () => {
    document.documentElement.setAttribute("data-theme", isDark() ? "light" : "dark");
    try { localStorage.setItem("bmpi-theme", document.documentElement.getAttribute("data-theme")); } catch (e) {}
    render();
  });
  try { const t = localStorage.getItem("bmpi-theme"); if (t) document.documentElement.setAttribute("data-theme", t); } catch (e) {}
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => render());

  // ------------------------------------------------------------------ status icons (icon + label, never colour alone)
  const ICON = {
    good: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="var(--good)"/><path d="M4 7.2l2 2 4-4.4" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warning: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.2l6 11H1z" fill="var(--warning)"/><path d="M7 5.2v3.3M7 10.2v.1" stroke="#1a1a19" stroke-width="1.7" stroke-linecap="round"/></svg>',
    serious: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1" y="1" width="12" height="12" rx="3" fill="var(--serious)"/><path d="M7 3.8v4M7 10.1v.1" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
    neutral: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="var(--neutral)"/><path d="M4 7h6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };
  const badge = (kind, label) => {
    const b = el("span", { class: "badge" });
    b.innerHTML = ICON[kind];
    b.appendChild(document.createTextNode(label));
    return b;
  };

  // ------------------------------------------------------------------ data
  async function getJSON(u) {
    const r = await fetch(u + (u.includes("?") ? "&" : "?") + "v=" + Date.now());
    if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
    return r.json();
  }
  async function init() {
    try {
      STATE.index = await getJSON("data/index.json");
    } catch (e) {
      $("#app").innerHTML = "";
      const d = el("div", { class: "err" });
      d.textContent = "No data yet. The bot writes data/index.json after its first run.";
      $("#app").appendChild(d);
      return;
    }
    const site = STATE.index.site || {};
    if (site.title) { $("#title").textContent = site.title; document.title = site.title; }
    if (site.subtitle) $("#subtitle").textContent = site.subtitle;
    const sel = $("#campaign");
    sel.innerHTML = "";
    const camps = STATE.index.campaigns || [];
    camps.forEach((c) => sel.appendChild(el("option", { value: c.id }, c.name)));
    const want = new URLSearchParams(location.search).get("c");
    if (want && camps.some((c) => c.id === want)) sel.value = want;
    sel.addEventListener("change", () => load(sel.value));
    if (site.repo_url) {
      const f = $("#footer");
      f.appendChild(document.createTextNode(" · "));
      const a = el("a", { href: site.repo_url }, "source code");
      f.appendChild(a);
    }
    if (camps.length) load(sel.value);
  }
  async function load(id) {
    const app = $("#app");
    app.style.opacity = 0.5;
    try {
      STATE.data = await getJSON(`data/${id}.json`);
      try { STATE.hist = await getJSON(`data/${id}_history.json`); } catch (e) { STATE.hist = []; }
      const u = new URL(location.href); u.searchParams.set("c", id); history.replaceState(null, "", u);
      render();
    } catch (e) {
      app.textContent = "Could not load campaign data: " + e.message;
    }
    app.style.opacity = 1;
  }

  // ------------------------------------------------------------------ render
  function actorInfo(D) {
    const dark = isDark();
    const m = {};
    D.campaign.actors.forEach((a) => (m[a.id] = { label: a.label, color: dark ? a.color_dark || a.color : a.color }));
    return m;
  }

  // ------------------------------------------------------------------ view state (tab, chart, range)
  const VIEW = { tab: "overview", chart: "dp", range: "all" };
  (function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("tab")) VIEW.tab = h.get("tab");
    if (h.get("chart")) VIEW.chart = h.get("chart");
    if (h.get("range")) VIEW.range = h.get("range");
  })();
  const writeHash = () => { history.replaceState(null, "", `${location.pathname}${location.search}#tab=${VIEW.tab}&chart=${VIEW.chart}&range=${VIEW.range}`); };

  const TABS = [["overview", "Overview"], ["charts", "Charts"], ["details", "Details"], ["method", "How to read"]];

  function render() {
    const D = STATE.data;
    if (!D) return;
    const app = $("#app");
    const home = $("#explainHome"), ex = $("#explain");
    if (ex && ex.parentNode !== home) home.appendChild(ex);
    app.innerHTML = "";
    const act = actorInfo(D);
    const ctx = { D, act, A: D.actors.A, B: D.actors.B, F: D.actors.favourite, C: D.actors.counter, lab: (id) => act[id].label };

    // meta line
    const meta = el("div", { class: "meta" });
    const addMeta = (k, v) => { const s = el("span"); s.appendChild(document.createTextNode(k + " ")); s.appendChild(el("b", {}, v)); meta.appendChild(s); };
    addMeta("Data through", dlong(D.last_data_day));
    addMeta("Election", `${dlong(D.campaign.election_date)} · ${D.days_to_election >= 0 ? D.days_to_election + " days left" : "held"}`);
    addMeta("Updated", D.generated_at);
    app.appendChild(meta);

    // tabs
    const nav = el("nav", { class: "tabs", role: "tablist" });
    TABS.forEach(([id, name]) => {
      const b = el("button", { role: "tab", type: "button", "aria-selected": String(VIEW.tab === id) }, name);
      b.addEventListener("click", () => { VIEW.tab = id; writeHash(); render(); window.scrollTo({ top: 0 }); });
      nav.appendChild(b);
    });
    app.appendChild(nav);

    const panel = el("div", { class: "panel", role: "tabpanel" });
    app.appendChild(panel);
    const explain = $("#explain");
    if (VIEW.tab === "overview") overview(panel, ctx);
    else if (VIEW.tab === "charts") charts(panel, ctx);
    else if (VIEW.tab === "details") details(panel, ctx);
    else panel.appendChild(explain);
  }

  // ------------------------------------------------------------------ building blocks
  function tile(parent, k, v, d, b, opt = {}) {
    const t = el("div", { class: "tile" + (opt.wide ? " wide" : "") });
    const head = el("div", { class: "khead" });
    head.appendChild(el("p", { class: "k" }, k));
    let info;
    if (opt.info) {
      const btn = el("button", { class: "info", type: "button", "aria-label": "What does this mean?", "aria-expanded": "false" }, "?");
      info = el("div", { class: "infotext", hidden: "" });
      info.textContent = opt.info;
      btn.addEventListener("click", () => { const open = info.hidden; info.hidden = !open; btn.setAttribute("aria-expanded", String(open)); });
      head.appendChild(btn);
    }
    t.appendChild(head);
    const vv = el("div", { class: "v" + (opt.small ? " small" : "") });
    if (v instanceof Node) vv.appendChild(v); else vv.textContent = v;
    t.appendChild(vv);
    if (d) { const dd = el("div", { class: "d" }); if (d instanceof Node) dd.appendChild(d); else dd.textContent = d; t.appendChild(dd); }
    if (b) t.appendChild(b);
    if (info) t.appendChild(info);
    parent.appendChild(t);
    return t;
  }
  function card(parent, title, caption, legend) {
    const c = el("section", { class: "card" });
    const h = el("div", { class: "cardhead" });
    h.appendChild(el("h2", {}, title));
    c.appendChild(h);
    if (caption) c.appendChild(el("p", { class: "cap" }, caption));
    if (legend && legend.length) {
      const lg = el("div", { class: "legend" });
      legend.forEach((l) => {
        const s = el("span");
        const i = el("i", { class: l.kind === "rect" ? "rect" : l.kind === "dot" ? "dot" : "" });
        if (l.kind === "line") i.style.borderColor = l.color; else i.style.background = l.color;
        s.appendChild(i); s.appendChild(document.createTextNode(l.name)); lg.appendChild(s);
      });
      c.appendChild(lg);
    }
    parent.appendChild(c);
    return c;
  }
  function chartBox(c, cls = "") {
    const box = el("div", { class: "chart " + cls });
    c.appendChild(box);
    return box;
  }
  function tableCard(parent, title, caption, head, rows) {
    const c = card(parent, title, caption);
    const w = el("div", { class: "tablewrap" });
    const t = el("table");
    const tr = el("tr"); head.forEach((h) => tr.appendChild(el("th", {}, h)));
    const th = el("thead"); th.appendChild(tr); t.appendChild(th);
    const tb = el("tbody");
    rows.forEach((r) => { const x = el("tr"); r.forEach((v) => x.appendChild(el("td", {}, String(v)))); tb.appendChild(x); });
    t.appendChild(tb); w.appendChild(t); c.appendChild(w);
    return c;
  }
  const actorBadge = (act, id, prefix = "") => {
    const b = el("span", { class: "badge" });
    b.appendChild(el("span", { class: "swatch", style: `background:${act[id].color}` }));
    b.appendChild(document.createTextNode(prefix + act[id].label));
    return b;
  };
  const cpStatus = (p) => (p < 0.05 ? ["serious", "Regime shift detected"] : p < 0.10 ? ["warning", "Borderline"] : ["neutral", "No significant shift"]);

  // oriented rolling 10-day ΔD / ΔM, computed from the daily series
  function trail(ctx) {
    const S = ctx.D.series, k = ctx.D.ddm.days, sg = ctx.C === ctx.A ? 1 : -1, out = [];
    for (let i = k - 1; i < S.dates.length; i++) {
      let d = 0, m = 0;
      for (let j = i - k + 1; j <= i; j++) { d += S.D[j]; m += S.M[j]; }
      out.push({ date: S.dates[i], D: (sg * d) / k, M: (sg * m) / k });
    }
    return out;
  }

  function verdict(ctx) {
    const { D, lab } = ctx, cp = D.changepoint, lv = D.level, dd = D.ddm, h = D.h4;
    const parts = [];
    if (cp.p < 0.05) parts.push(`A regime shift in the media field is detected on ${dshort(cp.date)}, towards ${lab(cp.favours)} (p = ${cp.p.toFixed(3)}).`);
    else if (cp.p < 0.10) parts.push(`A borderline break appears on ${dshort(cp.date)}, towards ${lab(cp.favours)} (p = ${cp.p.toFixed(3)}); not significant.`);
    else parts.push(`No hidden reversal: the strongest break (${dshort(cp.date)}) is far from significant (p = ${cp.p.toFixed(2)}).`);
    parts.push(Math.abs(lv.value) < 0.05 ? "The field is currently balanced." : `The field currently leans towards ${lab(lv.leader)}.`);
    parts.push(`Last ${dd.days} days: ${dd.typology} — ${dd.typology_text.charAt(0).toLowerCase() + dd.typology_text.slice(1)}`);
    if (!h.active) parts.push(`The upset test (H4) starts on ${dshort(h.window[0])}.`);
    else parts.push(h.signal ? `Upset signal (H4) is ON: pressure concentrates on ${lab(ctx.C)} in the final window.` : "No upset signal (H4) in the final window.");
    return parts.join(" ");
  }

  // ------------------------------------------------------------------ OVERVIEW
  function overview(panel, ctx) {
    const { D, act, A, B, C, lab } = ctx, cp = D.changepoint, lv = D.level, dd = D.ddm, h = D.h4;
    const v = el("div", { class: "verdict" });
    const st = cpStatus(cp.p);
    v.appendChild(badge(st[0], st[1]));
    v.appendChild(el("p", {}, verdict(ctx)));
    panel.appendChild(v);

    const tiles = el("div", { class: "tiles four" });
    tile(tiles, "Change point", `p = ${cp.p.toFixed(3)}`,
      `${dshort(cp.date)} · t = ${fmt(cp.t, 2, false)} · towards ${lab(cp.favours)}`, badge(st[0], st[1]),
      { info: "Did the media field switch regime during the campaign? The test finds the date where the average field balance shifts most and asks whether such a shift could arise by chance. p < 0.05: shift detected; 0.05–0.10: borderline; ≥ 0.10: no shift. Recomputed daily, so intermediate values are descriptive." });
    tile(tiles, `Field level · ${lv.days} days`, fmt(lv.value),
      Math.abs(lv.value) < 0.05 ? "Balanced field" : `Field leans towards ${lab(lv.leader)}`,
      Math.abs(lv.value) < 0.05 ? badge("neutral", "Balanced") : actorBadge(act, lv.leader, "Leader: "),
      { info: `Mean ΔpBMPI of the last ${lv.days} days. Above 0 favours ${lab(A)}, below 0 favours ${lab(B)}; |value| < 0.05 is treated as balanced. A lead is a level, not a reversal.` });
    tile(tiles, `Regime type · ${dd.days} days`, dd.typology.charAt(0).toUpperCase() + dd.typology.slice(1),
      `Direction ${fmt(dd.D_to_counter, 2)} · pressure ${fmt(dd.M_to_counter, 2)} (towards ${lab(C)})`, null,
      { small: true, info: "Combines direction (whose tone improves) and pressure (around whom coverage is most unusual), both measured towards the counter-candidate over the last 10 days. Full reversal = both towards the challenger; quiet challenge = tone with the favourite but pressure on the challenger; tonal shift without pressure = the opposite; consolidation = both with the favourite." });
    tile(tiles, "Upset signal (H4)", h.active ? fmt(h.M_to_counter) : "Not yet",
      h.active ? `${h.days_available}/10 final days in` : `Starts ${dshort(h.window[0])} · now ${fmt(h.provisional_M_to_counter, 2)}`,
      h.active ? (h.signal ? badge("warning", "Signal ON") : badge("good", "No signal")) : badge("neutral", `${Math.max(0, daysBetween(D.last_data_day, h.window[0]))} days to go`),
      { small: !h.active, info: `Pressure towards the counter-candidate (${lab(C)}) over the 10 days before election day (${dshort(h.window[0])} – ${dshort(h.window[1])}). > 0 = the signature seen before upsets in the article's sample (7 of 8 cases, not statistically established). Before that window the value is only provisional.` });
    panel.appendChild(tiles);

    const S = D.series;
    const grid = el("div", { class: "grid2 ov" });
    panel.appendChild(grid);
    const c1 = card(grid, "Field balance and change point", `Above 0 favours ${lab(A)}, below 0 favours ${lab(B)}.`,
      [{ name: lab(A), color: act[A].color, kind: "rect" }, { name: lab(B), color: act[B].color, kind: "rect" }, { name: "means before / after break", color: css("--ink"), kind: "line" }]);
    const b1 = chartBox(c1);
    const c2 = card(grid, "Regime map", `Where the last ${dd.days} days sit. Trail = the past 30 days, large dot = now.`);
    const b2 = chartBox(c2, "square");
    requestAnimationFrame(() => {
      const k = S.dates.indexOf(cp.date);
      chart(b1, S.dates, [{ name: "ΔpBMPI", values: S.dp, type: "divbar", pos: act[A].color, neg: act[B].color }],
        { ref: 0, band: cp.ci, vline: cp.date, digits: 3, steps: [{ from: 0, to: k, y: cp.pre_mean }, { from: k, to: S.dates.length - 1, y: cp.post_mean }] });
      compass(b2, trail(ctx).slice(-30), ctx);
    });
    const more = el("p", { class: "more" });
    const a1 = el("button", { class: "link", type: "button" }, "All charts →");
    a1.addEventListener("click", () => { VIEW.tab = "charts"; writeHash(); render(); });
    const a2 = el("button", { class: "link", type: "button" }, "How to read these numbers →");
    a2.addEventListener("click", () => { VIEW.tab = "method"; writeHash(); render(); });
    more.appendChild(a1); more.appendChild(a2);
    panel.appendChild(more);
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

  // ------------------------------------------------------------------ CHARTS (one large chart at a time)
  const CHARTS = [
    ["dp", "Field balance"], ["L", "Pressure per actor"], ["D", "Direction ΔD"], ["M", "Pressure ΔM"], ["n", "Mentions"],
  ];
  const RANGES = [["30", "30 days"], ["60", "60 days"], ["all", "Whole window"]];
  function charts(panel, ctx) {
    const { D, act, A, B, lab } = ctx, S = D.series, cp = D.changepoint, dd = D.ddm;
    const bar = el("div", { class: "filters" });
    const seg = (items, key) => {
      const g = el("div", { class: "seg", role: "radiogroup" });
      items.forEach(([id, name]) => {
        const b = el("button", { type: "button", role: "radio", "aria-checked": String(VIEW[key] === id) }, name);
        b.addEventListener("click", () => { VIEW[key] = id; writeHash(); render(); });
        g.appendChild(b);
      });
      return g;
    };
    bar.appendChild(seg(CHARTS, "chart"));
    bar.appendChild(seg(RANGES, "range"));
    panel.appendChild(bar);

    const n = S.dates.length, from = VIEW.range === "all" ? 0 : Math.max(0, n - +VIEW.range);
    const sl = (arr) => arr.slice(from);
    const dates = sl(S.dates);
    const cA = act[A].color, cB = act[B].color;
    const last10 = [S.dates[n - dd.days], S.dates[n - 1]];
    const spec = {
      dp: { t: "Field balance ΔpBMPI and change point", cap: `ΔpBMPI = −(L_${lab(A)} − L_${lab(B)}). Above 0 favours ${lab(A)}, below 0 favours ${lab(B)}. Steps = mean before / after the break, dashed = break date (${dshort(cp.date)}), grey band = 95% CI of the date. The test always uses the whole window.`,
        lg: [{ name: `favours ${lab(A)}`, color: cA, kind: "rect" }, { name: `favours ${lab(B)}`, color: cB, kind: "rect" }, { name: "segment means", color: css("--ink"), kind: "line" }],
        draw: (b) => { const k = S.dates.indexOf(cp.date) - from; chart(b, dates, [{ name: "ΔpBMPI", values: sl(S.dp), type: "divbar", pos: cA, neg: cB }], { ref: 0, band: cp.ci, vline: cp.date, digits: 3, steps: [{ from: Math.max(0, 0 - from), to: Math.max(0, k), y: cp.pre_mean }, { from: Math.max(0, k), to: dates.length - 1, y: cp.post_mean }].filter((s) => s.to > s.from) }); } },
      L: { t: "Media pressure per actor (pBMPI)", cap: "L = 1/(1+e^z). Above 0.5: coverage harsher than the actor's own last 30 days; below 0.5: milder.",
        lg: [{ name: lab(A), color: cA, kind: "line" }, { name: lab(B), color: cB, kind: "line" }],
        draw: (b) => chart(b, dates, [{ name: lab(A), color: cA, values: sl(S.L_A), type: "line" }, { name: lab(B), color: cB, values: sl(S.L_B), type: "line" }], { ref: 0.5, yMin: 0, yMax: 1, digits: 3 }) },
      D: { t: "Direction ΔD = z_A − z_B", cap: `Above 0: tone relatively better for ${lab(A)}. Shaded: last ${dd.days} days used for the regime type. Line: 5-day mean.`,
        lg: [{ name: `towards ${lab(A)}`, color: cA, kind: "rect" }, { name: `towards ${lab(B)}`, color: cB, kind: "rect" }, { name: "5-day mean", color: css("--ink"), kind: "line" }],
        draw: (b) => chart(b, dates, [{ name: "ΔD", values: sl(S.D), type: "divbar", pos: cA, neg: cB, ma: 5 }], { ref: 0, window: last10, digits: 2 }) },
      M: { t: "Pressure ΔM = |z_A| − |z_B|", cap: `Above 0: coverage around ${lab(A)} is more unusual than around ${lab(B)} (in either direction). Shaded: last ${dd.days} days.`,
        lg: [{ name: `on ${lab(A)}`, color: cA, kind: "rect" }, { name: `on ${lab(B)}`, color: cB, kind: "rect" }, { name: "5-day mean", color: css("--ink"), kind: "line" }],
        draw: (b) => chart(b, dates, [{ name: "ΔM", values: sl(S.M), type: "divbar", pos: cA, neg: cB, ma: 5 }], { ref: 0, window: last10, digits: 2 }) },
      n: { t: "Daily matched mentions", cap: "Articles per day after de-duplication, streams combined. Low counts make single days noisy.",
        lg: [{ name: lab(A), color: cA, kind: "rect" }, { name: lab(B), color: cB, kind: "rect" }],
        draw: (b) => chart(b, dates, [{ name: lab(A), values: sl(S.n_A), type: "bar2", color: cA, slot: 0 }, { name: lab(B), values: sl(S.n_B), type: "bar2", color: cB, slot: 1 }], { yMin: 0, digits: 0 }) },
    }[VIEW.chart] || null;
    if (!spec) { VIEW.chart = "dp"; return charts(panel, ctx); }
    const c = card(panel, spec.t, spec.cap, spec.lg);
    const box = chartBox(c, "tall");
    requestAnimationFrame(() => spec.draw(box));
  }

  // ------------------------------------------------------------------ DETAILS
  function details(panel, ctx) {
    const { D, act, A, B, F, C, lab } = ctx, dd = D.ddm, S = D.series;
    const tiles = el("div", { class: "tiles" });
    tile(tiles, `Direction ΔD · ${dd.days} days`, fmt(dd.D_to_counter),
      `${dd.D_to_counter > 0 ? "Tone moves towards " + lab(C) : "Tone stays with " + lab(F)}; ${dd.D_days_to_counter}/${dd.days} days towards ${lab(C)}.`, null,
      { info: "Mean of z(counter) − z(favourite) over the last 10 days. > 0: tone moves towards the counter-candidate." });
    tile(tiles, `Pressure ΔM · ${dd.days} days`, fmt(dd.M_to_counter),
      `${dd.M_to_counter > 0 ? "Pressure on " + lab(C) : "Pressure on " + lab(F)}; ${dd.M_days_to_counter}/${dd.days} days on ${lab(C)}.`, null,
      { info: "Mean of |z(counter)| − |z(favourite)| over the last 10 days. > 0: coverage around the counter-candidate is more unusual, whatever its sign." });
    const fv = D.campaign.favourite;
    const who = el("span"); who.appendChild(el("span", { class: "swatch", style: `background:${act[fv.actor].color}` })); who.appendChild(document.createTextNode(lab(fv.actor)));
    tile(tiles, "Poll favourite", who, `${fv.value} · ${fv.source} · as of ${dlong(fv.as_of)}`, null,
      { small: true, info: "Set manually from public polls: mean of polls in the 30 days before the window end. It orients direction, pressure and the upset signal." });
    const sd = el("div");
    Object.entries(D.symmetry).forEach(([s, v]) => sd.appendChild(el("div", {}, `${STREAM[s] || s}: ${v.counts[A]} / ${v.counts[B]} (ratio ${v.ratio.toFixed(2)}${v.usable ? "" : ", unusable"}), missing ${D.missing_pct[s]}%`)));
    tile(tiles, "Data used", D.streams_used.map((s) => STREAM[s] || s).join(" + "), sd,
      Object.values(D.missing_pct).some((x) => x > 5) ? badge("warning", "Gaps in data") : badge("good", "Complete"),
      { small: true, info: "EN = English-language stream (US domestic outlets for US campaigns); TR = GDELT Translingual (non-English press). Ratio = min/max mentions of the two actors; below 0.10 a stream is unusable. Missing = share of 15-minute GDELT files not retrieved." });
    panel.appendChild(tiles);

    tableCard(panel, "Sensitivity to the data stream", "The primary reading uses the stream rule. A result that flips between streams is fragile.",
      ["Variant", "Break", "t", "p", "Break favours", "ΔD", "ΔM", "Regime type"],
      D.sensitivity.map((r) => [variantName(r.variant), dshort(r.cp_date), fmt(r.t, 2, false), r.p.toFixed(3), lab(r.favours), fmt(r.D_to_counter, 2), fmt(r.M_to_counter, 2), r.typology]));
    const hist = (STATE.hist || []).slice().reverse().slice(0, 30);
    tableCard(panel, "Signal history", hist.length > 1 ? "Headline numbers after each daily run, newest first." : "Fills up with each daily run: one row per data day.",
      ["Data through", "Break", "p", "Favours", "Level", "ΔD", "ΔM", "Regime type"],
      hist.map((r) => [dshort(r.last_data_day), dshort(r.cp_date), r.p.toFixed(3), lab(r.favours), fmt(r.level), fmt(r.D10, 2), fmt(r.M10, 2), r.typology]));

    const c = card(panel, "Daily values", null);
    const det = el("details");
    det.appendChild(el("summary", {}, `Show all ${S.dates.length} days`));
    const rows = [];
    for (let i = S.dates.length - 1; i >= 0; i--) rows.push([S.dates[i], S.L_A[i].toFixed(3), S.L_B[i].toFixed(3), fmt(S.dp[i]), fmt(S.D[i], 2), fmt(S.M[i], 2), S.n_A[i], S.n_B[i]]);
    const w = el("div", { class: "tablewrap" }); const t = el("table");
    const tr = el("tr"); ["Date", `L ${lab(A)}`, `L ${lab(B)}`, "ΔpBMPI", "ΔD", "ΔM", `n ${lab(A)}`, `n ${lab(B)}`].forEach((h) => tr.appendChild(el("th", {}, h)));
    const th = el("thead"); th.appendChild(tr); t.appendChild(th);
    const tb = el("tbody"); rows.forEach((r) => { const x = el("tr"); r.forEach((v) => x.appendChild(el("td", {}, String(v)))); tb.appendChild(x); });
    t.appendChild(tb); w.appendChild(t); det.appendChild(w); c.appendChild(det);
  }

  // ------------------------------------------------------------------ regime map (direction × pressure)
  function compass(box, pts, ctx) {
    const W = box.clientWidth, H = box.clientHeight;
    const m = { l: 34, r: 12, t: 12, b: 30 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    let lim = 0.5; pts.forEach((p) => (lim = Math.max(lim, Math.abs(p.D) * 1.15, Math.abs(p.M) * 1.15)));
    lim = Math.ceil(lim * 4) / 4;
    const x = (v) => m.l + ((v + lim) / (2 * lim)) * iw, y = (v) => m.t + ih - ((v + lim) / (2 * lim)) * ih;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Regime map: direction versus pressure, last 30 days" });
    const now = pts[pts.length - 1];
    const q = [[now.D > 0, now.M > 0]];
    const quads = [
      { dx: 1, dy: 1, name: "Full reversal" }, { dx: -1, dy: 1, name: "Quiet challenge" },
      { dx: 1, dy: -1, name: "Tonal shift, no pressure" }, { dx: -1, dy: -1, name: "Consolidation" },
    ];
    quads.forEach((qq) => {
      const active = (qq.dx > 0) === q[0][0] && (qq.dy > 0) === q[0][1];
      const rx = qq.dx > 0 ? x(0) : m.l, ry = qq.dy > 0 ? m.t : y(0);
      svg.appendChild(svgEl("rect", { x: rx, y: ry, width: iw / 2, height: ih / 2, fill: active ? css("--surface-2") : "transparent" }));
      const tx = svgEl("text", { x: qq.dx > 0 ? W - m.r - 6 : m.l + 6, y: qq.dy > 0 ? m.t + 16 : m.t + ih - 8, "text-anchor": qq.dx > 0 ? "end" : "start", class: active ? "qa" : "q" });
      tx.textContent = qq.name; svg.appendChild(tx);
    });
    svg.appendChild(svgEl("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "none", stroke: css("--grid") }));
    svg.appendChild(svgEl("line", { x1: x(0), x2: x(0), y1: m.t, y2: m.t + ih, stroke: css("--axis") }));
    svg.appendChild(svgEl("line", { x1: m.l, x2: m.l + iw, y1: y(0), y2: y(0), stroke: css("--axis") }));
    const ax = (t, xx, yy, anchor, rot) => { const e = svgEl("text", { x: xx, y: yy, "text-anchor": anchor }); if (rot) e.setAttribute("transform", `rotate(-90 ${xx} ${yy})`); e.textContent = t; svg.appendChild(e); };
    ax(`← tone with favourite · direction · tone to ${ctx.lab(ctx.C)} →`, m.l + iw / 2, H - 8, "middle");
    ax(`pressure on ${ctx.lab(ctx.C)} ↑`, 12, m.t + ih / 2, "middle", true);
    let d = ""; pts.forEach((p, i) => (d += (i ? "L" : "M") + x(p.D).toFixed(1) + "," + y(p.M).toFixed(1)));
    svg.appendChild(svgEl("path", { d, fill: "none", stroke: css("--text-muted"), "stroke-width": 1.5, "stroke-linejoin": "round", opacity: 0.7 }));
    pts.forEach((p, i) => {
      const last = i === pts.length - 1;
      svg.appendChild(svgEl("circle", { cx: x(p.D), cy: y(p.M), r: last ? 7 : 3, fill: last ? css("--ink") : css("--text-muted"), stroke: css("--surface-1"), "stroke-width": 2, opacity: last ? 1 : 0.35 + 0.65 * (i / pts.length) }));
    });
    const lbl = svgEl("text", { x: x(now.D) + 11, y: y(now.M) + 4, class: "qa" }); lbl.textContent = "now"; svg.appendChild(lbl);
    // hover: nearest point
    const tip = el("div", { class: "tip" });
    const hit = svgEl("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" });
    svg.appendChild(hit);
    box.innerHTML = ""; box.appendChild(svg); box.appendChild(tip);
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width), py = (e.clientY - r.top) * (H / r.height);
      let best = 0, bd = 1e9; pts.forEach((p, i) => { const dd2 = (x(p.D) - px) ** 2 + (y(p.M) - py) ** 2; if (dd2 < bd) { bd = dd2; best = i; } });
      if (bd > 900) { tip.style.display = "none"; return; }
      const p = pts[best]; tip.innerHTML = "";
      tip.appendChild(el("div", { class: "t" }, `10 days to ${dlong(p.date)}`));
      [["Direction ΔD", p.D], ["Pressure ΔM", p.M]].forEach(([nm, v]) => { const row = el("div", { class: "r" }); row.appendChild(el("b", {}, fmt(v, 2))); row.appendChild(el("span", {}, nm)); tip.appendChild(row); });
      tip.style.display = "block";
      let left = x(p.D) + 12; if (left + tip.offsetWidth > W) left = x(p.D) - tip.offsetWidth - 12;
      tip.style.left = Math.max(0, left) + "px"; tip.style.top = Math.max(0, y(p.M) - 50) + "px";
    });
    hit.addEventListener("pointerleave", () => (tip.style.display = "none"));
  }

  // ------------------------------------------------------------------ SVG chart
  function nice(lo, hi, n) {
    const span = hi - lo || 1;
    const step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
    const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
    const t = []; for (let v = a; v <= b + step / 2; v += step) t.push(+v.toFixed(10));
    t.dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (String(step / mag).includes(".") ? 1 : 0));
    return t;
  }
  const movavg = (v, w) => v.map((_, i) => { const s = v.slice(Math.max(0, i - w + 1), i + 1).filter((x) => x !== null); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; });

  function chart(box, dates, series, o = {}) {
    
    const W = box.clientWidth, H = box.clientHeight;
    const m = { l: 44, r: 10, t: 8, b: 24 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const n = dates.length;
    let vals = [];
    series.forEach((s) => (vals = vals.concat(s.values.filter((x) => x !== null && !Number.isNaN(x)))));
    if (o.steps) o.steps.forEach((s) => vals.push(s.y));
    if (o.ref !== undefined) vals.push(o.ref);
    let lo = o.yMin !== undefined ? o.yMin : Math.min(...vals), hi = o.yMax !== undefined ? o.yMax : Math.max(...vals);
    if (o.yMin === undefined && o.yMax === undefined && o.ref === 0) { const a = Math.max(Math.abs(lo), Math.abs(hi)); lo = -a; hi = a; }
    const ticks = nice(lo, hi, o.short ? 4 : 5);
    lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
    const step = iw / n;
    const x = (i) => m.l + (i + 0.5) * step;
    const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
    svg.setAttribute("aria-label", series.map((s) => s.name).join(", ") + " by day");
    const di = (d) => dates.indexOf(d);
    const lo_i = (d) => dates.findIndex((x) => x >= d);
    const hi_i = (d) => { for (let i = dates.length - 1; i >= 0; i--) if (dates[i] <= d) return i; return -1; };

    // bands
    if (o.window) { const a = lo_i(o.window[0]), b = hi_i(o.window[1]); if (a >= 0 && b >= a) svg.appendChild(svgEl("rect", { x: m.l + a * step, y: m.t, width: (b - a + 1) * step, height: ih, fill: css("--window") })); }
    if (o.band) { const a = lo_i(o.band[0]), b = hi_i(o.band[1]); if (a >= 0 && b >= a) svg.appendChild(svgEl("rect", { x: m.l + a * step, y: m.t, width: (b - a + 1) * step, height: ih, fill: css("--band") })); }
    // grid + y labels
    ticks.forEach((t) => {
      svg.appendChild(svgEl("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), stroke: css("--grid"), "stroke-width": 1 }));
      const tx = svgEl("text", { x: m.l - 6, y: y(t) + 4, "text-anchor": "end" });
      tx.textContent = (t < 0 ? MIN : "") + Math.abs(t).toFixed(ticks.dec);
      svg.appendChild(tx);
    });
    // x labels: first of month + ~every 2 weeks
    const every = Math.max(1, Math.round(n / Math.max(3, Math.floor(iw / 70))));
    dates.forEach((d, i) => {
      if (i % every === 0) {
        const tx = svgEl("text", { x: x(i), y: H - 6, "text-anchor": "middle" }); tx.textContent = dshort(d); svg.appendChild(tx);
        svg.appendChild(svgEl("line", { x1: x(i), x2: x(i), y1: m.t + ih, y2: m.t + ih + 4, stroke: css("--axis") }));
      }
    });
    if (o.ref !== undefined) svg.appendChild(svgEl("line", { x1: m.l, x2: W - m.r, y1: y(o.ref), y2: y(o.ref), stroke: css("--axis"), "stroke-width": 1 }));

    // marks
    series.forEach((s) => {
      if (s.type === "line") {
        let dpath = ""; s.values.forEach((v, i) => { if (v === null) return; dpath += (dpath ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1); });
        svg.appendChild(svgEl("path", { d: dpath, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      } else if (s.type === "divbar") {
        const bw = Math.max(1, step - 2), r = Math.min(2, bw / 2);
        s.values.forEach((v, i) => {
          if (v === null || v === 0) return;
          const y0 = y(0), y1 = y(v), top = Math.min(y0, y1), h = Math.max(1, Math.abs(y1 - y0));
          svg.appendChild(svgEl("rect", { x: x(i) - bw / 2, y: top, width: bw, height: h, rx: r, fill: v > 0 ? s.pos : s.neg, opacity: 0.85 }));
        });
        if (s.ma) {
          const mv = movavg(s.values, s.ma); let dpath = "";
          mv.forEach((v, i) => { if (v === null) return; dpath += (dpath ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1); });
          svg.appendChild(svgEl("path", { d: dpath, fill: "none", stroke: css("--ink"), "stroke-width": 2, "stroke-linejoin": "round" }));
          s.maValues = mv;
        }
      } else if (s.type === "bar2") {
        const bw = Math.max(1, (step - 2) / 2), r = Math.min(2, bw / 2);
        s.values.forEach((v, i) => {
          if (!v) return;
          svg.appendChild(svgEl("rect", { x: x(i) - step / 2 + 1 + s.slot * bw, y: y(v), width: Math.max(1, bw - 0.5), height: y(0) - y(v), rx: r, fill: s.color }));
        });
      }
    });
    if (o.steps) o.steps.forEach((s) => svg.appendChild(svgEl("line", { x1: x(s.from) - step / 2, x2: x(s.to) + step / 2, y1: y(s.y), y2: y(s.y), stroke: css("--ink"), "stroke-width": 2 })));
    if (o.vline) { const i = di(o.vline); if (i >= 0) svg.appendChild(svgEl("line", { x1: x(i) - step / 2, x2: x(i) - step / 2, y1: m.t, y2: m.t + ih, stroke: css("--ink"), "stroke-width": 1.5, "stroke-dasharray": "5 4" })); }

    // hover layer
    const hair = svgEl("line", { y1: m.t, y2: m.t + ih, stroke: css("--text-muted"), "stroke-width": 1, visibility: "hidden" });
    svg.appendChild(hair);
    const hit = svgEl("rect", { x: m.l, y: 0, width: iw, height: H, fill: "transparent", tabindex: 0 });
    svg.appendChild(hit);
    box.innerHTML = ""; box.appendChild(svg);
    const tip = el("div", { class: "tip", role: "status" }); box.appendChild(tip);
    const show = (i) => {
      i = Math.max(0, Math.min(n - 1, i));
      hair.setAttribute("x1", x(i)); hair.setAttribute("x2", x(i)); hair.setAttribute("visibility", "visible");
      tip.innerHTML = "";
      tip.appendChild(el("div", { class: "t" }, dlong(dates[i])));
      series.forEach((s) => {
        const row = el("div", { class: "r" });
        const key = el("i"); key.style.borderColor = s.color || (s.values[i] > 0 ? s.pos : s.neg); row.appendChild(key);
        const v = s.values[i];
        row.appendChild(el("b", {}, o.digits === 0 ? String(v) : (o.ref === 0 ? fmt(v, o.digits) : (v === null ? "–" : v.toFixed(o.digits)))));
        row.appendChild(el("span", {}, s.name)); tip.appendChild(row);
        if (s.maValues) { const r2 = el("div", { class: "r" }); const k2 = el("i"); k2.style.borderColor = css("--ink"); r2.appendChild(k2); r2.appendChild(el("b", {}, fmt(s.maValues[i], o.digits))); r2.appendChild(el("span", {}, `${s.ma}-day mean`)); tip.appendChild(r2); }
      });
      if (o.vline === dates[i]) tip.appendChild(el("div", { class: "t" }, "change point"));
      tip.style.display = "block";
      const tw = tip.offsetWidth; let left = x(i) + 12; if (left + tw > W) left = x(i) - tw - 12;
      tip.style.left = Math.max(0, left) + "px"; tip.style.top = "6px";
    };
    let cur = n - 1;
    hit.addEventListener("pointermove", (e) => { const r = svg.getBoundingClientRect(); cur = Math.floor(((e.clientX - r.left) * (W / r.width) - m.l) / step); show(cur); });
    hit.addEventListener("pointerleave", () => { tip.style.display = "none"; hair.setAttribute("visibility", "hidden"); });
    hit.addEventListener("focus", () => show(cur));
    hit.addEventListener("blur", () => { tip.style.display = "none"; hair.setAttribute("visibility", "hidden"); });
    hit.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") { cur = Math.max(0, cur - 1); show(cur); } if (e.key === "ArrowRight") { cur = Math.min(n - 1, cur + 1); show(cur); } });
  }

  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  init();
})();
