/* Concepts below the explorer: glossary filter and fact-status playground. */
(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const LANG = document.documentElement.lang === "es" ? "es" : "en";
  const termLabel = (term) => (LANG === "es" ? term.labelEs || term.label : term.label);

  /* ── glossary ─────────────────────────────────────────────────────── */

  const grid = $("#glossary-grid");
  if (grid && window.GLOSSARY) {
    const terms = window.GLOSSARY.terms.slice().sort((a, b) => termLabel(a).localeCompare(termLabel(b)));
    grid.innerHTML = terms.map((term) => `
      <div class="glossary-item" data-key="${term.key}" data-search="${(termLabel(term) + " " + (term.labelEs || "") + " " + term[LANG]).toLowerCase()}">
        <dt>${termLabel(term)}</dt>
        <dd>${term[LANG]}</dd>
        ${term.node ? `<button type="button" class="glossary-node" data-node="${term.node}">${LANG === "es" ? "ver en el grafo" : "show in graph"}</button>` : ""}
      </div>`).join("");
    const filter = $("#glossary-filter");
    const count = $("#glossary-count");
    function applyFilter() {
      const query = (filter.value || "").trim().toLowerCase();
      let visible = 0;
      for (const item of $$(".glossary-item", grid)) {
        const match = query === "" || item.dataset.search.includes(query);
        item.hidden = !match;
        if (match) visible += 1;
      }
      count.textContent = `${visible} / ${terms.length}`;
    }
    filter.addEventListener("input", applyFilter);
    applyFilter();

    window.explorerShowTerm = (key) => {
      filter.value = key;
      applyFilter();
      $("#concept-glossary").scrollIntoView({ behavior: "smooth", block: "start" });
    };

    for (const button of $$(".glossary-node", grid)) {
      button.addEventListener("click", () => {
        if (typeof window.explorerOpenNode === "function") window.explorerOpenNode(button.dataset.node);
        else $("#graph-canvas").scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }

  /* ── fact playground ──────────────────────────────────────────────── */

  const CUT_RANK = { depth: 0, hub: 1, "caller-budget": 2, "node-cap": 3, deadline: 4, "unresolved-link": 5, "no-extractor": 6, "not-exported": 7, section: 8 };
  const CUT_EXAMPLE = {
    depth: { kind: "depth", at: ["src/api/orders.ts::applyDiscount"], limit: 2 },
    hub: { kind: "hub", at: ["src/shared/logger.ts::log"], limit: 10 },
    "unresolved-link": { kind: "unresolved-link", at: ["src/auth/auth.service.ts::login", "src/auth/auth.service.ts:42 computed member"] },
    "no-extractor": { kind: "no-extractor", at: ["src/legacy/report.rb"] },
    "not-exported": { kind: "not-exported", at: ["vendor/generated"] },
  };
  const factUnknown = $("#fact-unknown");
  const factStatus = $("#fact-status");
  const factJson = $("#fact-json");

  function highlightJSON(text) {
    const escaped = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    return escaped.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g, (match, string, colon, bool) => {
      if (string) return colon ? `<span class="c-key">${string}</span>${colon}` : `<span class="c-str">${string}</span>`;
      if (bool) return `<span class="c-warn">${bool}</span>`;
      return `<span class="c-num">${match}</span>`;
    });
  }

  function renderFact() {
    if (!factStatus || !factJson || !factUnknown) return;
    const cuts = $$("[data-cut-toggle]").filter((input) => input.checked).map((input) => CUT_EXAMPLE[input.dataset.cutToggle]).filter(Boolean);
    cuts.sort((a, b) => CUT_RANK[a.kind] - CUT_RANK[b.kind]);
    const unknown = factUnknown.checked;
    const status = unknown ? "unknown" : cuts.length > 0 ? "partial" : "complete";
    const changed = factStatus.textContent !== status;
    factStatus.textContent = status;
    if (changed) {
      factStatus.classList.remove("is-stamped");
      void factStatus.getBoundingClientRect();
      factStatus.classList.add("is-stamped");
    }
    factStatus.classList.toggle("ok", status === "complete");
    factStatus.classList.toggle("warn", status === "partial");
    factStatus.classList.toggle("bad", status === "unknown");
    const value = unknown ? { status, reason: "index-unavailable" } : { status, ...(cuts.length > 0 ? { cuts } : {}) };
    factJson.innerHTML = highlightJSON(JSON.stringify(value, null, 2));
  }
  for (const input of $$("[data-cut-toggle]")) input.addEventListener("change", renderFact);
  if (factUnknown) factUnknown.addEventListener("change", renderFact);
  const reset = $("#fact-reset");
  if (reset) {
    reset.addEventListener("click", () => {
      for (const input of $$("[data-cut-toggle]")) input.checked = false;
      factUnknown.checked = false;
      renderFact();
    });
  }
  renderFact();

  /* ── motion: sections rise from their horizon, sequences build piece by piece ── */

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const BUILDS = [".status-grid", ".trust-lanes", ".lane-steps", ".surface-diagram", ".fact-list", ".glossary-grid", ".input-chips"];
  for (const container of $$(BUILDS.map((selector) => `.docs ${selector}`).join(","))) {
    container.classList.add("build");
    Array.from(container.children).forEach((child, index) => child.style.setProperty("--i", String(Math.min(index, 12))));
  }
  const rising = $$(".docs .doc-section, .docs .reveal, .docs .build");
  document.documentElement.classList.add("has-motion");
  if (reduced || !("IntersectionObserver" in window)) {
    for (const element of rising) element.classList.add("is-in");
  } else {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });
    for (const element of rising) observer.observe(element);
  }

  const nav = $(".docs-nav");
  if (nav && "IntersectionObserver" in window) {
    const marker = document.createElement("span");
    marker.className = "docs-nav-marker";
    marker.setAttribute("aria-hidden", "true");
    nav.appendChild(marker);
    const links = $$("a[href^='#']", nav);
    const linkFor = new Map(links.map((link) => [link.getAttribute("href").slice(1), link]));
    const mark = (link) => {
      for (const candidate of links) candidate.classList.toggle("is-current", candidate === link);
      if (link) {
        marker.style.width = `${link.offsetWidth}px`;
        marker.style.transform = `translateX(${link.offsetLeft}px)`;
      }
      marker.classList.toggle("is-visible", Boolean(link));
    };
    const spy = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) mark(linkFor.get(entry.target.id));
    }, { rootMargin: "-35% 0px -60% 0px" });
    for (const id of linkFor.keys()) {
      const target = document.getElementById(id);
      if (target) spy.observe(target);
    }
  }
})();
