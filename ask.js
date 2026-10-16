// Cited answers over the FDA review index -- extractive, no generative model.
//
// A question is routed to the structured dataset that can answer it (safety margins, non-animal precedents,
// postmarketing requirements, FDA-sponsor disagreements), filtered by the drug, species, study, basis or subject it
// names, and answered with computed figures plus quoted passages, each carrying a numbered citation to the drug page
// and review page. Anything else falls back to BM25 ranking over every indexed passage. Nothing is paraphrased, so
// nothing can be invented; the cost is that answers read as assembled evidence, not prose.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const cache = {};
  function load(name) {
    if (!cache[name]) cache[name] = fetch(name).then((r) => r.json());
    return cache[name];
  }
  function loadIndex() {
    if (!cache.index) {
      cache.index = load("search-index.json").then((m) =>
        Promise.all(Array.from({ length: m.shards }, (_, i) => load("search-index-" + i + ".json")))
          .then((parts) => parts.flat()));
    }
    return cache.index;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clip = (s, n) => (s = String(s || "").replace(/\s+/g, " ").trim()).length <= n ? s : s.slice(0, n).replace(/\s\S*$/, "") + " …";

  // ---- what the question names -------------------------------------------------------------------------------
  const SPECIES = [["rat", /\brats?\b/], ["mouse", /\b(mice|mouse)\b/], ["rabbit", /\brabbits?\b/], ["dog", /\bdogs?\b/],
    ["monkey", /\b(monkeys?|cynomolgus|nhp)\b/], ["minipig", /\bmini-?pigs?\b/]];
  const STUDY = [["carcinogenicity", /carcino|tumou?r|2-year|rash2/], ["fertility", /fertility/],
    ["efd", /embryo|fetal|foetal|teratogen|\befd\b|malformation|pregnan/], ["ppnd", /pre- ?and post-?natal|ppnd|postnatal/],
    ["juvenile", /juvenile/], ["safety_pharm", /herg|safety pharmacology|qt\b|cardiovascular/],
    ["general_tox", /repeat[- ]dose|chronic|general tox|subchronic|\d+-week/]];
  const BASIS = [["AUC", /\bauc\b|exposure/], ["Cmax", /\bcmax\b/], ["BSA", /mg\/m2|body surface|\bbsa\b/], ["HED", /\bhed\b|human equivalent/]];
  const NAMCAT = [["qsar", /qsar|in silico|derek|leadscope|computational/], ["pbpk", /pbpk|physiologically/],
    ["in_vitro_phototox", /phototox|3t3/], ["weight_of_evidence", /weight[- ]of[- ]evidence|\bwoe\b/],
    ["in_vitro_human", /organoid|chip|ipsc|microphysiolog|human in vitro/],
    ["carc_waiver", /carcino.*(waive|not (conducted|required|needed))|(waive|skip|omit|without).*carcino/],
    ["repro_waiver", /(reproductive|embryo|fertility|juvenile).*(waive|not (conducted|required|needed))|(waive|skip).*(reproductive|embryo|fertility|juvenile)/],
    ["study_not_needed", /ich s9|ich s6|\bs9\b|\bs6\b|advanced cancer/]];
  const PMRCAT = [["pediatric", /pediatric|children|prea/], ["hepatic impairment", /hepatic/], ["renal impairment", /renal/],
    ["drug interaction", /interaction|ddi|cyp/], ["QT", /\bqt/], ["carcinogenicity", /carcino/],
    ["juvenile toxicity", /juvenile/], ["reproductive toxicity", /reproductive|embryo|fertility/],
    ["lactation", /lactation|milk/], ["pregnancy outcomes", /pregnan/], ["confirmatory efficacy", /confirmatory|accelerated/],
    ["immunogenicity", /immunogenicity|anti-drug|\bada\b/], ["CMC / quality", /cmc|manufactur|quality|stability/],
    ["abuse potential", /abuse/], ["long-term safety", /long-term|registry/]];
  // Rank rows by how many of the question's content words their text contains, then by recency (field yi).
  const QSTOP = new Set("what when where which have has does did fda the and for with from that this accepted accept instead place study studies applicant sponsor approval approvals require required requirements".split(" "));
  function rankByTerms(rows, q, ti, yi) {
    const terms = (q.match(/[a-z][a-z0-9-]{3,}/g) || []).filter((w) => !QSTOP.has(w)).map((w) => w.replace(/s$/, ""));
    const score = (x) => terms.reduce((n, w) => n + (String(x[ti]).toLowerCase().includes(w) ? 1 : 0), 0);
    return rows.map((x) => [score(x), x]).sort((a, b) => b[0] - a[0] || (yi == null ? 0 : b[1][yi] - a[1][yi])).map((p) => p[1]);
  }
  const pick = (table, q) => (table.find(([, rx]) => rx.test(q)) || [null])[0];
  const pickAll = (table, q) => table.filter(([, rx]) => rx.test(q)).map(([k]) => k);

  function intent(q) {
    if (/margin|multiple|times the|fold|noael|exposure ratio|safety factor/.test(q)) return "margins";
    if (/post-?marketing|\bpmrs?\b|\bpmcs?\b|after approval|required to conduct|505\(o\)|prea/.test(q)) return "pmr";
    if (/disagree|did not agree|does not agree|overrul|reject.*applicant|sponsor.*wrong|pushed back/.test(q)) return "differed";
    if (/waive|waiver|not conducted|instead of|in lieu|qsar|in silico|pbpk|weight[- ]of[- ]evidence|non-?animal|\bnams?\b|alternative|phototox|organoid|without (a |an )?(animal|carcino|study)/.test(q)) return "nam";
    return "search";
  }

  // ---- drug names ---------------------------------------------------------------------------------------------
  let DRUGS = null;
  function drugIn(q) {
    if (!DRUGS) return null;
    let best = null;
    for (const [name, slug] of DRUGS) {
      for (const part of name.toLowerCase().replace(/[()]/g, " ").split(/\s+/)) {
        if (part.length >= 5 && new RegExp("\\b" + part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(q)) {
          if (!best || part.length > best[2]) best = [name, slug, part.length];
        }
      }
    }
    return best && { name: best[0], slug: best[1] };
  }

  // ---- citations ------------------------------------------------------------------------------------------------
  function Cites() {
    const list = [];
    return {
      add(name, slug, anchor, page, text) {
        list.push({ name, slug, anchor, page, text });
        return '<sup><a href="#c' + list.length + '">[' + list.length + "]</a></sup>";
      },
      html() {
        if (!list.length) return "";
        return '<h2>Sources</h2><ol class="findings">' + list.map((c, i) =>
          '<li id="c' + (i + 1) + '"><a href="drugs/' + c.slug + ".html#" + c.anchor + '">' + esc(c.name) + "</a>" +
          (c.page ? ' <span class="cite">review page ' + c.page + "</span>" : "") +
          "<div>" + esc(clip(c.text, 420)) + "</div></li>").join("") + "</ol>";
      },
    };
  }
  const median = (a) => { a = a.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
  const fmt = (x) => (x < 10 ? (+x.toFixed(1)).toString() : Math.round(x).toString()) + "×";
  const SL = { carcinogenicity: "carcinogenicity", efd: "embryo-fetal", fertility: "fertility", ppnd: "pre/postnatal",
    juvenile: "juvenile", general_tox: "repeat-dose", safety_pharm: "safety pharmacology", other: "other" };

  // ---- answerers ------------------------------------------------------------------------------------------------
  async function answerMargins(q, drug) {
    const rows = await load("margins.json"); // [name, slug, mult, hi, qual, basis, species, study, level, page, text]
    let sp = pick(SPECIES, q), st = pick(STUDY, q), ba = pick(BASIS, q), noael = /noael|no[- ]effect/.test(q);
    const filt = () => rows.filter((x) => (!drug || x[1] === drug.slug) && (!sp || x[6] === sp) && (!st || x[7] === st) &&
      (!ba || x[5] === ba) && (!noael || x[8] === "noael"));
    let r = filt();
    const dropped = [];
    // Nothing that specific: widen one filter at a time, least important first, and say which.
    for (const [name, undo] of [["NOAEL only", () => (noael = false)], ["the basis", () => (ba = null)],
                                ["the study type", () => (st = null)], ["the species", () => (sp = null)]]) {
      if (r.length) break;
      undo(); dropped.push(name); r = filt();
    }
    const what = [sp, st && SL[st], noael && "NOAEL", ba && ba + "-based"].filter(Boolean).join(" ") || "all";
    if (!r.length) return null;
    const c = Cites();
    const vals = r.map((x) => x[2]);
    const drugs = new Set(r.map((x) => x[1])).size;
    const sorted = r.slice().sort((a, b) => a[2] - b[2]);
    const lo = sorted[0], hi = sorted[sorted.length - 1], mid = sorted[sorted.length >> 1];
    let text = "<p>" + (drug ? "For <strong>" + esc(drug.name) + "</strong>, reviewers" : "Across " + drugs + " approvals, reviewers") +
      " stated <strong>" + r.length + "</strong> " + esc(what) + " exposure " + (r.length === 1 ? "margin" : "margins") +
      (r.length < 4 ? "" : ". The median is <strong>" + fmt(median(vals)) + "</strong>") + (r.length >= 10 ? " (10th–90th percentile " + fmt(pct(vals, 0.1)) + " to " + fmt(pct(vals, 0.9)) + ")" : "") +
      (r.length < 4
        ? ": " + sorted.map((x) => fmt(x[2]) + " (" + esc(x[6] || "species unstated") + ", " + esc(SL[x[7]]) + ", " + esc(x[5]) + ")" +
            c.add(x[0], x[1], "margins", x[9], x[10])).join("; ") + ".</p>"
        : ". Lowest: " + fmt(lo[2]) + " in " + esc(lo[0]) + c.add(lo[0], lo[1], "margins", lo[9], lo[10]) +
          "; typical: " + fmt(mid[2]) + " in " + esc(mid[0]) + c.add(mid[0], mid[1], "margins", mid[9], mid[10]) +
          "; highest: " + fmt(hi[2]) + " in " + esc(hi[0]) + c.add(hi[0], hi[1], "margins", hi[9], hi[10]) + ".</p>");
    if (dropped.length) text = '<p class="note">No margin matched every part of the question, so this answer drops ' +
      esc(dropped.join(" and ")) + ".</p>" + text;
    if (!ba) {
      const bases = {}; r.forEach((x) => (bases[x[5]] = (bases[x[5]] || 0) + 1));
      text += '<p class="note">These mix bases (' + Object.entries(bases).sort((a, b) => b[1] - a[1]).map(([k, n]) => esc(k) + " " + n).join(", ") +
        "). An AUC multiple and a body-surface-area multiple are not comparable; add “AUC” or “BSA” to the question to compare like with like.</p>";
    }
    return { text, cites: c, more: '<a href="safety-margins.html">Explore all margins</a>' };
  }

  async function answerNam(q, drug) {
    const rows = await load("nam.json"); // [name, slug, category, stance, year, page, text]
    const cats = pickAll(NAMCAT, q);
    let r = rows.filter((x) => (!drug || x[1] === drug.slug) && (!cats.length || cats.includes(x[2])));
    if (!r.length) return null;
    const c = Cites();
    const acc = r.filter((x) => x[3] === "accepted"), rej = r.filter((x) => x[3] === "rejected");
    const recent = (a) => rankByTerms(a, q, 6, 4);
    let text = "<p>" + (drug ? "In the review of <strong>" + esc(drug.name) + "</strong>, " : "Across the indexed reviews, ") +
      "FDA <strong>accepted</strong> this kind of argument in " + acc.length + " passages (" + new Set(acc.map((x) => x[1])).size +
      " approvals) and <strong>rejected it or required more</strong> in " + rej.length + " (" + new Set(rej.map((x) => x[1])).size + " approvals).</p>";
    const ex = recent(acc).slice(0, 4).concat(recent(rej).slice(0, 2));
    if (ex.length) {
      text += "<ul>" + ex.map((x) => "<li><strong>" + esc(x[0]) + "</strong> (" + x[4] + ", " + (x[3] === "accepted" ? "accepted" : "rejected / more required") +
        "): “" + esc(clip(x[6], 220)) + "”" + c.add(x[0], x[1], "nam", x[5], x[6]) + "</li>").join("") + "</ul>";
    }
    return { text, cites: c, more: '<a href="nam-precedents.html">All non-animal precedents</a>' };
  }

  async function answerPmr(q, drug) {
    const rows = await load("pmr.json"); // [name, slug, id, authority, category, year, text, risk, rpage, rtext]
    const cats = pickAll(PMRCAT, q.replace(/\bprea\b/, ""));
    let r = rows.filter((x) => (!drug || x[1] === drug.slug) && (!cats.length || cats.includes(x[4])));
    if (!r.length) return null;
    const c = Cites();
    const auth = {}; r.forEach((x) => (auth[x[3]] = (auth[x[3]] || 0) + 1));
    let text = "<p>" + (drug ? "<strong>" + esc(drug.name) + "</strong> carries " : "") + "<strong>" + r.length +
      "</strong> postmarketing " + (r.length === 1 ? "item" : "items") + (cats.length ? " on " + esc(cats.join(", ")) : "") +
      (drug ? "" : " across " + new Set(r.map((x) => x[1])).size + " approvals") + " — by authority: " +
      Object.entries(auth).sort((a, b) => b[1] - a[1]).map(([k, n]) => esc(k) + " " + n).join(", ") + ".</p>";
    const ex = rankByTerms(r.filter((x) => x[8]).concat(r.filter((x) => !x[8])), q, 6, 5).slice(0, 5);
    text += "<ul>" + ex.map((x) => "<li><strong>" + esc(x[0]) + " " + esc(x[2]) + "</strong> (" + esc(x[3]) + ", " + x[5] + "): “" +
      esc(clip(x[6], 200)) + "”" + (x[7] ? " Risk named: " + esc(clip(x[7], 100)) + "." : "") +
      (x[9] ? " Review: “" + esc(clip(x[9], 200)) + "”" + c.add(x[0], x[1], "pmr", x[8], x[9]) : c.add(x[0], x[1], "pmr", 0, x[6])) +
      "</li>").join("") + "</ul>";
    return { text, cites: c, more: '<a href="postmarketing.html">All postmarketing requirements</a>' };
  }

  async function answerDiffered(q, drug) {
    const rows = await load("differed.json"); // [name, slug, verdict, discipline, topic, page, applicant, fda]
    const terms = q.split(/\W+/).filter((w) => w.length > 4 && !/disagree|agree|applicant|sponsor|where|which|drugs?|review/.test(w));
    let r = rows.filter((x) => (!drug || x[1] === drug.slug) && x[2] !== "qualified");
    if (terms.length) {
      const hit = r.filter((x) => terms.some((t) => (x[4] + " " + x[7]).toLowerCase().includes(t)));
      if (hit.length) r = hit;
    }
    if (!r.length) return null;
    const c = Cites();
    const by = {}; r.forEach((x) => (by[x[3]] = (by[x[3]] || 0) + 1));
    let text = "<p>FDA disagreed with, partly disagreed with, or corrected the applicant in <strong>" + r.length + "</strong> passages" +
      (drug ? " in the review of <strong>" + esc(drug.name) + "</strong>" : " across " + new Set(r.map((x) => x[1])).size + " approvals") +
      " — by discipline: " + Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => esc(k.replace(/_/g, " ")) + " " + n).join(", ") + ".</p>";
    const ranked = rankByTerms(r.map((x) => x.concat([x[4] + " " + x[7]])), q, 8, null);
    text += "<ul>" + ranked.filter((x) => x[2] === "disagree").slice(0, 3).concat(ranked.filter((x) => x[2] !== "disagree")).slice(0, 5).map((x) =>
      "<li><strong>" + esc(x[0]) + "</strong>" + (x[4] ? " — " + esc(x[4]) : "") + ": “" + esc(clip(x[7], 240)) + "”" +
      c.add(x[0], x[1], "differed", x[5], x[7]) + "</li>").join("") + "</ul>";
    return { text, cites: c, more: '<a href="disagreements.html">All disagreements</a>' };
  }

  // BM25 over every indexed passage; IDF is computed once the shards are in.
  let BM = null;
  const tok = (s) => s.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) || [];
  const STOPW = new Set("the a an of to and or in for on with by at as be is are was were that this from what which how does did do has have had any there their its it into than then when where who why will would can could should about".split(" "));
  async function bm25(q, drug, k) {
    const docs = await loadIndex();
    if (!BM) {
      const df = new Map(); let total = 0;
      const toks = docs.map((d) => { const t = tok(d.t); total += t.length; new Set(t).forEach((w) => df.set(w, (df.get(w) || 0) + 1)); return t; });
      BM = { df, toks, avg: total / docs.length, n: docs.length };
    }
    const qt = [...new Set(tok(q).filter((w) => !STOPW.has(w)))];
    const scored = [];
    docs.forEach((d, i) => {
      if (drug && d.u !== drug.slug) return;
      const t = BM.toks[i]; let s = 0;
      for (const w of qt) {
        const f = t.reduce((n, x) => n + (x === w), 0); if (!f) continue;
        const idf = Math.log(1 + (BM.n - (BM.df.get(w) || 0) + 0.5) / ((BM.df.get(w) || 0) + 0.5));
        s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * t.length / BM.avg));
      }
      if (s > 0) scored.push([s, d]);
    });
    scored.sort((a, b) => b[0] - a[0]);
    const out = [], seen = new Set();
    for (const [, d] of scored) { const key = d.u + d.t.slice(0, 50); if (!seen.has(key)) { seen.add(key); out.push(d); } if (out.length >= k) break; }
    return { hits: out, terms: qt };
  }

  async function answerSearch(q, drug) {
    const { hits, terms } = await bm25(q, drug, 8);
    if (!hits.length) return null;
    const c = Cites();
    const sentences = hits.slice(0, 4).map((d) => {
      const ss = d.t.split(/(?<=[.;])\s+(?=[A-Z(])/);
      const best = ss.map((s) => [terms.filter((w) => s.toLowerCase().includes(w)).length, s]).sort((a, b) => b[0] - a[0])[0][1];
      return "<li><strong>" + esc(d.n) + "</strong> (" + esc(d.l) + "): “" + esc(clip(best, 260)) + "”" + c.add(d.n, d.u, d.s, d.p, d.t) + "</li>";
    });
    return { text: "<p>The passages that best match the question" + (drug ? " in the review of <strong>" + esc(drug.name) + "</strong>" : "") +
      ":</p><ul>" + sentences.join("") + "</ul>", cites: c, more: '<a href="search.html?q=' + encodeURIComponent(q) + '">See all matching passages</a>' };
  }

  async function ask(raw) {
    const q = raw.toLowerCase();
    if (!DRUGS) DRUGS = await load("drugs.json");
    const drug = drugIn(q);
    const it = intent(q);
    const route = { margins: answerMargins, nam: answerNam, pmr: answerPmr, differed: answerDiffered, search: answerSearch }[it];
    let a = await route(q, drug);
    let used = it;
    if (!a && it !== "search") { a = await answerSearch(q, drug); used = "search"; }
    return { a, used, drug };
  }

  // ---- page wiring ----------------------------------------------------------------------------------------------
  const ROUTE_LABEL = { margins: "safety-margin data", nam: "non-animal precedent data", pmr: "postmarketing requirement data",
    differed: "FDA–applicant disagreement data", search: "full-text ranking of review passages" };
  async function run(e) {
    if (e) e.preventDefault();
    const q = $("q").value.trim(); if (!q) return;
    history.replaceState(null, "", "?q=" + encodeURIComponent(q));
    $("out").innerHTML = '<p class="meta">Working…</p>';
    try {
      const { a, used, drug } = await ask(q);
      $("out").innerHTML = a ? '<p class="meta">Answered from ' + ROUTE_LABEL[used] + (drug ? ", limited to " + esc(drug.name) : "") + ".</p>" +
        a.text + a.cites.html() + '<p class="meta">' + a.more + "</p>"
        : '<p class="note">Nothing in the indexed reviews matches that question. Try naming a species, study type, drug or subject.</p>';
    } catch (err) { $("out").innerHTML = '<p class="note warn">Could not load the data: ' + esc(err.message) + "</p>"; }
  }
  window.TiberiusAsk = ask; // for testing from the console
  $("f").addEventListener("submit", run);
  document.querySelectorAll("[data-ex]").forEach((b) => b.addEventListener("click", () => { $("q").value = b.dataset.ex; run(); }));
  const p = new URLSearchParams(location.search).get("q"); if (p) { $("q").value = p; run(); }
})();
