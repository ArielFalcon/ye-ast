/* Toy walk simulator: seeds, bounds, edge policy, cuts and entrypoints. */
(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const CUT_RANK = { depth: 0, hub: 1, "caller-budget": 2, "node-cap": 3, deadline: 4, "unresolved-link": 5, "no-extractor": 6, "not-exported": 7, section: 8 };
  const LANG = document.documentElement.lang === "es" ? "es" : "en";
  const T = (window.SIM_UI && window.SIM_UI[LANG]) || (window.SIM_UI && window.SIM_UI.en) || {};

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
