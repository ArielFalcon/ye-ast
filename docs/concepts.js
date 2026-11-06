/* Page chrome and concept sections: glossary terms in the text, section motion, the section rail and title marks. */
(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const LANG = document.documentElement.lang === "es" ? "es" : "en";
  const termLabel = (term) => (LANG === "es" ? term.labelEs || term.label : term.label);

  /* ── glossary terms in the text ───────────────────────────────────── */

  /** The first mention of a glossary term in each section becomes a button that opens the term's definition. A phrase
   * that names more than one term is ambiguous and stays plain; headings, labels, code, links, controls and the explorer
   * stay untouched. */
  const TERMS = window.GLOSSARY ? window.GLOSSARY.terms : [];
  const TERM_TEXT = {
    show: LANG === "es" ? "Ver en el grafo" : "Show in graph",
    close: LANG === "es" ? "Cerrar" : "Close",
  };
  const SKIP = "code, pre, kbd, a, button, label, summary, svg, h1, h2, h3, h4, h5, h6, input, select, textarea, .kicker, .mini-kicker, .eyebrow, .pill, .chip, .explorer, .playground, .term-pop, script, style";
  const phraseOwners = new Map();
  for (const term of TERMS) {
    const label = termLabel(term);
    if (label.includes("/")) continue;
    const phrase = label.toLowerCase();
    phraseOwners.set(phrase, phraseOwners.has(phrase) ? null : term);
  }
  const phrases = [...phraseOwners].filter(([, term]) => term).map(([phrase]) => phrase).sort((a, b) => b.length - a.length);
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const phrasePattern = phrases.length ? new RegExp(`(?<![\\p{L}\\p{N}_-])(${phrases.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_-])`, "iu") : null;

  const markSection = (section) => {
    const seen = new Set();
    const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement && !node.parentElement.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (let node of textNodes) {
      let match;
      while (node && (match = phrasePattern.exec(node.data))) {
        const term = phraseOwners.get(match[1].toLowerCase());
        if (seen.has(term.key)) {
          const rest = node.splitText(match.index + match[1].length);
          node = rest;
          continue;
        }
        seen.add(term.key);
        const word = node.splitText(match.index);
        const rest = word.splitText(match[1].length);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "term-ref";
        button.dataset.term = term.key;
        button.setAttribute("aria-expanded", "false");
        button.textContent = word.data;
        word.replaceWith(button);
        node = rest;
      }
    }
  };
  if (phrasePattern) $$(".docs .doc-section").forEach(markSection);

  const termPop = document.createElement("div");
  termPop.className = "term-pop";
  termPop.setAttribute("role", "dialog");
  termPop.hidden = true;
  document.body.append(termPop);
  let termOwner = null;

  const closeTerm = () => {
    if (!termOwner) return;
    termOwner.setAttribute("aria-expanded", "false");
    termOwner.classList.remove("is-open");
    termPop.hidden = true;
    termOwner = null;
  };
  const openTerm = (button) => {
    const term = TERMS.find((candidate) => candidate.key === button.dataset.term);
    if (!term) return;
    closeTerm();
    termOwner = button;
    button.setAttribute("aria-expanded", "true");
    button.classList.add("is-open");
    termPop.setAttribute("aria-label", termLabel(term));
    termPop.innerHTML = `<strong>${termLabel(term)}</strong><p>${term[LANG]}</p>
      <div class="term-pop-actions">${term.node ? `<button type="button" class="small-button" data-term-node>${TERM_TEXT.show}</button>` : ""}<button type="button" class="small-button" data-term-close>${TERM_TEXT.close}</button></div>`;
    termPop.hidden = false;
    const anchor = button.getBoundingClientRect();
    const width = termPop.offsetWidth;
    const left = Math.min(Math.max(8, anchor.left), document.documentElement.clientWidth - width - 8);
    termPop.style.left = `${left + window.scrollX}px`;
    termPop.style.top = `${anchor.bottom + window.scrollY + 6}px`;
    const show = $("[data-term-node]", termPop);
    if (show) show.addEventListener("click", () => { closeTerm(); if (typeof window.explorerOpenNode === "function") window.explorerOpenNode(term.node, term.key); });
    $("[data-term-close]", termPop).addEventListener("click", () => { const owner = termOwner; closeTerm(); owner.focus(); });
    (show || $("[data-term-close]", termPop)).focus({ preventScroll: true });
  };
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const ref = event.target.closest(".term-ref");
    if (ref) {
      if (ref === termOwner) closeTerm();
      else openTerm(ref);
      return;
    }
    if (!event.target.closest(".term-pop")) closeTerm();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !termOwner) return;
    const owner = termOwner;
    closeTerm();
    owner.focus();
  });
  window.addEventListener("resize", closeTerm);

  /* ── motion: sections rise from their horizon, sequences build piece by piece ── */

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const BUILDS = [".stat-strip", ".status-grid", ".trust-lanes", ".lane-steps", ".surface-diagram", ".compose-flow", ".fact-list", ".input-chips"];
  for (const container of $$(BUILDS.map((selector) => `.docs ${selector}`).join(","))) {
    container.classList.add("build");
    Array.from(container.children).forEach((child, index) => child.style.setProperty("--i", String(Math.min(index, 12))));
  }
  /* A clipped element has no visible area to intersect, so a reveal is watched through its parent. */
  const rising = new Map();
  for (const element of $$(".docs .doc-section, .docs .build")) rising.set(element, [element]);
  for (const element of $$(".docs .reveal")) {
    const watched = element.parentElement;
    rising.set(watched, [...(rising.get(watched) || []), element]);
  }
  document.documentElement.classList.add("has-motion");
  if (reduced || !("IntersectionObserver" in window)) {
    for (const targets of rising.values()) for (const element of targets) element.classList.add("is-in");
  } else {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const element of rising.get(entry.target)) element.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });
    for (const watched of rising.keys()) observer.observe(watched);
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

  /* ── header mark ──────────────────────────────────────────────────── */

  /** The header shows the logo only while the hero title, which carries the large logo, is out of view. */
  const brand = $(".brand");
  const heroTitle = $(".hero-copy h1");
  if (brand && heroTitle) {
    new IntersectionObserver(([entry]) => brand.classList.toggle("has-mark", !entry.isIntersecting)).observe(heroTitle);
  }

  /* ── title marks ──────────────────────────────────────────────────── */

  /** The logo beside the hero title and the ornament beside each section title are as tall as the title's lines,
   * between one and MAX_MARK_LINES. A taller mark narrows the text and can only add lines, so growing it from zero
   * until the line count stops changing reaches the fixed point. */
  const titles = $$(".hero-copy h1, .section-head h2");
  const MAX_MARK_LINES = 2;
  const lineCount = (title) => {
    const range = document.createRange();
    range.selectNodeContents(title);
    return new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
  };
  const fitTitleMark = (title) => {
    const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
    let lines = 0;
    for (let pass = 0; pass < 6; pass += 1) {
      title.style.setProperty("--title-mark", `${lines * lineHeight}px`);
      const next = Math.min(Math.max(lineCount(title), 1), MAX_MARK_LINES);
      if (next === lines) return;
      lines = next;
    }
    title.style.setProperty("--title-mark", `${lines * lineHeight}px`);
  };
  let fitFrame = 0;
  const fitTitleMarks = () => {
    fitFrame = 0;
    titles.forEach(fitTitleMark);
  };
  fitTitleMarks();
  window.addEventListener("resize", () => { if (!fitFrame) fitFrame = requestAnimationFrame(fitTitleMarks); });
})();
