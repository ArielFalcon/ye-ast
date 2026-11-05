/* Page chrome and concept sections: glossary filter, fact-status playground, section motion and the section rail. */
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
  const BUILDS = [".stat-strip", ".status-grid", ".trust-lanes", ".lane-steps", ".surface-diagram", ".fact-list", ".glossary-grid", ".input-chips"];
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

  const hero = $(".docs .hero");
  if (hero) {
    $$(".fl-node", hero).forEach((node, index) => node.style.setProperty("--i", String(index)));
    $$(".fl-edge", hero).forEach((edge, index) => {
      edge.setAttribute("pathLength", "100");
      edge.style.setProperty("--i", String(index));
    });
  }

  /* ── section rail: one brick per section, the current one fills as you read ── */

  const rail = $("#rail");
  const railSections = $$("[data-rail]");
  if (rail && railSections.length > 0) {
    const list = document.createElement("ol");
    const items = railSections.map((section) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.className = "rail-item";
      link.href = `#${section.id}`;
      link.innerHTML = '<span class="rail-brick"><span class="rail-fill"></span></span><span class="rail-label"></span>';
      $(".rail-label", link).textContent = section.dataset.rail;
      item.appendChild(link);
      list.appendChild(item);
      return link;
    });
    const heat = document.createElement("span");
    heat.className = "rail-heat";
    heat.setAttribute("aria-hidden", "true");
    rail.append(heat, list);
    const barSection = $("#bar-section");
    let current = -1;
    let frame = 0;
    const clamp = (value) => Math.min(1, Math.max(0, value));
    const update = () => {
      frame = 0;
      const line = window.innerHeight * 0.35;
      const total = clamp(window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight));
      let index = 0;
      let progress = 0;
      railSections.forEach((section, position) => {
        const box = section.getBoundingClientRect();
        if (box.top > line) return;
        index = position;
        progress = clamp((line - box.top) / box.height);
      });
      if (total > 0.995) { index = railSections.length - 1; progress = 1; }
      rail.style.setProperty("--total", total.toFixed(4));
      items.forEach((link, position) => {
        link.classList.toggle("is-passed", position < index);
        link.classList.toggle("is-current", position === index);
      });
      items[index].style.setProperty("--p", progress.toFixed(4));
      if (index === current) return;
      if (current >= 0) items[current].removeAttribute("aria-current");
      current = index;
      items[index].setAttribute("aria-current", "location");
      if (barSection) {
        barSection.textContent = railSections[index].dataset.rail;
        barSection.classList.remove("is-stamped");
        void barSection.getBoundingClientRect();
        barSection.classList.add("is-stamped");
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    update();
  }
})();
