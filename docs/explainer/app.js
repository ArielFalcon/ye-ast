/* ye-ast explainer · plain browser JavaScript, no build, no dependencies */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (value) =>
    String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const LANG = document.documentElement.lang === "es" ? "es" : "en";
  const ES = LANG === "es" ? window.EXPLAINER_ES : null;

  const EN_UI = {
    themeToLight: "Switch to light theme",
    themeToDark: "Switch to dark theme",
    themeLight: "Light theme",
    themeDark: "Dark theme",
    atlasKicker: "atlas",
    mayImport: "may import",
    never: "never",
    owns: "what it owns",
    files: "files",
    allowed: "allowed",
    forbidden: "forbidden: {from} → {to}. The rule is never weakened to let a change through.",
    forbiddenException: "forbidden, with one frozen exception: spring → tree-sitter syntax trees",
    stage: "stage",
    inAtlas: "in the atlas",
    why: "why it matters",
    fanIn: "fan-in",
    noCuts: "no cuts: the frontier emptied.",
    noEntrypoint: "no entrypoint reached",
    notReached: "not reached",
    none: "none",
    limit: "limit",
    handler: "handler",
    guard: "guard",
    rejected: "rejected",
    ignored: "ignored",
    everyEdgeFollowed: "every edge that touched the walk was followed",
    testsNeverCallers: "tests are never callers",
    navigationNotDependence: "navigation is not dependence",
    fileNodeNowhere: "a file node leads nowhere",
    referencesOff: "references are off in this teaching override",
    relationsOff: "Angular relations are off in this teaching override",
    noPolicyRow: "the edge policy has no row for it",
    noPolicyEdges: "No edge was skipped for the nodes this walk touched.",
    selected: "selected",
    notReachedWalk: "not reached by this walk",
    depth: "depth",
    confidence: "confidence",
    seed: "seed",
    via: "via",
    walkDirection: "walk →",
    callsDirection: "calls ←",
    joinedTo: "joined to",
    settled: "settled",
    layerNames: {
      entrypoints: "driving adapter",
      composition: "composition root",
      application: "application · use case",
      domain: "domain · pure rule",
      ports: "port · contract",
      adapters: "driven adapter",
    },
  };
  const T = ES ? ES.ui : EN_UI;

  /* ── theme ─────────────────────────────────────────────────────────── */

  const root = document.documentElement;
  try {
    const stored = localStorage.getItem("yeast-theme");
    if (stored === "light" || stored === "dark") root.dataset.theme = stored;
  } catch (_) { /* file:// may refuse storage; the default is dark */ }

  const themeToggle = $("#theme-toggle");
  function syncTheme() {
    const light = root.dataset.theme === "light";
    themeToggle.setAttribute("aria-pressed", String(light));
    themeToggle.setAttribute("aria-label", light ? T.themeToDark : T.themeToLight);
    themeToggle.title = light ? T.themeDark : T.themeLight;
  }
  themeToggle.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    try { localStorage.setItem("yeast-theme", root.dataset.theme); } catch (_) { /* ignore */ }
    syncTheme();
  });
  syncTheme();

  /* ── navigation ────────────────────────────────────────────────────── */

  const sections = $$("main section[id]");
  const railLinks = $$("[data-rail]");
  let scrollFrame = 0;
  function syncRail() {
    scrollFrame = 0;
    let current = sections[0] && sections[0].id;
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= 150) current = section.id;
    }
    for (const link of railLinks) link.classList.toggle("is-active", link.dataset.rail === current);
  }
  function requestRail() {
    if (scrollFrame === 0) scrollFrame = requestAnimationFrame(syncRail);
  }
  window.addEventListener("scroll", requestRail, { passive: true });
  syncRail();

  const mobileSection = $("#mobile-section");
  if (mobileSection !== null) {
    mobileSection.addEventListener("change", () => {
      const target = document.getElementById(mobileSection.value);
      if (target !== null) target.scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth", block: "start" });
      mobileSection.value = "";
    });
  }

  for (const link of $$(".lang-switch")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      window.location.href = link.getAttribute("href") + window.location.hash;
    });
  }

  /* ── reveal on scroll ──────────────────────────────────────────────── */

  const revealTargets = $$(".section-head, .status-card, .identity-card, .cut-block, .playground, .command-card, .real-head, .run-card, .simulator, .deep-dives, .query-card, .choose-table, .lane, .callout, .invariants, .surface-diagram, .mcp-note, .verdict, .evidence-table, .limits, .reproduce");
  if (!prefersReduced && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) { entry.target.classList.add("is-in"); observer.unobserve(entry.target); }
      }
    }, { threshold: 0.06 });
    for (const target of revealTargets) { target.classList.add("reveal"); observer.observe(target); }
  }

  /* ── atlas ─────────────────────────────────────────────────────────── */

  const LAYER_VAR = {
    entrypoints: "entry",
    composition: "composition",
    application: "application",
    domain: "domain",
    ports: "ports",
    adapters: "adapters",
  };


  const ATLAS = {
    cli: {
      layer: "entrypoints",
      role: "Turns argv into one query call and shapes stdout and stderr. The CLI is a driving adapter: it knows arguments and exit codes, never git or codegraph.",
      may: "core/ports, core/domain",
      never: "core/adapters, core/application use cases",
      facts: [
        "Exit codes: 0 ok, 1 typed fault, 2 usage, 70 internal, 130 interrupted.",
        "Every string that leaves the process passes through redaction.",
        "Usage and parsing live in one file; composition supplies the query families.",
      ],
      files: ["src/cli/main.ts"],
    },
    mcp: {
      layer: "entrypoints",
      role: "A stdio MCP server bound to one repository. It exposes read-only tools and returns the fact plus the cut guidance an agent needs to act on it.",
      may: "core/ports, core/domain",
      never: "core/adapters, a write of any kind",
      facts: [
        "McpDeps holds only read query families, so a write is impossible by type.",
        "Tools: ye_ast_entrypoints, ye_ast_impact, ye_ast_callers, ye_ast_importers, ye_ast_workspace.",
        "CUT_GUIDANCE is exhaustive over Cut[\"kind\"], so a new cut fails to compile until the agent is told how to act.",
      ],
      files: ["src/mcp/server.ts", "src/composition/mcp.ts"],
    },
    protocol: {
      layer: "entrypoints",
      role: "The query protocol: JSON-RPC 2.0, one message per line over stdio. A host can run ye-ast as a process and keep the query families behind it.",
      may: "core/ports, core/domain",
      never: "core/adapters, another entrypoint",
      facts: [
        "stdout carries only protocol lines; measurements and diagnostics go to stderr.",
        "The four per-repository operations: entrypoints.map, impact.ofChange, impact.callers, impact.importers.",
        "trust.declare is the protocol's one administrative call; it declares the trust mode outside the repository.",
      ],
      files: ["src/protocol/query-server.ts", "src/protocol/query-client.ts"],
    },
    later: {
      layer: "entrypoints",
      role: "Hooks and the daemon are later driving adapters. They will call the same query families; they do not change the core.",
      may: "core/ports, core/domain",
      never: "core/adapters, the core's decisions",
      facts: [
        "The delivery order puts the library, map, install, serve and the stdio MCP first; hooks and a daemon after.",
        "The daemon will host lifecycle, the socket server, watcher scheduling and the single writer.",
      ],
      files: ["docs/architecture/adr/0005-runtime-topology-and-delivery-order.md"],
    },
    composition: {
      layer: "composition",
      role: "The root: builds every adapter, chooses in-process or protocol-backed query families, and wires the entrypoints. It is the only place that knows both sides.",
      may: "everything",
      never: "nothing: it is the composition root",
      facts: [
        "One build of the graph, one trust record, one index cache, one redaction module.",
        "The MCP never knows whether it talks to the core in-process or, through the protocol, to the daemon.",
        "The edge-policy digest is part of the producer version, so a policy change invalidates facts.",
      ],
      files: ["src/composition/compose.ts", "src/composition/main.ts"],
    },
    "app-impact": {
      layer: "application",
      role: "Orchestrates the change-to-fact pipeline: resolve, export, diff, extract, index, seed, walk, join, cut. It decides what to read; adapters decide how.",
      may: "core/domain, core/ports, other application subdomains",
      never: "core/adapters",
      facts: [
        "One body for a commit and one for a live tree; only the head reading changes.",
        "The walk reads only the head's index; the merge base is extracted for entrypoint changes, not indexed.",
        "Every bound and every blind spot becomes a cut before the fact is built.",
      ],
      files: ["src/core/application/impact/impact-queries.ts", "src/core/application/impact/walk.ts", "src/core/application/impact/inbound-edges.ts"],
    },
    "app-entrypoints": {
      layer: "application",
      role: "The map use case: resolve a revision, export an in-scope snapshot, run the entrypoint extractors, and wrap the findings in a fact.",
      may: "core/domain, core/ports",
      never: "core/adapters",
      facts: [
        "Each item is a Finding: status, value or reason, and evidence.",
        "The collection is the fact; the map nests one section fact for its entrypoints.",
        "A live map reads the mirror but no store, so it carries no index origin.",
      ],
      files: ["src/core/application/entrypoints/entrypoint-queries.ts"],
    },
    "app-live": {
      layer: "application",
      role: "Refreshes the mirror of a trusted working tree, holds the lock, syncs changed paths, commits the state, and reports staleness without changing the answer.",
      may: "core/domain, core/ports",
      never: "core/adapters",
      facts: [
        "The first live query builds the mirror in full; later ones sync only changed paths.",
        "A lock held through the answer serializes live queries on one mirror.",
        "A stale answer says so on stderr; the fact itself is unchanged.",
      ],
      files: ["src/core/application/live/live-tree.ts"],
    },
    "app-topology": {
      layer: "application",
      role: "Composes per-repository facts into a workspace answer: outward names, call sites, gateways and the links between repositories.",
      may: "core/domain, core/ports, other application subdomains",
      never: "core/adapters",
      facts: [
        "Cross-repository impact is a composition, not a second walk.",
        "It makes no network request: a name nothing serves is the next clone to make.",
        "Each repository is read under its own trust declaration.",
      ],
      files: ["src/core/application/topology/workspace-queries.ts", "src/core/application/topology/workspace-impact.ts"],
    },
    "app-install": {
      layer: "application",
      role: "Declares trust, adds ye-ast's folders to the local exclude, persists the workspace manifest, and writes the fixed layer.",
      may: "core/domain, core/ports",
      never: "core/adapters",
      facts: [
        "The trust record is written outside the repository.",
        "The local exclude holds .ye-ast/ and .ye-ast-graph/.",
        "The fixed layer applies the redaction patterns only; stored facts are not redacted.",
      ],
      files: ["src/core/application/install/install.ts", "src/core/application/fixed-layer/fixed-layer-admin.ts"],
    },
    "app-snapshot": {
      layer: "application",
      role: "The shared snapshot reader: export a commit, read the exported files, extract entrypoints, and build the fact base every family starts from.",
      may: "core/domain, core/ports",
      never: "core/adapters",
      facts: [
        "The export writes only the files the caller selects; the scope filters what is written and what the fact covers.",
        "The content fingerprint is the digest of the in-scope files, not the whole repository.",
        "Trust is read from the record; a missing or unusable record means untrusted.",
      ],
      files: ["src/core/application/snapshot/read-snapshot.ts"],
    },
    "domain-impact": {
      layer: "domain",
      role: "The pure rules of impact: the edge policy, the cut taxonomy, the entrypoint join, changed entrypoints, and the fact's ordering.",
      may: "core/domain only",
      never: "ports, adapters, Node built-ins",
      facts: [
        "The edge policy is data; the walk reads it, never hard-codes an edge kind.",
        "A cut names where the computation stopped, not just that it did.",
        "Order is part of the contract: depth, file, line, symbol.",
      ],
      files: ["src/core/domain/impact/edge-policy.ts", "src/core/domain/impact/impact-cuts.ts", "src/core/domain/impact/reached-entrypoints.ts"],
    },
    "domain-change": {
      layer: "domain",
      role: "Reads a unified diff with no context, selects seeds from touched lines, and shapes the blast radius.",
      may: "core/domain only",
      never: "ports, adapters, Node built-ins",
      facts: [
        "The diff reader consumes one line at a time; a large diff is never held whole.",
        "A seed carries its basis: lines, top-level, resource or requested.",
        "A removed name survives as a potential cut, never as a node.",
      ],
      files: ["src/core/domain/change/diff-reader.ts", "src/core/domain/change/seeds.ts", "src/core/domain/change/blast-radius.ts"],
    },
    "domain-entrypoints": {
      layer: "domain",
      role: "The shapes of an entrypoint: an HTTP route, a UI route, a message listener, a scheduled job, and the handler that serves it.",
      may: "core/domain only",
      never: "ports, adapters, Node built-ins",
      facts: [
        "A route is identified by method, path, version and handler; the base path is a separate finding.",
        "A UI route names the component it shows, or unknown when the sources do not name one.",
        "A guard is a declaration, joined by file and name.",
      ],
      files: ["src/core/domain/entrypoints/entrypoint.ts", "src/core/domain/entrypoints/http-route.ts", "src/core/domain/entrypoints/ui-route.ts"],
    },
    "domain-map": {
      layer: "domain",
      role: "The entrypoint map fact: in-scope path rules, the content fingerprint, export cuts, and the nested section fact.",
      may: "core/domain only",
      never: "ports, adapters, Node built-ins",
      facts: [
        "The map covers Java, TypeScript, Angular templates, Spring config, OpenAPI and build files.",
        "A budget stop is a caller-budget cut, never a silent truncation.",
        "Scope selects the content the answer is about; the configuration that interprets it is always read. Completeness is relative to the scope.",
      ],
      files: ["src/core/domain/map/entrypoint-map.ts"],
    },
    "domain-shared": {
      layer: "domain",
      role: "The vocabulary every subdomain shares: the fact, the cut, the scope, the result, the canonical JSON, and the one join between graph and fact.",
      may: "core/domain only",
      never: "ports, adapters, Node built-ins",
      facts: [
        "A fact is complete, partial with cuts, or unknown with a reason. There is no fourth state.",
        "The join is file, line inside the span, and the same simple name.",
        "A fact's identity is schema + inputs + producer.",
      ],
      files: ["src/core/domain/shared/fact.ts", "src/core/domain/shared/code-node.ts", "src/core/domain/shared/scope.ts"],
    },
    ports: {
      layer: "ports",
      role: "Contracts the core offers or needs. One port per file; the core declares what it needs, the adapter implements it.",
      may: "core/domain, core/ports",
      never: "core/adapters, core/application",
      facts: [
        "CodeGraph, Vcs, SourceReader, IndexCache, SnapshotAdmin, FixedLayerAdmin, WorkspaceQueries…",
        "GraphNodeId is a handle, never a fact: it never reaches an output.",
        "A port is named by the consumer, so the core never imports a technology.",
      ],
      files: ["src/core/ports/code-graph.port.ts", "src/core/ports/vcs.port.ts", "src/core/ports/impact-queries.port.ts"],
    },
    "adapter-codegraph": {
      layer: "adapters",
      role: "Runs codegraph in a child process over an exported snapshot or a mirror, checks the store's versions, and exposes a read-only reader.",
      may: "core/domain, core/ports, libraries",
      never: "core/application, another adapter",
      facts: [
        "Raw SQL against the store lives here alone; the rest of the code sees a reader.",
        "DO_NOT_TRACK=1 always; the codegraph CLI shim is never called.",
        "An index is keyed by staged content; an unsupported store is refused, not repaired.",
      ],
      files: ["src/core/adapters/codegraph/codegraph.adapter.ts", "src/core/adapters/codegraph/stage-snapshot.ts"],
    },
    "adapter-git": {
      layer: "adapters",
      role: "Exports a commit with plumbing, reads a pinned diff, resolves revisions and merge bases, and refreshes declared remotes under trusted.",
      may: "core/domain, core/ports, libraries",
      never: "core/application, another adapter",
      facts: [
        "ls-tree lists; cat-file streams each blob. A blob is never held whole.",
        "diff-tree pins every option that changes hunks, including --text and --unified=0.",
        "An isolated git run empties user and system configuration.",
      ],
      files: ["src/core/adapters/git/git-vcs.adapter.ts", "src/core/adapters/git/git-working-tree.adapter.ts"],
    },
    "adapter-fs": {
      layer: "adapters",
      role: "The confined reader, the live mirror, the fixed-layer store, the trust record, the path matcher and the scratch directory.",
      may: "core/domain, core/ports, libraries",
      never: "core/application, another adapter",
      facts: [
        "Every repository path goes through the confined reader.",
        "The mirror copies files, never hard-links them.",
        "A mirror or cache directory must be private to the account.",
      ],
      files: ["src/core/adapters/fs/fs-source-reader.adapter.ts", "src/core/adapters/fs/live-mirror.adapter.ts", "src/core/adapters/fs/path-matcher.adapter.ts"],
    },
    "adapter-typescript": {
      layer: "adapters",
      role: "The TypeScript compiler API: Angular routes, declarations, metadata, template usage, dynamic loads and HTTP call sites.",
      may: "core/domain, core/ports, libraries",
      never: "core/application, another adapter",
      facts: [
        "Every use of the compiler API lives under core/adapters/typescript.",
        "TypeScript stays on 6.0.3, the last line with the compiler API the extractors need.",
        "The Angular router extractor reads source; nothing is built or run.",
      ],
      files: ["src/core/adapters/typescript/angular-routes.adapter.ts", "src/core/adapters/typescript/angular-metadata.adapter.ts"],
    },
    "adapter-spring": {
      layer: "adapters",
      role: "Reads Spring routes, listeners, call sites, config base paths and OpenAPI contracts from Java sources.",
      may: "core/domain, core/ports, libraries, tree-sitter syntax trees (frozen exception)",
      never: "core/application, another adapter (except the frozen tree-sitter read)",
      facts: [
        "It is the one adapter-to-adapter exception: it reads the syntax trees of tree-sitter.",
        "The route's base path is a Finding per configuration document and profile.",
        "Declared contracts are joined to the code that implements them.",
      ],
      files: ["src/core/adapters/spring/spring-routes.adapter.ts", "src/core/adapters/spring/findings.ts"],
    },
    "adapter-treesitter": {
      layer: "adapters",
      role: "Parses Java into syntax trees for the Spring adapter. It decides syntax, not routes.",
      may: "core/domain, core/ports, libraries",
      never: "core/application, another adapter",
      facts: [
        "web-tree-sitter and tree-sitter-java are pinned engines.",
        "Its version is part of the fact's engines, so an upgrade changes the fact identity.",
      ],
      files: ["src/core/adapters/tree-sitter/java-parser.adapter.ts"],
    },
    "adapter-angular": {
      layer: "adapters",
      role: "Reads Angular template usage through @angular/compiler: what a template renders, binds or projects.",
      may: "core/domain, core/ports, libraries",
      never: "core/application, another adapter",
      facts: [
        "It turns a template use into a relation the walk can follow.",
        "A relation it cannot place is reported as unknown and becomes an unresolved-link cut.",
      ],
      files: ["src/core/adapters/angular-compiler/template-usage.adapter.ts"],
    },
    "adapter-openapi": {
      layer: "adapters",
      role: "Reads declared HTTP contracts and joins them to the code that serves them.",
      may: "core/domain, core/ports, libraries",
      never: "core/application, another adapter",
      facts: [
        "A contract route is a fact, not a guess from a string in code.",
        "The join uses the same simple-name discipline as the graph join.",
      ],
      files: ["src/core/adapters/openapi/contract-document.adapter.ts"],
    },
    "adapter-redaction": {
      layer: "adapters",
      role: "Applies the redaction patterns to every string that leaves the process, and by-value secrets only in the process that already holds them.",
      may: "core/domain, core/ports, libraries",
      never: "core/application, another adapter",
      facts: [
        "The CLI redacts stdout and stderr; the MCP redacts its answers.",
        "Stored facts are not redacted; the fixed layer applies the patterns only.",
      ],
      files: ["src/core/adapters/redaction/pattern-redaction.adapter.ts"],
    },
    "adapter-more": {
      layer: "adapters",
      role: "The remaining technology adapters: SHA-256 digests and the outward names a repository declares (URLs, coordinates, registries).",
      may: "core/domain, core/ports, libraries",
      never: "core/application, another adapter",
      facts: [
        "A digest is a port, so an alternative hash is an adapter, not a core change.",
        "Outward names are read from configuration, build files and remotes; no network request is made.",
      ],
      files: ["src/core/adapters/crypto/sha256-digest.adapter.ts", "src/core/adapters/workspace/outward-names.adapter.ts"],
    },
  };

  if (ES && ES.atlas !== undefined) {
    for (const [key, value] of Object.entries(ES.atlas)) {
      if (ATLAS[key] !== undefined) Object.assign(ATLAS[key], value);
    }
  }

  const inspector = $("#atlas-inspector");
  function renderAtlas(key) {
    const item = ATLAS[key];
    if (item === undefined) return;
    inspector.style.setProperty("--layer-color", `var(--${LAYER_VAR[item.layer]})`);
    inspector.innerHTML = `
      <p class="ins-kicker">${esc(T.atlasKicker)} / ${esc(item.layer)}</p>
      <h3 class="ins-title">${esc(key)}</h3>
      <p class="ins-layer"><i></i>${esc(T.layerNames[item.layer])}</p>
      <p class="ins-role">${item.role}</p>
      <div class="ins-block"><h4>${esc(T.mayImport)}</h4><p class="ins-allowed">${item.may}</p></div>
      <div class="ins-block"><h4>${esc(T.never)}</h4><p class="ins-never">${item.never}</p></div>
      <div class="ins-block"><h4>${esc(T.owns)}</h4><ul>${item.facts.map((fact) => `<li>${fact}</li>`).join("")}</ul></div>
      <div class="ins-block"><h4>${esc(T.files)}</h4><div class="ins-files">${item.files.map((file) => `<code>${esc(file)}</code>`).join("")}</div></div>
    `;
    for (const button of $$(".atlas-node")) {
      button.setAttribute("aria-pressed", String(button.dataset.atlas === key));
      button.classList.toggle("is-active", button.dataset.atlas === key);
    }
  }
  const mobileLayout = window.matchMedia("(max-width: 980px)");
  for (const button of $$(".atlas-node")) {
    button.addEventListener("click", () => {
      renderAtlas(button.dataset.atlas);
      if (mobileLayout.matches) inspector.scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth", block: "start" });
    });
  }
  renderAtlas("app-impact");

  /* ── dependency-rule checker ───────────────────────────────────────── */

  const ALLOWED = {
    domain: ["domain"],
    ports: ["domain", "ports"],
    application: ["domain", "ports", "application"],
    adapters: ["domain", "ports"],
    entrypoints: ["domain", "ports"],
    composition: ["domain", "ports", "application", "adapters", "entrypoints", "composition"],
  };
  const RULE_LABEL = {
    domain: "core/domain",
    ports: "core/ports",
    application: "core/application",
    adapters: "core/adapters",
    entrypoints: "cli · mcp · protocol",
    composition: "composition",
  };
  const ruleFrom = $("#rule-from");
  const ruleTo = $("#rule-to");
  const ruleVerdict = $("#rule-verdict");

  function checkRule() {
    const from = ruleFrom.value;
    const to = ruleTo.value;
    const allowed = ALLOWED[from].includes(to);
    ruleVerdict.classList.toggle("ok", allowed);
    ruleVerdict.classList.toggle("bad", !allowed);
    if (allowed) {
      ruleVerdict.textContent = `${T.allowed}: ${RULE_LABEL[from]} → ${RULE_LABEL[to]}`;
      return;
    }
    if (from === "adapters" && to === "adapters") {
      ruleVerdict.textContent = T.forbiddenException;
      return;
    }
    ruleVerdict.textContent = T.forbidden.replace("{from}", RULE_LABEL[from]).replace("{to}", RULE_LABEL[to]);
  }
  ruleFrom.addEventListener("change", checkRule);
  ruleTo.addEventListener("change", checkRule);
  checkRule();

  /* ── fact playground ───────────────────────────────────────────────── */

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

  function renderFact() {
    const cuts = $$("[data-cut-toggle]").filter((input) => input.checked).map((input) => CUT_EXAMPLE[input.dataset.cutToggle]).filter(Boolean);
    cuts.sort((a, b) => CUT_RANK[a.kind] - CUT_RANK[b.kind]);
    const unknown = factUnknown.checked;
    const status = unknown ? "unknown" : cuts.length > 0 ? "partial" : "complete";
    factStatus.textContent = status;
    factStatus.classList.toggle("ok", status === "complete");
    factStatus.classList.toggle("warn", status === "partial");
    factStatus.classList.toggle("bad", status === "unknown");
    const value = unknown ? { status, reason: "index-unavailable" } : { status, ...(cuts.length > 0 ? { cuts } : {}) };
    factJson.innerHTML = highlightJSON(JSON.stringify(value, null, 2));
  }
  for (const input of $$("[data-cut-toggle]")) input.addEventListener("change", renderFact);
  factUnknown.addEventListener("change", renderFact);
  $("#fact-reset").addEventListener("click", () => {
    for (const input of $$("[data-cut-toggle]")) input.checked = false;
    factUnknown.checked = false;
    renderFact();
  });

  function highlightJSON(text) {
    const escaped = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    return escaped.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g, (match, string, colon, bool) => {
      if (string) return colon ? `<span class="c-key">${string}</span>${colon}` : `<span class="c-str">${string}</span>`;
      if (bool) return `<span class="c-warn">${bool}</span>`;
      return `<span class="c-num">${match}</span>`;
    });
  }
  renderFact();

  /* ── impact stepper ────────────────────────────────────────────────── */

  const STEPS = [
    {
      stage: "cli",
      title: "Read the request",
      body: `<p><code>ye-ast impact &lt;repo&gt; --base &lt;rev&gt; [--head &lt;rev&gt; | --live]</code>. The CLI parses the flags with <code>parseArgs</code>, turns <code>--include/--exclude</code> into a scope and <code>--depth/--hub-fan-in/--expansions</code> into a budget. A malformed value is a usage error, not a silent default.</p>`,
      why: "The request already names the only freedom the engine has: what to read, and how far to walk.",
      refs: ["src/cli/main.ts:275-291", "src/cli/main.ts:258-269", "src/cli/main.ts:46-60"],
      snippet: "ye-ast impact . --base main --depth 3 --include 'packages/api/**'",
    },
    {
      stage: "git",
      title: "Resolve three revisions",
      body: `<p>Base and head resolve to full shas, then <code>merge-base(base, head)</code> resolves again. The change is always <code>merge-base..head</code>: a base branch that moved on adds nothing that head did not change.</p>`,
      why: "A two-dot diff would compare the wrong trees as soon as the base moves. The merge base is the only stable origin.",
      refs: ["src/core/application/impact/impact-queries.ts:260-267", "src/core/adapters/git/git-vcs.adapter.ts:186-190"],
      snippet: "base = resolve(\"main\"); head = resolve(\"HEAD\"); mergeBase = mergeBase(base, head)",
    },
    {
      stage: "snapshot",
      title: "Export the head at a sha",
      body: `<p>ye-ast asks git for the tree (<code>ls-tree -r -z --full-tree</code>), keeps only in-scope files, and streams each blob through <code>cat-file --batch</code> into a scratch directory. The repository's own code never runs, and no repository file configures the export.</p>`,
      why: "Indexing the checkout would let a repository's manifest, .gitignore or prebuilt index decide what the engine sees. The export removes that channel.",
      refs: ["src/core/application/snapshot/read-snapshot.ts:68-82", "src/core/adapters/git/git-vcs.adapter.ts:102-134", "docs/architecture/adr/0010-trust-modes.md"],
      snippet: "git ls-tree -r -z --full-tree <sha> | select in-scope paths\ngit cat-file --batch  ->  scratch/<path>",
    },
    {
      stage: "git",
      title: "Diff with every option pinned",
      body: `<p><code>diff-tree -r -p --no-ext-diff --no-textconv --no-renames --text --unified=0 --no-color …</code>. <code>--text</code> defeats a <code>.gitattributes</code> that marks a source binary or <code>-diff</code>; an isolated git run empties user and system configuration. The parser reads hunk headers one line at a time, so a large diff is never held whole.</p>`,
      why: "If a machine's git config could change the hunks, the fact would not be deterministic. Every option is explicit.",
      refs: ["src/core/adapters/git/git-vcs.adapter.ts:276-288", "src/core/adapters/git/git-vcs.adapter.ts:404-412", "src/core/domain/change/diff-reader.ts:56-100"],
      snippet: "const DIFF_OPTIONS = [\"--no-ext-diff\", \"--no-textconv\", \"--no-renames\", \"--text\", \"--unified=0\", \"--no-color\", \"--src-prefix=a/\", \"--dst-prefix=b/\"]",
    },
    {
      stage: "diff",
      title: "Shape the blast radius",
      body: `<p>The diff is filtered by the declared scope and sorted. Each file is classified source, test or uncovered. This is the first place the answer learns what it cannot read: a changed <code>.html</code> no component names, an uncovered language, a test file.</p>`,
      why: "Scope is applied before the engine works, so a path outside it is not read at all. Completeness is relative to that decision.",
      refs: ["src/core/domain/change/blast-radius.ts:10", "src/core/application/impact/impact-queries.ts:273-277", "src/core/domain/change/changed-file.ts"],
      snippet: "radius = blastRadius(mergeBase, diff.filter((file) => selected(file.path)))",
    },
    {
      stage: "extract",
      title: "Extract entrypoints on both sides",
      body: `<p>The base and head trees run through ye-ast's own extractors: Spring routes and Angular routes. The comparison yields entrypoints added, removed or altered — a different name, handler or base path. A removed route is the change that breaks its consumers.</p>`,
      why: "A removed route has no node at head. Comparing both trees is the only way to report it.",
      refs: ["src/composition/compose.ts:94-101", "src/core/domain/impact/changed-entrypoints.ts:27-51", "docs/architecture/adr/0009-route-data-in-two-levels.md"],
      snippet: "changedEntrypoints(entrypointsOf(baseTree), entrypointsOf(headTree))",
    },
    {
      stage: "index",
      title: "Index the head, not the repository",
      body: `<p>codegraph runs in a child process over the exported tree. The index is keyed by the staged content digest, so it is reused only when the bytes are the same. The adapter drops engine entries and the root <code>codegraph.json</code>, then opens the store read-only after a version check.</p>`,
      why: "The build is the cost; the walk is cheap. Content-keyed reuse removes the build without letting content configure the engine.",
      refs: ["src/core/application/impact/impact-queries.ts:86-99", "src/core/adapters/codegraph/codegraph.adapter.ts:113-138", "docs/architecture/adr/0015-index-reuse-by-content.md"],
      snippet: "index({ content: digest(staged), snapshot }) -> { store: open(readOnly), summary }",
    },
    {
      stage: "seeds",
      title: "Choose seeds",
      body: `<p>A touched line seeds the innermost symbol that holds it. Lines in a file but outside every symbol seed the file's top-level declarations. A <code>templateUrl</code> seeds the component that names it. A removed declaration leaves its surviving references for a cut. Each seed carries its basis: <code>lines</code>, <code>top-level</code>, <code>resource</code> or <code>requested</code>.</p>`,
      why: "The seed is the bridge between a diff, which knows lines, and a graph, which knows symbols.",
      refs: ["src/core/domain/change/seeds.ts:53-87", "docs/architecture/rfc/0010-impact-queries.md:61-74"],
      snippet: "{ \"file\": \"src/auth/token.ts\", \"symbol\": \"validateToken\", \"line\": 1, \"basis\": \"lines\" }",
    },
    {
      stage: "walk",
      title: "Build inbound edges under a policy",
      body: `<p>Not every edge is a dependence. Calls and instantiations count; references into types count; <code>extends</code>/<code>implements</code> count; Angular injection and template use count. Tests, containment, navigation and file imports do not. Interface bridges and <code>this.&lt;field&gt;.&lt;member&gt;</code> uses are derived by ye-ast and fed into the same inbound port as codegraph's edges.</p>`,
      why: "A policy table is what keeps the answer explainable: every reached node traces to a row, and every skipped edge has a reason.",
      refs: ["src/core/domain/impact/edge-policy.ts:14-58", "src/core/application/impact/inbound-edges.ts:244-258", "docs/architecture/rfc/0010-impact-queries.md:88-109"],
      snippet: "callersOf(node, contractChanged, throughMember) -> InboundEdge[]",
    },
    {
      stage: "walk",
      title: "Walk backwards, level by level",
      body: `<p>The frontier starts at the seeds at depth 0. Each symbol is expanded once, so the walk ends on any graph. A reached method brings its declaring type at the same depth. Confidence is the widest path: the strongest weakest edge from any seed. Fan-in counts the call-like callers, whether or not the walk followed them.</p>`,
      why: "Breadth-first gives the shallowest depth. Max-min gives a confidence that does not reward a long chain of certain edges over a short, uncertain one.",
      refs: ["src/core/application/impact/walk.ts:50-120", "src/core/application/impact/walk.ts:139-153", "docs/architecture/adr/0017-owner-of-a-member-expands-only-whole-type-edges.md"],
      snippet: "seed 1.0 → login 0.9 → onSubmit 0.85\ndepth 0       1              2",
    },
    {
      stage: "join",
      title: "Join the graph to the facts",
      body: `<p>The one join is file, line inside the node's span, and the same simple name. A reached handler or component names its entrypoint; a reached guard names every UI route that declares it. codegraph's qualified names and overloads never decide the join.</p>`,
      why: "A second join would be a second truth. One function serves entrypoints, derived edges, call sites and seeds.",
      refs: ["src/core/domain/shared/code-node.ts:20-27", "src/core/domain/impact/reached-entrypoints.ts:20-44"],
      snippet: "joinsFact(node, { path, line, symbol })",
    },
    {
      stage: "fact",
      title: "Cut, sort, and sign the fact",
      body: `<p>Every bound and every blind spot becomes a cut; the fact is complete only when the frontier emptied and nothing unseen could add a caller. The fact records the snapshot, the declared scope, the content digest, the config digest, the engine versions and, for <code>ofChange</code>, the merge base.</p>`,
      why: "The fact is the product. A value without its inputs and its cuts is a guess with better formatting.",
      refs: ["src/core/domain/impact/impact-cuts.ts", "src/core/domain/impact/impact-fact.ts:66-72", "src/core/application/snapshot/read-snapshot.ts:116-134"],
      snippet: "{ status: \"partial\", cuts: [{ kind: \"no-extractor\", at: [\"src/legacy/report.rb\"] }] }",
    },
  ];

  if (ES && ES.steps !== undefined) {
    ES.steps.forEach((value, index) => {
      if (STEPS[index] !== undefined) Object.assign(STEPS[index], value);
    });
  }

  const STAGE_ATLAS = {
    cli: [["cli", "cli"], ["app-impact", "impact use case"]],
    git: [["adapter-git", "git adapter"]],
    snapshot: [["app-snapshot", "snapshot reader"], ["adapter-git", "git adapter"]],
    diff: [["domain-change", "change rules"]],
    extract: [["app-entrypoints", "map use case"], ["adapter-spring", "spring"], ["adapter-typescript", "typescript"]],
    index: [["adapter-codegraph", "codegraph"], ["ports", "ports"]],
    seeds: [["domain-change", "change rules"], ["domain-impact", "impact rules"]],
    walk: [["app-impact", "impact use case"], ["domain-impact", "edge policy"]],
    join: [["domain-shared", "the join"]],
    fact: [["domain-shared", "fact contract"], ["app-impact", "impact use case"]],
  };
  if (ES && ES.stageAtlas !== undefined) Object.assign(STAGE_ATLAS, ES.stageAtlas);

  const stepRail = $("#step-rail");
  const stepPanel = $("#step-panel");
  const stepCount = $("#step-count");
  const pipeline = $("#impact-pipeline");
  let stepIndex = 0;

  function refLink(ref) {
    const match = /^(.+?):([\d-]+)$/.exec(ref);
    const path = match ? match[1] : ref;
    const line = match ? match[2].split("-")[0] : null;
    const href = "../../" + path + (line ? "#L" + line : "");
    return `<a href="${esc(href)}" title="${esc(ref)}">${esc(ref)}</a>`;
  }

  function renderStepRail() {
    stepRail.innerHTML = STEPS.map((step, index) => `
      <button class="step-button${index === stepIndex ? " is-active" : ""}" type="button" role="tab" aria-selected="${index === stepIndex}" data-step="${index}">
        <span>${String(index + 1).padStart(2, "0")}</span>${esc(step.title)}
      </button>`).join("");
    for (const button of $$(".step-button", stepRail)) {
      button.addEventListener("click", () => showStep(Number(button.dataset.step)));
    }
  }

  function showStep(index) {
    stepIndex = (index + STEPS.length) % STEPS.length;
    const step = STEPS[stepIndex];
    const stageIndex = STEPS.findIndex((candidate) => candidate.stage === step.stage);
    const layers = STAGE_ATLAS[step.stage] ?? [];
    stepPanel.innerHTML = `
      <p class="step-stage">${esc(T.stage)} · ${esc(step.stage)}</p>
      <div class="step-layers"><span>${esc(T.inAtlas)}</span>${layers.map(([key, label]) => `<button class="layer-link" type="button" data-atlas-link="${esc(key)}">${esc(label)}</button>`).join("")}</div>
      <h3>${esc(step.title)}</h3>
      <div class="step-body">${step.body}</div>
      <div class="step-why"><strong>${esc(T.why)}</strong>${step.why}</div>
      <div class="step-snippet"><pre>${esc(step.snippet)}</pre></div>
      <div class="step-evidence">${step.refs.map(refLink).join("")}</div>
    `;
    stepCount.textContent = `${stepIndex + 1} / ${STEPS.length}`;
    for (const link of $$(".layer-link", stepPanel)) {
      link.addEventListener("click", () => {
        renderAtlas(link.dataset.atlasLink);
        document.getElementById("atlas").scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth", block: "start" });
      });
    }
    for (const button of $$(".step-button", stepRail)) {
      const active = Number(button.dataset.step) === stepIndex;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    const stages = $$("span", pipeline);
    stages.forEach((stage, position) => {
      stage.classList.toggle("is-active", position === stageIndex);
      stage.classList.toggle("is-done", position < stageIndex);
    });
  }
  renderStepRail();
  showStep(0);
  $("#step-prev").addEventListener("click", () => showStep(stepIndex - 1));
  $("#step-next").addEventListener("click", () => showStep(stepIndex + 1));
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === "ArrowLeft" && document.activeElement === stepPanel) showStep(stepIndex - 1);
    if (event.key === "ArrowRight" && document.activeElement === stepPanel) showStep(stepIndex + 1);
  });

  /* ── real runs ─────────────────────────────────────────────────────── */

  const REAL = {
    complete: {
      command: "ye-ast impact <repo> --base HEAD~1",
      sha: "4e00fd9b293a",
      mergeBase: "8dba227feee2",
      status: "complete",
      trust: "untrusted",
      seeds: [{ file: "src/auth/token.ts", symbol: "validateToken", line: 1, basis: "lines" }],
      symbols: [
        { file: "src/auth/token.ts", symbol: "validateToken", kind: "function", depth: 0, confidence: 1, fanIn: 1, via: null },
        { file: "src/auth/auth.service.ts", symbol: "AuthService", kind: "class", depth: 1, confidence: 0.9, fanIn: 0, via: "login" },
        { file: "src/auth/auth.service.ts", symbol: "login", kind: "method", depth: 1, confidence: 0.9, fanIn: 1, via: "validateToken" },
        { file: "src/auth/auth.controller.ts", symbol: "AuthController", kind: "class", depth: 2, confidence: 0.85, fanIn: 0, via: "loginHandler" },
        { file: "src/auth/auth.controller.ts", symbol: "loginHandler", kind: "method", depth: 2, confidence: 0.85, fanIn: 0, via: "login" },
      ],
      entrypoints: [],
      cuts: [],
      cost: { expansionsUsed: 5 },
    },
    partial: {
      command: "ye-ast impact <repo> --base HEAD~1",
      sha: "2dff4ecee21a",
      mergeBase: "d2a9f2b9368b",
      status: "partial",
      trust: "untrusted",
      seeds: [{ file: "src/auth/token.ts", symbol: "validateToken", line: 1, basis: "lines" }],
      symbols: [
        { file: "src/auth/token.ts", symbol: "validateToken", kind: "function", depth: 0, confidence: 1, fanIn: 1, via: null },
        { file: "src/auth/auth.service.ts", symbol: "AuthService", kind: "class", depth: 1, confidence: 0.9, fanIn: 0, via: "login" },
        { file: "src/auth/auth.service.ts", symbol: "login", kind: "method", depth: 1, confidence: 0.9, fanIn: 1, via: "validateToken" },
        { file: "src/ui/login.component.ts", symbol: "LoginComponent", kind: "class", depth: 2, confidence: 0.85, fanIn: 0, via: "onSubmit" },
        { file: "src/ui/login.component.ts", symbol: "onSubmit", kind: "method", depth: 2, confidence: 0.85, fanIn: 0, via: "login" },
      ],
      entrypoints: [{ kind: "ui-route", name: "/login", handler: { path: "src/ui/login.component.ts", symbol: "LoginComponent", line: 5 }, depth: 2, confidence: 0.85 }],
      cuts: [{ kind: "no-extractor", at: ["src/legacy/report.rb"] }],
      cost: { expansionsUsed: 5 },
    },
    callers: {
      command: "ye-ast callers <repo> src/auth/token.ts:validateToken",
      status: "partial",
      seeds: [{ file: "src/auth/token.ts", symbol: "validateToken", line: 1, basis: "requested" }],
      symbols: [
        { symbol: "validateToken", file: "src/auth/token.ts", depth: 0, confidence: 1, fanIn: 1 },
        { symbol: "AuthService", file: "src/auth/auth.service.ts", depth: 1, confidence: 0.9, fanIn: 0 },
        { symbol: "login", file: "src/auth/auth.service.ts", depth: 1, confidence: 0.9, fanIn: 1 },
        { symbol: "LoginComponent", file: "src/ui/login.component.ts", depth: 2, confidence: 0.85, fanIn: 0 },
        { symbol: "onSubmit", file: "src/ui/login.component.ts", depth: 2, confidence: 0.85, fanIn: 0 },
      ],
      entrypoints: [{ kind: "ui-route", name: "/login", handler: { path: "src/ui/login.component.ts", symbol: "LoginComponent", line: 5 }, depth: 2, confidence: 0.85 }],
      cuts: [{ kind: "no-extractor", at: ["src/legacy/report.rb"] }],
      cost: { expansionsUsed: 5 },
    },
    importers: {
      command: "ye-ast importers <repo> src/auth/token.ts src/auth/auth.service.ts",
      status: "partial",
      files: [
        { file: "src/auth/auth.service.ts", importers: ["src/auth/auth.guard.ts", "src/ui/login.component.ts"], users: ["src/auth/auth.guard.ts", "src/ui/login.component.ts"], unresolvedNamers: [] },
        { file: "src/auth/token.ts", importers: ["src/auth/auth.service.ts"], users: ["src/auth/auth.service.ts"], unresolvedNamers: [] },
      ],
      cuts: [{ kind: "no-extractor", at: ["src/legacy/report.rb"] }],
    },
    map: {
      command: "ye-ast map <repo>",
      status: "partial",
      sectionStatus: "partial",
      routes: [
        { kind: "ui-route", name: "/login", path: "/login", component: { path: "src/ui/login.component.ts", symbol: "LoginComponent", line: 5 }, guards: [] },
        { kind: "ui-route", name: "/dashboard", path: "/dashboard", component: { path: "src/ui/dashboard.component.ts", symbol: "DashboardComponent", line: 4 }, guards: [{ name: "AuthGuard", path: "src/auth/auth.guard.ts" }] },
      ],
      cuts: [{ kind: "section", at: ["entrypoints"] }],
      sectionCuts: [{ kind: "no-extractor", at: ["src/legacy/report.rb"] }],
    },
  };

  function fileBase(path) {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? path : path.slice(slash + 1);
  }

  function factList(data, withEntrypoints, withFanIn) {
    const rows = data.symbols.map((symbol, index) => `
      <div class="fact-row${index === 0 ? " seed" : ""}">
        <span class="fact-depth">${symbol.depth}</span>
        <span class="fact-main"><strong>${esc(symbol.symbol)}</strong><span title="${esc(symbol.file)}">${esc(fileBase(symbol.file))}</span>${withFanIn ? `<span>${esc(T.fanIn)} ${symbol.fanIn}</span>` : ""}</span>
        <span class="fact-conf">${symbol.confidence}</span>
      </div>`).join("");
    const entries = withEntrypoints && data.entrypoints
      ? data.entrypoints.map((entry) => `
        <div class="fact-row entry">
          <span class="fact-depth">${entry.depth}</span>
          <span class="fact-main"><strong>${esc(entry.name)}</strong><span title="${esc(entry.handler.path)}">${esc(fileBase(entry.handler.path))}</span></span>
          <span class="fact-conf">${entry.confidence}</span>
        </div>`).join("")
      : "";
    return `<div class="fact-list">${rows}${entries}</div>`;
  }

  function renderRealRuns() {
    const complete = $('[data-render="complete"]');
    const partial = $('[data-render="partial"]');
    const callers = $('[data-render="callers"]');
    const importers = $('[data-render="importers"]');
    const map = $('[data-render="map"]');
    if (complete) complete.innerHTML = factList(REAL.complete, false, true);
    if (partial) partial.innerHTML = factList(REAL.partial, true, true);
    if (callers) callers.innerHTML = factList(REAL.callers, true, true);
    if (importers) {
      importers.innerHTML = `<div class="fact-list">${REAL.importers.files.map((file) => `
        <div class="fact-row block">
          <span class="fact-main">
            <strong title="${esc(file.file)}">${esc(fileBase(file.file))}</strong>
            <span>importers · ${file.importers.map(fileBase).map(esc).join(", ") || "none"}</span>
            <span>users · ${file.users.map(fileBase).map(esc).join(", ") || "none"}</span>
            ${file.unresolvedNamers.length === 0 ? "" : `<span>unresolved · ${file.unresolvedNamers.map(fileBase).map(esc).join(", ")}</span>`}
          </span>
        </div>`).join("")}</div>`;
    }
    if (map) {
      map.innerHTML = `<div class="fact-list">${REAL.map.routes.map((route) => `
        <div class="fact-row">
          <span class="fact-depth">UI</span>
          <span class="fact-main">
            <strong>${esc(route.name)}</strong>
            <span title="${esc(route.component.path)}">${esc(fileBase(route.component.path))}</span>
            ${route.guards.length === 0 ? "" : `<span>guard · ${route.guards.map((guard) => esc(guard.name)).join(", ")}</span>`}
          </span>
        </div>`).join("")}</div>`;
    }
  }
  renderRealRuns();

  /* ── walk simulator ────────────────────────────────────────────────── */

  const SIM = {
    nodes: [
      { id: "token", name: "validateToken", sub: "token.ts:1", kind: "function", file: "src/auth/token.ts", line: 1, order: 0 },
      { id: "login", name: "login", sub: "auth.service.ts:4", kind: "method", file: "src/auth/auth.service.ts", line: 4, order: 1 },
      { id: "authService", name: "AuthService", sub: "auth.service.ts:3", kind: "class", file: "src/auth/auth.service.ts", line: 3, order: 2 },
      { id: "onSubmit", name: "onSubmit", sub: "login.component.ts:8", kind: "method", file: "src/ui/login.component.ts", line: 8, order: 3 },
      { id: "loginComp", name: "LoginComponent", sub: "login.component.ts:5", kind: "component", file: "src/ui/login.component.ts", line: 5, order: 4 },
      { id: "loginHandler", name: "loginHandler", sub: "auth.controller.ts:6", kind: "method", file: "src/auth/auth.controller.ts", line: 6, order: 5 },
      { id: "authController", name: "AuthController", sub: "auth.controller.ts:3", kind: "class", file: "src/auth/auth.controller.ts", line: 3, order: 6 },
      { id: "guard", name: "canActivate", sub: "auth.guard.ts:8", kind: "method", file: "src/auth/auth.guard.ts", line: 8, order: 7 },
      { id: "guardClass", name: "AuthGuard", sub: "auth.guard.ts:5", kind: "class", file: "src/auth/auth.guard.ts", line: 5, order: 8 },
      { id: "isLoggedIn", name: "isLoggedIn", sub: "auth.service.ts:8", kind: "method", file: "src/auth/auth.service.ts", line: 8, order: 9 },
      { id: "dashComp", name: "DashboardComponent", sub: "dashboard.component.ts:4", kind: "component", file: "src/ui/dashboard.component.ts", line: 4, order: 10 },
      { id: "chart", name: "ChartComponent", sub: "chart.component.ts:4", kind: "component", file: "src/ui/chart.component.ts", line: 4, order: 11 },
      { id: "credentials", name: "Credentials", sub: "credentials.ts:1", kind: "interface", file: "src/auth/credentials.ts", line: 1, order: 12 },
      { id: "audit", name: "record", sub: "audit.service.ts:7", kind: "method", file: "src/audit/audit.service.ts", line: 7, order: 13 },
      { id: "auditService", name: "AuditService", sub: "audit.service.ts:5", kind: "class", file: "src/audit/audit.service.ts", line: 5, order: 14 },
      { id: "logger", name: "log", sub: "logger.ts:4", kind: "method", file: "src/shared/logger.ts", line: 4, order: 15 },
      { id: "lazy", name: "load", sub: "lazy.ts:6", kind: "method", file: "src/legacy/lazy.ts", line: 6, order: 16 },
      { id: "spec", name: "auth.service.spec.ts", sub: "test file", kind: "file", file: "src/auth/auth.service.spec.ts", line: 1, order: 17, test: true },
      { id: "nav", name: "NavComponent", sub: "nav.component.ts:3", kind: "component", file: "src/ui/nav.component.ts", line: 3, order: 18 },
      { id: "routesFile", name: "app.routes.ts", sub: "route table", kind: "file", file: "src/app.routes.ts", line: 7, order: 19 },
    ],
    owners: {
      login: "authService",
      onSubmit: "loginComp",
      loginHandler: "authController",
      guard: "guardClass",
      isLoggedIn: "authService",
      audit: "auditService",
    },
    edges: [
      { from: "login", to: "token", kind: "calls", confidence: 1, line: 4 },
      { from: "loginHandler", to: "login", kind: "calls", confidence: 1, line: 7, settled: "this.auth.login" },
      { from: "onSubmit", to: "login", kind: "calls", confidence: 1, line: 9 },
      { from: "spec", to: "login", kind: "calls", confidence: 1, line: 5 },
      { from: "guard", to: "isLoggedIn", kind: "calls", confidence: 1, line: 9 },
      { from: "audit", to: "credentials", kind: "references", confidence: 1, line: 6 },
      { from: "onSubmit", to: "credentials", kind: "references", confidence: 1, line: 8 },
      { from: "login", to: "logger", kind: "calls", confidence: 1, line: 10 },
      { from: "onSubmit", to: "logger", kind: "calls", confidence: 0.9, line: 10 },
      { from: "guard", to: "logger", kind: "calls", confidence: 0.9, line: 10 },
      { from: "loginHandler", to: "logger", kind: "calls", confidence: 0.9, line: 8 },
      { from: "audit", to: "logger", kind: "calls", confidence: 0.9, line: 7 },
      { from: "nav", to: "dashComp", kind: "navigates", confidence: 1, line: 3 },
      { from: "routesFile", to: "loginComp", kind: "imports", confidence: 1, line: 1 },
      { from: "dashComp", to: "chart", kind: "uses-component", confidence: 1, line: 6 },
    ],
    routes: [
      { kind: "ui-route", name: "/login", handler: "loginComp", guard: null },
      { kind: "ui-route", name: "/dashboard", handler: "dashComp", guard: "guardClass" },
    ],
  };

  const NODE = new Map(SIM.nodes.map((node) => [node.id, node]));
  const CODE_KINDS = new Set(["function", "method", "class", "component", "constant", "variable", "property", "field"]);
  const REFERRER_KINDS = new Set([...CODE_KINDS, "interface", "type_alias", "route"]);
  const REFERENCED_KINDS = new Set(["function", "method", "constant", "variable", "class", "component", "interface", "type_alias", "enum"]);
  const TYPE_KINDS = new Set(["class", "component", "interface"]);
  const ANGULAR_KINDS = new Set(["class", "component"]);
  const RELATION_KINDS = new Set(["injects", "uses-component", "uses-directive", "uses-pipe"]);
  const SCENARIOS = {
    token: { seed: "token" },
    credentials: { seed: "credentials" },
    chart: { seed: "chart" },
    guard: { seed: "guard" },
    logger: { seed: "logger" },
    lazy: { seed: "lazy" },
  };
  let scenario = "token";
  let currentResult = null;
  let visibleDepth = 0;
  let playTimer = null;

  const simDepth = $("#sim-depth");
  const simHub = $("#sim-hub");
  const simExp = $("#sim-exp");
  const simReferences = $("#sim-references");
  const simRelations = $("#sim-relations");
  const simUncovered = $("#sim-uncovered");
  const simStatus = $("#sim-status");
  const simTable = $("#sim-table");
  const simCuts = $("#sim-cuts");
  const simEntries = $("#sim-entrypoints");
  const simSelection = document.createElement("div");
  simSelection.className = "readout-selection";
  $(".sim-readout").appendChild(simSelection);

  function numberOrUndefined(input) {
    const value = Number(input.value);
    return input.value.trim() !== "" && Number.isInteger(value) && value > 0 ? value : undefined;
  }
  function options() {
    return {
      depth: numberOrUndefined(simDepth),
      hub: numberOrUndefined(simHub),
      expansions: numberOrUndefined(simExp),
      references: simReferences.checked,
      relations: simRelations.checked,
      uncovered: simUncovered.checked,
    };
  }

  function edgeFollowed(edge, opts) {
    if (edge.kind === "navigates" || edge.kind === "imports") return false;
    const from = NODE.get(edge.from);
    const to = NODE.get(edge.to);
    if (from.test) return false;
    if (edge.kind === "calls" || edge.kind === "instantiates") return CODE_KINDS.has(from.kind);
    if (edge.kind === "references") return opts.references && REFERRER_KINDS.has(from.kind) && REFERENCED_KINDS.has(to.kind);
    if (edge.kind === "extends" || edge.kind === "implements") return TYPE_KINDS.has(from.kind) && TYPE_KINDS.has(to.kind);
    if (RELATION_KINDS.has(edge.kind)) return opts.relations && ANGULAR_KINDS.has(from.kind) && ANGULAR_KINDS.has(to.kind);
    return false;
  }

  function callersOf(node, opts) {
    const best = new Map();
    for (const edge of SIM.edges) {
      if (edge.to !== node.id || !edgeFollowed(edge, opts)) continue;
      const from = NODE.get(edge.from);
      const callLike = edge.kind === "calls" || edge.kind === "instantiates";
      const held = best.get(from.id);
      if (held === undefined) best.set(from.id, { node: from, edge, confidence: edge.confidence, callLike });
      else {
        held.callLike = held.callLike || callLike;
        if (edge.confidence > held.confidence) { held.edge = edge; held.confidence = edge.confidence; }
      }
    }
    return Array.from(best.values()).sort((a, b) => a.node.order - b.node.order);
  }

  function walk(opts) {
    const seed = NODE.get(SCENARIOS[scenario].seed);
    const recs = new Map();
    const links = [];
    const seedRecs = [];
    let level = [];

    function enter(node, depth, via, into) {
      const rec = { node, depth, via, fanIn: 0, callers: [] };
      recs.set(node.id, rec);
      into.push(rec);
      return rec;
    }
    function enterOwners(rec, into) {
      const ownerId = SIM.owners[rec.node.id];
      if (ownerId === undefined) return;
      const owner = NODE.get(ownerId);
      let target = recs.get(owner.id);
      if (target === undefined) target = enter(owner, rec.depth, rec.node, into);
      links.push({ from: rec, to: target, confidence: 1, owner: true });
    }

    const seedRec = enter(seed, 0, null, level);
    seedRecs.push(seedRec);
    enterOwners(seedRec, level);

    let expansions = 0;
    const stopped = { depth: [], hub: [], expansions: [] };
    for (let depth = 0; level.length > 0; depth++) {
      const next = [];
      for (const rec of level.slice().sort((a, b) => a.node.order - b.node.order)) {
        rec.callers = callersOf(rec.node, opts);
        rec.fanIn = rec.callers.filter((caller) => caller.callLike).length;
        if (opts.depth !== undefined && depth >= opts.depth) { stopped.depth.push(rec); continue; }
        if (opts.hub !== undefined && rec.fanIn > opts.hub) { stopped.hub.push(rec); continue; }
        if (opts.expansions !== undefined && expansions >= opts.expansions) { stopped.expansions.push(rec); continue; }
        expansions += 1;
        for (const caller of rec.callers) {
          let target = recs.get(caller.node.id);
          if (target === undefined) {
            target = enter(caller.node, depth + 1, rec.node, next);
            enterOwners(target, next);
          }
          links.push({ from: rec, to: target, confidence: caller.edge.confidence, edge: caller.edge });
        }
      }
      level = next;
    }

    const best = new Map(seedRecs.map((rec) => [rec, 1]));
    const queue = seedRecs.slice();
    while (queue.length > 0) {
      const rec = queue.shift();
      for (const link of links) {
        if (link.from !== rec) continue;
        const through = Math.min(best.get(rec), link.confidence);
        if (through > (best.get(link.to) ?? -1)) {
          best.set(link.to, through);
          queue.push(link.to);
        }
      }
    }

    const reached = Array.from(recs.values()).map((rec) => ({
      node: rec.node,
      depth: rec.depth,
      confidence: best.get(rec) ?? 0,
      fanIn: rec.fanIn,
      via: rec.via,
      seeds: [0],
    })).sort((a, b) => a.depth - b.depth || a.node.order - b.node.order);

    const cutAt = (kind, list, limit) => {
      const anchors = Array.from(new Set(
        list.filter((rec) => rec.callers.some((caller) => !recs.has(caller.node.id)))
          .map((rec) => `${rec.node.file}::${rec.node.name}`),
      )).sort();
      return anchors.map((at) => ({ kind, at: [at], ...(limit === undefined ? {} : { limit }) }));
    };
    const cuts = [
      ...cutAt("depth", stopped.depth, opts.depth),
      ...cutAt("hub", stopped.hub, opts.hub),
      ...cutAt("caller-budget", stopped.expansions, opts.expansions),
    ];
    if (opts.uncovered) cuts.push({ kind: "no-extractor", at: ["src/legacy/report.rb"] });
    if (recs.has("lazy")) cuts.push({ kind: "unresolved-link", at: ["src/legacy/lazy.ts", "src/legacy/lazy.ts:7 computed import"] });
    cuts.sort((a, b) => CUT_RANK[a.kind] - CUT_RANK[b.kind] || a.at.join(" ").localeCompare(b.at.join(" ")));

    const entrypoints = [];
    for (const route of SIM.routes) {
      const handler = recs.get(route.handler);
      const guard = route.guard === null ? undefined : recs.get(route.guard);
      const base = handler ?? guard;
      if (base === undefined) continue;
      entrypoints.push({
        kind: route.kind,
        name: route.name,
        handler: route.handler,
        guard: route.guard ?? null,
        via: handler === undefined ? T.guard : T.handler,
        depth: base.depth,
        confidence: base.confidence,
      });
    }

    return {
      reached,
      cuts,
      entrypoints,
      expansions,
      status: cuts.length > 0 ? "partial" : "complete",
      maxDepth: reached.reduce((max, item) => Math.max(max, item.depth), 0),
      opts,
    };
  }

  function layout(result) {
    const reached = new Map(result.reached.map((item) => [item.node.id, item]));
    const byDepth = new Map();
    for (const item of result.reached) {
      if (!byDepth.has(item.depth)) byDepth.set(item.depth, []);
      byDepth.get(item.depth).push(item);
    }
    const positions = new Map();
    const maxDepth = result.maxDepth;
    const width = Math.max(1000, 120 + (maxDepth + 1) * 186 + 210);
    const maxCount = Math.max(1, ...Array.from(byDepth.values(), (items) => items.length));
    const height = Math.max(480, 190 + maxCount * 56);
    for (const [depth, items] of byDepth) {
      const sorted = items.slice().sort((a, b) => a.node.order - b.node.order);
      const gap = sorted.length > 1 ? Math.min(74, (height - 150) / (sorted.length - 1)) : 0;
      const start = height / 2 - ((sorted.length - 1) * gap) / 2 - 25;
      sorted.forEach((item, index) => {
        positions.set(item.node.id, { x: 96 + depth * 186, y: start + index * gap, reached: true, depth });
      });
    }
    return { positions, width, height };
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, text) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function nodePath(source, target) {
    const sx = source.x + (source.x > target.x ? 0 : 154);
    const sy = source.y + 25;
    const tx = target.x + (target.x > source.x ? 154 : 0);
    const ty = target.y + 25;
    if (Math.abs(sx - tx) < 8) return `M ${sx} ${sy} C ${sx + 60} ${sy - 40}, ${tx + 60} ${ty - 40}, ${tx} ${ty}`;
    const bend = Math.max(36, Math.abs(tx - sx) / 2);
    const direction = source.x > target.x ? -1 : 1;
    return `M ${sx} ${sy} C ${sx + bend * direction} ${sy}, ${tx - bend * direction} ${ty}, ${tx} ${ty}`;
  }

  function renderGraph(result) {
    const edgesGroup = $("#sim-edges");
    const nodesGroup = $("#sim-nodes");
    const routesGroup = $("#sim-routes");
    const labelGroup = $("#sim-unreached-label");
    const svg = $("#walk-svg");
    const { positions, width, height } = layout(result);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    edgesGroup.innerHTML = "";
    routesGroup.innerHTML = "";
    nodesGroup.innerHTML = "";
    labelGroup.innerHTML = "";
    labelGroup.appendChild(svgEl("text", { x: 46, y: 16, class: "sim-axis" }, T.walkDirection));
    labelGroup.appendChild(svgEl("text", { x: width - 46, y: 16, class: "sim-axis", "text-anchor": "end" }, T.callsDirection));
    labelGroup.appendChild(svgEl("line", { x1: 40, y1: 42, x2: width - 40, y2: 42, class: "sim-axis-line" }));
    for (let depth = 0; depth <= result.maxDepth; depth += 1) {
      labelGroup.appendChild(svgEl("text", { x: 96 + depth * 186 + 77, y: 34, class: "sim-axis", "text-anchor": "middle" }, `${T.depth} ${depth}`));
    }

    for (const edge of SIM.edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (from === undefined || to === undefined) continue;
      const followed = edgeFollowed(edge, result.opts);
      const rejected = NODE.get(edge.from).test;
      const cls = ["sim-edge", followed ? "followed" : rejected ? "rejected" : "ignored"].join(" ");
      const path = svgEl("path", {
        d: nodePath(from, to),
        class: cls,
        "data-from": edge.from,
        "data-to": edge.to,
        "data-from-depth": from.depth,
        "data-to-depth": to.depth,
        "marker-end": "url(#sim-arrow)",
      });
      path.appendChild(svgEl("title", {}, `${edge.kind} · ${T.confidence} ${edge.confidence} · ${NODE.get(edge.from).file}:${edge.line}${edge.settled === undefined ? "" : ` · ${T.settled}: ${edge.settled}`}`));
      edgesGroup.appendChild(path);
    }

    for (const node of SIM.nodes) {
      const position = positions.get(node.id);
      if (position === undefined) continue;
      const item = result.reached.find((candidate) => candidate.node.id === node.id);
      const group = svgEl("g", {
        class: "sim-node",
        "data-node": node.id,
        "data-depth": item.depth,
      });
      group.classList.add("is-reached");
      if (item.depth === 0) group.classList.add("is-seed");
      group.appendChild(svgEl("rect", { x: position.x, y: position.y, width: 154, height: 50, rx: 8 }));
      group.appendChild(svgEl("text", { x: position.x + 10, y: position.y + 18, class: "sim-label" }, node.name.length > 18 ? node.name.slice(0, 17) + "…" : node.name));
      group.appendChild(svgEl("text", { x: position.x + 10, y: position.y + 32, class: "sim-sub" }, node.sub));
      group.appendChild(svgEl("text", { x: position.x + 10, y: position.y + 43, class: "sim-kind" }, node.kind));
      group.appendChild(svgEl("title", {}, `${node.kind} ${node.name} · ${node.file}:${node.line} · ${T.depth} ${item.depth} · ${T.confidence} ${item.confidence} · ${T.fanIn} ${item.fanIn}`));
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", `${node.name}, ${node.kind}, ${T.depth} ${item.depth}, ${T.confidence} ${item.confidence}, ${T.fanIn} ${item.fanIn}`);
      group.addEventListener("click", () => selectNode(node.id));
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(node.id); }
      });
      nodesGroup.appendChild(group);
    }

    const routeOffsets = new Map();
    for (const entry of result.entrypoints) {
      const anchorId = positions.has(entry.handler) ? entry.handler : entry.guard;
      const handler = anchorId === null ? undefined : positions.get(anchorId);
      const base = anchorId === null ? undefined : result.reached.find((item) => item.node.id === anchorId);
      if (handler === undefined || base === undefined) continue;
      const count = routeOffsets.get(anchorId) ?? 0;
      routeOffsets.set(anchorId, count + 1);
      let x = handler.x + 172;
      if (x + 136 > width - 8) x = handler.x - 144;
      const y = handler.y + count * 30 - 2;
      const group = svgEl("g", { class: "sim-route" });
      group.appendChild(svgEl("rect", { x, y, width: 136, height: 26, rx: 13 }));
      group.appendChild(svgEl("text", { x: x + 10, y: y + 17 }, entry.name));
      group.appendChild(svgEl("title", {}, `${entry.kind} ${entry.name} · ${T.joinedTo} ${NODE.get(anchorId).name} · ${T.depth} ${entry.depth}`));
      routesGroup.appendChild(group);
      const link = svgEl("path", {
        d: `M ${handler.x + (x > handler.x ? 154 : 0)} ${handler.y + 25} C ${handler.x + (x > handler.x ? 190 : -36)} ${handler.y + 25}, ${x + (x > handler.x ? -20 : 156)} ${y + 13}, ${x + (x > handler.x ? 0 : 136)} ${y + 13}`,
        class: "sim-route-link",
        "marker-end": "url(#sim-arrow)",
      });
      routesGroup.appendChild(link);
    }
  }

  function selectNode(id) {
    const item = currentResult === null ? undefined : currentResult.reached.find((candidate) => candidate.node.id === id);
    const node = NODE.get(id);
    if (node === undefined) return;
    if (item === undefined) {
      simSelection.innerHTML = `<p class="mini-kicker">${esc(T.selected)}</p><strong>${esc(node.name)}</strong><p class="readout-empty">${esc(T.notReachedWalk)}</p>`;
      return;
    }
    simSelection.innerHTML = `
      <p class="mini-kicker">${esc(T.selected)}</p>
      <strong>${esc(node.name)}</strong>
      <p class="readout-empty">${esc(node.file)}:${node.line}</p>
      <p class="readout-empty">${esc(T.depth)} ${item.depth} · ${esc(T.confidence)} ${item.confidence} · ${esc(T.fanIn)} ${item.fanIn}</p>
      <p class="readout-empty">${item.via === null ? esc(T.seed) : `${esc(T.via)} ${esc(item.via.name)}`}</p>
    `;
  }

  function renderReadout(result) {
    simStatus.textContent = result.status;
    simStatus.classList.toggle("ok", result.status === "complete");
    simStatus.classList.toggle("warn", result.status === "partial");
    $("#sim-depth-out").textContent = result.maxDepth;
    $("#sim-expansions-out").textContent = result.expansions;
    $("#sim-entry-out").textContent = result.entrypoints.length;
    $("#sim-cuts-out").textContent = result.cuts.length;
    simCuts.innerHTML = result.cuts.length === 0
      ? `<p class="readout-empty">${esc(T.noCuts)}</p>`
      : result.cuts.map((cut) => `<p class="cut-item">${esc(cut.kind)}<br>${cut.at.map(esc).join("<br>")}${cut.limit === undefined ? "" : `<br>${esc(T.limit)} ${cut.limit}`}</p>`).join("");
    simEntries.innerHTML = result.entrypoints.length === 0
      ? `<p class="readout-empty">${esc(T.noEntrypoint)}</p>`
      : result.entrypoints.map((entry) => `<p class="entry-item">${esc(entry.kind)} ${esc(entry.name)}<br>${esc(T.depth)} ${entry.depth} · ${esc(entry.via)}</p>`).join("");

    const reachedIds = new Set(result.reached.map((item) => item.node.id));
    const unreached = SIM.nodes.filter((node) => !reachedIds.has(node.id));
    $("#sim-unreached").innerHTML = `<strong>${esc(T.notReached)}</strong>${unreached.length === 0
      ? `<span>${esc(T.none)}</span>`
      : unreached.map((node) => `<span title="${esc(node.file)}:${node.line}">${esc(node.name)}</span>`).join("")}`;

    const policy = [];
    for (const edge of SIM.edges) {
      if (!reachedIds.has(edge.from) && !reachedIds.has(edge.to)) continue;
      if (edgeFollowed(edge, result.opts)) continue;
      const from = NODE.get(edge.from);
      let kind = "ignored";
      let reason = T.noPolicyRow;
      if (from.test) { kind = "rejected"; reason = T.testsNeverCallers; }
      else if (edge.kind === "navigates") reason = T.navigationNotDependence;
      else if (edge.kind === "imports") reason = T.fileNodeNowhere;
      else if (edge.kind === "references" && !result.opts.references) reason = T.referencesOff;
      else if (RELATION_KINDS.has(edge.kind) && !result.opts.relations) reason = T.relationsOff;
      policy.push({ kind, reason, edge });
    }
    const rejected = policy.filter((item) => item.kind === "rejected").length;
    $("#sim-policy-count").textContent = policy.length === 0
      ? T.everyEdgeFollowed
      : `${rejected} ${T.rejected} · ${policy.length - rejected} ${T.ignored}`;
    $("#sim-policy").innerHTML = policy.length === 0
      ? `<p class="readout-empty">${esc(T.noPolicyEdges)}</p>`
      : policy.map(({ kind, reason, edge }) => `<p class="sim-policy-item ${kind}">${esc(NODE.get(edge.from).name)} → ${esc(NODE.get(edge.to).name)} · ${esc(edge.kind)}<em>${esc(reason)}</em></p>`).join("");
    simSelection.innerHTML = "";
    simTable.innerHTML = result.reached.map((item) => {
      const seed = item.depth === 0 ? " class=\"row-seed\"" : "";
      return `<tr${seed}><td class="num">${item.depth}</td><td>${esc(item.node.name)}</td><td><code>${esc(item.node.file)}</code></td><td class="num">${item.confidence}</td><td class="num">${item.fanIn}</td><td>${item.via === null ? "—" : esc(item.via.name)}</td></tr>`;
    }).join("");
  }

  function applyVisibility() {
    if (currentResult === null) return;
    const max = currentResult.maxDepth;
    for (const group of $$("#sim-nodes .sim-node")) {
      const depth = Number(group.dataset.depth);
      const unreached = group.dataset.unreached === "true";
      group.classList.toggle("is-hidden", !unreached && depth > visibleDepth);
      group.classList.toggle("is-current", !unreached && depth === visibleDepth && depth <= max);
    }
    for (const path of $$("#sim-edges .sim-edge")) {
      if (!path.classList.contains("followed")) continue;
      const toDepth = Number(path.dataset.toDepth);
      const fromDepth = Number(path.dataset.fromDepth);
      path.classList.toggle("is-live", Math.max(toDepth, fromDepth) <= visibleDepth);
    }
  }

  function stopPlay() {
    if (playTimer !== null) { clearTimeout(playTimer); playTimer = null; }
  }

  function runSimulation(animate) {
    stopPlay();
    currentResult = walk(options());
    renderGraph(currentResult);
    renderReadout(currentResult);
    visibleDepth = animate ? 0 : currentResult.maxDepth;
    applyVisibility();
    if (!animate) return;
    const tick = () => {
      if (currentResult === null || visibleDepth >= currentResult.maxDepth) { playTimer = null; return; }
      visibleDepth += 1;
      applyVisibility();
      playTimer = setTimeout(tick, prefersReduced ? 0 : 480);
    };
    playTimer = setTimeout(tick, prefersReduced ? 0 : 300);
  }

  for (const chip of $$("[data-scenario]")) {
    chip.addEventListener("click", () => {
      scenario = chip.dataset.scenario;
      for (const candidate of $$("[data-scenario]")) candidate.classList.toggle("is-active", candidate === chip);
      runSimulation(true);
    });
  }
  for (const input of [simDepth, simHub, simExp, simReferences, simRelations, simUncovered]) {
    input.addEventListener("change", () => runSimulation(false));
  }
  $("#sim-run").addEventListener("click", () => runSimulation(true));
  $("#sim-step").addEventListener("click", () => {
    stopPlay();
    if (currentResult === null) { runSimulation(false); return; }
    visibleDepth = Math.min(currentResult.maxDepth, Math.max(visibleDepth, 0) + 1);
    applyVisibility();
  });
  $("#sim-reset").addEventListener("click", () => {
    stopPlay();
    for (const input of [simDepth, simHub, simExp]) input.value = "";
    simReferences.checked = true;
    simRelations.checked = true;
    simUncovered.checked = false;
    runSimulation(false);
  });

  runSimulation(false);
})();
