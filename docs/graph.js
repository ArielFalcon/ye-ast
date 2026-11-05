/* Graph explorer engine: layered graph, zoom/pan, flows, callouts and module details. */
(() => {
  "use strict";

  const DATA = window.EXPLORER_DATA;
  const LANG = document.documentElement.lang === "es" ? "es" : "en";
  const ES = LANG === "es" ? window.EXPLORER_ES : null;
  const T = ES ? ES.ui : DATA.ui;
  const DETAILS_EN = window.MODULE_DETAILS_EN || {};
  const DETAILS_ES = window.MODULE_DETAILS_ES || {};

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const compactLayout = window.matchMedia("(max-width: 980px)");

  /* ── data ─────────────────────────────────────────────────────────── */

  const LAYERS = DATA.layers.map((layer) => ({
    ...layer,
    label: (ES && ES.layers && ES.layers[layer.id]) || layer.label,
    description: (ES && ES.layerDescriptions && ES.layerDescriptions[layer.id]) || layer.description,
  }));
  const LAYER_BY_ID = new Map(LAYERS.map((layer) => [layer.id, layer]));

  const MODULES = DATA.modules.map((module) => {
    const override = ES && ES.modules && ES.modules[module.key];
    return { ...module, ...(override && override.sub ? { sub: override.sub } : {}) };
  });
  const MODULE_BY_KEY = new Map(MODULES.map((module) => [module.key, module]));

  const FLOWS = DATA.flows.map((flow) => {
    const copy = JSON.parse(JSON.stringify(flow));
    const override = ES && ES.flows && ES.flows[flow.id];
    if (override) {
      copy.label = override.label || copy.label;
      copy.question = override.question || copy.question;
      if (Array.isArray(override.steps)) {
        override.steps.forEach((step, index) => {
          if (copy.steps[index]) Object.assign(copy.steps[index], step);
        });
      }
    }
    return copy;
  });
  const FLOW_BY_ID = new Map(FLOWS.map((flow) => [flow.id, flow]));

  function detailsOf(key) {
    const module = MODULE_BY_KEY.get(key);
    if (!module) return { role: "", may: "", never: "", facts: [], files: [] };
    const en = DETAILS_EN[key] || DATA.extraDetails[key] || (module.layer === "ports" ? DETAILS_EN.ports : {}) || {};
    const es = LANG === "es" ? (DETAILS_ES[key] || (ES && ES.modules && ES.modules[key]) || (module.layer === "ports" ? DETAILS_ES.ports : null)) : null;
    const merged = { ...en, ...(es || {}), files: module.files };
    if (module.layer === "ports") {
      const specific = LANG === "es" ? ES && ES.modules && ES.modules[key] && ES.modules[key].role : module.role;
      merged.role = specific || merged.role;
    }
    return merged;
  }

  /* ── layout ───────────────────────────────────────────────────────── */

  const NODE_W = 190;
  const NODE_H = 62;
  const GAP = 20;
  const GRAPH_W = 1090;
  const GRAPH_H = 1160;

  const MODULES_BY_LAYER = new Map();
  for (const layer of LAYERS) MODULES_BY_LAYER.set(layer.id, MODULES.filter((module) => module.layer === layer.id));

  const POSITIONS = new Map();
  for (const layer of LAYERS) {
    const items = MODULES_BY_LAYER.get(layer.id) || [];
    const cols = layer.cols;
    const rows = Math.ceil(items.length / cols);
    const rowWidth = cols * NODE_W + (cols - 1) * GAP;
    const startX = 30 + (GRAPH_W - 60 - rowWidth) / 2;
    items.forEach((module, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      POSITIONS.set(module.key, {
        x: startX + col * (NODE_W + GAP),
        y: layer.y + 28 + row * 78,
        w: NODE_W,
        h: NODE_H,
      });
    });
  }

  function edgeKind(edge) {
    const from = MODULE_BY_KEY.get(edge.from);
    const to = MODULE_BY_KEY.get(edge.to);
    if (!from || !to) return "uses";
    if (from.layer === "composition") return "wires";
    if (from.layer === "entry") return "calls";
    if (from.layer === "ports" && to.layer === "adapters") return "implements";
    if (from.layer === "adapters" && to.layer === "adapters") return "uses";
    return "uses";
  }

  const EDGES = DATA.edges.map(([from, to]) => {
    const edge = { from, to, id: `${from}>${to}` };
    edge.kind = edgeKind(edge);
    return edge;
  });
  const EDGE_BY_ID = new Map(EDGES.map((edge) => [edge.id, edge]));

  /* ── state ────────────────────────────────────────────────────────── */

  const hash = window.location.hash.replace(/^#/, "");
  const hashParts = hash.split("/");
  const initialFlow = FLOW_BY_ID.has(hashParts[0]) ? hashParts[0] : "impact";
  const initialStep = clamp((Number(hashParts[1]) || 1) - 1, 0, FLOW_BY_ID.get(initialFlow).steps.length - 1);

  const state = {
    flowId: initialFlow,
    stepIndex: initialStep,
    level: "modules",
    selectedNode: null,
    layerFocus: null,
    view: { x: 0, y: 0, k: 1 },
    playing: false,
    playTimer: null,
    mode: "flow",
    previousFlow: null,
  };

  /* ── DOM ──────────────────────────────────────────────────────────── */

  const svg = $("#graph-svg");
  const viewport = $("#graph-viewport");
  const edgesGroup = $("#graph-edges");
  const nodesGroup = $("#graph-nodes");
  const bandsGroup = $("#graph-bands");
  const flowList = $("#flow-list");
  const stepList = $("#step-list");
  const infoPanel = $("#info-panel");
  const flowTitle = $("#flow-title");
  const flowQuestion = $("#flow-question");
  const stepCount = $("#step-count");
  const graphStatus = $("#graph-status");
  const calloutLayer = $("#callout-layer");
  const calloutCard = $("#callout-card");
  const calloutLine = $("#callout-line");
  const zoomLabel = $("#zoom-label");
  const canvas = $("#graph-canvas");

  const SVG_NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ── halftone patterns ────────────────────────────────────────────── */

  function amRows(height, pitch, maxRadius, grow) {
    const dots = [];
    for (let y = pitch / 2, row = 0; y < height; y += pitch, row += 1) {
      const t = grow === "down" ? y / height : 1 - y / height;
      const r = (maxRadius * Math.pow(t, 1.4)).toFixed(2);
      if (r < 0.2) continue;
      const x = row % 2 ? pitch : pitch / 2;
      dots.push([x, y, r], [x - pitch, y, r], [x + pitch, y, r]);
    }
    return dots;
  }

  function installHalftone() {
    const defs = el("defs");
    const ground = el("pattern", { id: "ht-ground", width: 9, height: 9, patternUnits: "userSpaceOnUse" });
    ground.appendChild(el("circle", { cx: 2.25, cy: 2.25, r: 1.15, class: "ht-dot", opacity: 0.14 }));
    ground.appendChild(el("circle", { cx: 6.75, cy: 6.75, r: 1.15, class: "ht-dot", opacity: 0.14 }));
    defs.appendChild(ground);
    const shade = el("pattern", { id: "ht-shade", width: 6, height: NODE_H, patternUnits: "userSpaceOnUse" });
    for (const [cx, cy, r] of amRows(NODE_H, 6, 2.6, "down")) shade.appendChild(el("circle", { cx, cy, r, class: "ht-shade-dot", opacity: 0.5 }));
    defs.appendChild(shade);
    svg.insertBefore(defs, svg.firstChild);
  }

  function shadeOf(x, y, w, h) {
    const group = el("g", { transform: `translate(${x} ${y})`, "aria-hidden": "true" });
    const top = Math.round(h * 0.74);
    group.appendChild(el("rect", { x: 2, y: top, width: w - 4, height: h - top - 2, class: "gnode-shade" }));
    return group;
  }

  /* ── graph rendering ──────────────────────────────────────────────── */

  function layerBand(layer, view, interactive) {
    const group = el("g", { class: "gband" + (interactive ? " is-overview" : ""), "data-layer": layer.id, style: `--o:${LAYERS.indexOf(layer)}` });
    group.appendChild(el("rect", { x: view.x, y: view.y, width: view.w, height: view.h, rx: 3 }));
    group.appendChild(el("rect", { x: view.x, y: view.y, width: view.w, height: view.h, class: "gband-dots" }));
    group.appendChild(el("text", { x: view.x + 16, y: view.y + 26, class: "gband-title" }, layer.label));
    const items = MODULES_BY_LAYER.get(layer.id) || [];
    group.appendChild(el("text", { x: view.x + 16, y: view.y + 46, class: "gband-count" }, `${items.length} ${T.modulesCount}`));
    if (interactive) {
      if (view.w >= 500) {
        const names = items.slice(0, 7).map((module) => module.name).join(" · ");
        group.appendChild(el("text", { x: view.x + 16, y: view.y + 70, class: "gband-chips" }, names + (items.length > 7 ? " …" : "")));
      }
      group.addEventListener("click", () => {
        state.layerFocus = state.layerFocus === layer.id ? null : layer.id;
        state.selectedNode = null;
        state.mode = "flow";
        state.previousFlow = null;
        render();
      });
      group.style.cursor = "pointer";
    }
    return group;
  }

  function edgePath(edge) {
    const from = POSITIONS.get(edge.from);
    const to = POSITIONS.get(edge.to);
    if (!from || !to) return "";
    const fx = from.x + from.w / 2;
    const fy = from.y + from.h;
    const tx = to.x + to.w / 2;
    const ty = to.y;
    if (ty >= fy) return `M ${fx} ${fy} C ${fx} ${fy + 34}, ${tx} ${ty - 34}, ${tx} ${ty}`;
    if (fy <= to.y + to.h) return `M ${fx} ${from.y} C ${fx} ${from.y - 34}, ${tx} ${ty + to.h + 34}, ${tx} ${ty + to.h}`;
    const left = from.x < to.x;
    const sx = left ? from.x + from.w : from.x;
    const sy = from.y + from.h / 2;
    const ex = left ? to.x : to.x + to.w;
    const ey = to.y + to.h / 2;
    return `M ${sx} ${sy} C ${sx + (left ? 42 : -42)} ${sy}, ${ex + (left ? -42 : 42)} ${ey}, ${ex} ${ey}`;
  }

  function renderModules() {
    bandsGroup.innerHTML = "";
    edgesGroup.innerHTML = "";
    nodesGroup.innerHTML = "";

    for (const layer of LAYERS) bandsGroup.appendChild(layerBand(layer, { x: 30, y: layer.y, w: GRAPH_W - 60, h: layer.h }, false));

    EDGES.forEach((edge, index) => {
      const path = el("path", {
        d: edgePath(edge),
        pathLength: 100,
        style: `--o:${index}`,
        class: `gedge rel-${edge.kind}`,
        "data-edge": edge.id,
        "data-from": edge.from,
        "data-to": edge.to,
        "data-kind": edge.kind,
      });
      path.appendChild(el("title", {}, `${edge.from} → ${edge.to} · ${edge.kind}`));
      edgesGroup.appendChild(path);
    });

    MODULES.forEach((module, index) => {
      const position = POSITIONS.get(module.key);
      if (!position) return;
      const group = el("g", {
        class: "gnode",
        "data-key": module.key,
        "data-layer": module.layer,
        tabindex: "0",
        role: "button",
        "aria-label": `${module.name}, ${module.sub}`,
        style: `--o:${index}`,
      });
      group.appendChild(el("rect", { x: position.x, y: position.y, width: position.w, height: position.h, rx: 2 }));
      group.appendChild(shadeOf(position.x, position.y, position.w, position.h));
      group.appendChild(el("text", { x: position.x + 12, y: position.y + 22, class: "gnode-name" }, module.name));
      group.appendChild(el("text", { x: position.x + 12, y: position.y + 40, class: "gnode-sub" }, module.sub));
      group.appendChild(el("text", { x: position.x + position.w - 12, y: position.y + 54, class: "gnode-tag", "text-anchor": "end" }, module.layer));
      group.addEventListener("click", (event) => { event.stopPropagation(); selectNode(module.key); });
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(module.key); }
      });
      nodesGroup.appendChild(group);
      fitText(group.querySelector(".gnode-sub"), position.w - 24);
    });
  }

  function fitText(text, width) {
    if (text.getComputedTextLength() <= width) return;
    text.setAttribute("textLength", width);
    text.setAttribute("lengthAdjust", "spacingAndGlyphs");
  }

  function renderLayers() {
    bandsGroup.innerHTML = "";
    edgesGroup.innerHTML = "";
    nodesGroup.innerHTML = "";
    LAYERS.forEach((layer, index) => {
      const compact = compactLayout.matches;
      const view = compact ? { x: 20, y: 8 + index * 62, w: 350, h: 52 } : { x: 50, y: 20 + index * 125, w: 800, h: 105 };
      bandsGroup.appendChild(layerBand(layer, view, true));
    });
  }

  function fileCountLabel(count) {
    if (LANG === "es") return count === 1 ? "1 archivo" : `${count} archivos`;
    return count === 1 ? "1 file" : `${count} files`;
  }

  function renderFiles() {
    bandsGroup.innerHTML = "";
    edgesGroup.innerHTML = "";
    nodesGroup.innerHTML = "";
    const key = state.selectedNode && MODULE_BY_KEY.has(state.selectedNode) ? state.selectedNode : defaultFilesNode();
    const module = MODULE_BY_KEY.get(key);
    const compact = compactLayout.matches;
    const center = compact ? { x: 30, y: 20, w: 330, h: 70 } : { x: 420, y: 210, w: 260, h: 86 };
    const hub = el("g", { class: "gnode is-files-hub", "data-key": module.key, "data-layer": module.layer });
    hub.appendChild(el("rect", { x: center.x, y: center.y, width: center.w, height: center.h, rx: 2 }));
    hub.appendChild(shadeOf(center.x, center.y, center.w, Math.min(center.h, NODE_H)));
    hub.appendChild(el("text", { x: center.x + 16, y: center.y + 30, class: "gnode-name" }, module.name));
    hub.appendChild(el("text", { x: center.x + 16, y: center.y + 50, class: "gnode-sub" }, module.sub));
    hub.appendChild(el("text", { x: center.x + 16, y: center.y + 70, class: "gnode-tag" }, fileCountLabel(module.files.length)));
    nodesGroup.appendChild(hub);

    const files = module.files;
    const cols = compact ? 1 : Math.min(3, files.length);
    const startX = compact ? 20 : 170;
    const startY = compact ? 110 : 430;
    const fileW = compact ? 350 : 240;
    const fileH = compact ? 50 : 48;
    const gapX = compact ? 0 : 290;
    const gapY = compact ? 70 : 92;
    files.forEach((file, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const x = startX + col * gapX;
      const y = startY + row * gapY;
      const path = el("path", { d: `M ${center.x + center.w / 2} ${center.y + center.h} C ${center.x + center.w / 2} ${center.y + center.h + 30}, ${x + fileW / 2} ${y - 30}, ${x + fileW / 2} ${y}`, class: "gedge is-active", pathLength: 100 });
      edgesGroup.appendChild(path);
      const group = el("g", { class: "gfile", "data-file": file, style: `--o:${index}` });
      group.appendChild(el("rect", { x, y, width: fileW, height: fileH, rx: 2 }));
      group.appendChild(el("text", { x: x + 10, y: y + 20, class: "gfile-name" }, file.split("/").pop()));
      group.appendChild(el("text", { x: x + 10, y: y + 38, class: "gfile-path" }, file));
      nodesGroup.appendChild(group);
    });

    graphStatus.textContent = `${T.files}: ${module.name} · ${files.length}`;
  }

  function render() {
    if (state.level === "layers") {
      renderLayers();
      graphStatus.textContent = `${T.layers}: ${LAYERS.length}`;
    } else if (state.level === "files") {
      renderFiles();
    } else {
      renderModules();
      graphStatus.textContent = `${T.modules}: ${MODULES.length}`;
    }
    applyFocus();
    renderFlowHeader();
    renderStepList();
    renderInfoPanel();
    updateCallout();
  }

  /* ── focus and selection ──────────────────────────────────────────── */

  function currentStep() {
    const flow = FLOW_BY_ID.get(state.flowId);
    return flow ? flow.steps[state.stepIndex] : null;
  }

  function applyFocus() {
    const step = currentStep();
    const focus = step && !state.selectedNode ? new Set(step.focus) : null;
    const focusEdges = step && !state.selectedNode ? new Set(step.edges.map(([from, to]) => `${from}>${to}`)) : null;
    const selected = state.selectedNode;
    const neighbors = new Set();
    const selectedEdges = new Set();
    if (selected) {
      neighbors.add(selected);
      for (const edge of EDGES) {
        if (edge.from === selected || edge.to === selected) {
          selectedEdges.add(edge.id);
          neighbors.add(edge.from);
          neighbors.add(edge.to);
        }
      }
    }
    for (const node of $$(".gnode", nodesGroup)) {
      const key = node.dataset.key;
      const active = state.level === "files" ? true : selected ? neighbors.has(key) : !focus || focus.has(key);
      node.classList.toggle("is-dim", !active);
      node.classList.toggle("is-active", Boolean((focus && focus.has(key)) || (selected && key === selected)));
      node.classList.toggle("is-neighbor", Boolean(selected && neighbors.has(key) && key !== selected));
      node.classList.toggle("is-selected", key === selected);
      if (step && step.focus) node.style.setProperty("--i", String(Math.max(0, step.focus.indexOf(key))));
    }
    for (const path of $$(".gedge", edgesGroup)) {
      const id = path.dataset.edge;
      if (!id) continue;
      const active = state.level === "files" ? true : selected ? selectedEdges.has(id) : !focusEdges || focusEdges.has(id);
      path.classList.toggle("is-dim", !active);
      path.classList.toggle("is-active", active && (selected ? selectedEdges.has(id) : focusEdges ? focusEdges.has(id) : false));
    }
    const layerFocus = state.layerFocus;
    if (state.level === "layers") {
      for (const band of $$(".gband", bandsGroup)) {
        band.classList.toggle("is-focus", band.dataset.layer === layerFocus);
        band.classList.toggle("is-dim", Boolean(layerFocus && band.dataset.layer !== layerFocus));
      }
    }
    if (layerFocus && state.level === "modules") {
      for (const band of $$(".gband", bandsGroup)) band.classList.toggle("is-focus", band.dataset.layer === layerFocus);
      for (const node of $$(".gnode", nodesGroup)) {
        if (node.dataset.layer !== layerFocus) node.classList.add("is-dim");
      }
    }
  }

  function selectNode(key) {
    if (state.mode === "flow") state.previousFlow = { flowId: state.flowId, stepIndex: state.stepIndex };
    state.mode = "node";
    state.selectedNode = key;
    state.playing = false;
    stopPlayback();
    renderFlowList();
    render();
    updateCallout();
  }

  function selectFilesNode(key) {
    state.selectedNode = key;
    render();
  }

  function defaultFilesNode() {
    const step = currentStep();
    return (step && (step.callout || (step.focus && step.focus[0]))) || (MODULES[0] && MODULES[0].key) || "app-impact";
  }

  function clearNode() {
    state.selectedNode = null;
    if (state.level === "files") {
      state.level = "modules";
      syncLevelButtons();
    }
    if (state.mode === "node" && state.previousFlow) {
      state.flowId = state.previousFlow.flowId;
      state.stepIndex = state.previousFlow.stepIndex;
    }
    state.mode = "flow";
    state.previousFlow = null;
    renderFlowList();
    render();
    updateCallout();
  }

  function selectFlow(id) {
    if (!FLOW_BY_ID.has(id)) return;
    const inFiles = state.level === "files";
    state.flowId = id;
    state.stepIndex = 0;
    if (!inFiles) state.level = "modules";
    state.mode = "flow";
    state.previousFlow = null;
    state.selectedNode = inFiles ? defaultFilesNode() : null;
    state.layerFocus = null;
    stopPlayback();
    syncLevelButtons();
    renderFlowList();
    render();
    if (inFiles) fit();
    else if (compactLayout.matches) requestAnimationFrame(fitStep);
    else fit();
    updateHash();
  }

  function selectStep(index) {
    const flow = FLOW_BY_ID.get(state.flowId);
    if (!flow) return;
    const inFiles = state.level === "files";
    state.stepIndex = clamp(index, 0, flow.steps.length - 1);
    state.mode = "flow";
    state.previousFlow = null;
    state.selectedNode = inFiles ? defaultFilesNode() : null;
    state.layerFocus = null;
    if (!inFiles && state.level !== "modules") {
      state.level = "modules";
      syncLevelButtons();
    }
    render();
    if (inFiles) fit();
    else if (compactLayout.matches) requestAnimationFrame(fitStep);
    updateHash();
  }

  /* ── flow UI ──────────────────────────────────────────────────────── */

  function disableFlowControls() {
    $("#step-prev").disabled = true;
    $("#step-next").disabled = true;
    $("#step-play").disabled = true;
    $("#step-play").textContent = T.play;
    stepCount.textContent = "—";
  }

  function renderFlowHeader() {
    const flow = FLOW_BY_ID.get(state.flowId);
    const kicker = $("#flow-kicker");
    if (state.level === "layers") {
      const layer = state.layerFocus ? LAYER_BY_ID.get(state.layerFocus) : null;
      kicker.textContent = T.layers;
      flowTitle.textContent = layer ? layer.label : T.layers;
      flowQuestion.textContent = layer ? layer.description : T.layersHint;
      disableFlowControls();
      return;
    }
    if (state.mode === "node") {
      const module = MODULE_BY_KEY.get(state.selectedNode);
      const layer = module ? LAYER_BY_ID.get(module.layer) : null;
      kicker.textContent = T.nodeMode;
      flowTitle.textContent = module ? module.name : T.nodeMode;
      flowQuestion.textContent = module ? `${layer ? layer.label : ""} · ${module.sub}` : T.noSelection;
      disableFlowControls();
      return;
    }
    kicker.textContent = T.flow || "Flow";
    flowTitle.textContent = flow.label;
    flowQuestion.textContent = flow.question;
    stepCount.textContent = `${state.stepIndex + 1} / ${flow.steps.length}`;
    $("#step-prev").disabled = state.stepIndex === 0;
    $("#step-next").disabled = state.stepIndex === flow.steps.length - 1;
    $("#step-play").disabled = false;
    $("#step-play").textContent = state.playing ? T.pause : T.play;
  }

  function renderFlowList() {
    const activeId = state.mode === "flow" && (state.level === "modules" || state.level === "files") ? state.flowId : null;
    flowList.innerHTML = FLOWS.map((flow) => `<button type="button" class="flow-item${flow.id === activeId ? " is-active" : ""}" data-flow="${flow.id}"><strong>${esc(flow.label)}</strong><span>${esc(flow.question)}</span></button>`).join("");
    for (const button of $$(".flow-item", flowList)) button.addEventListener("click", () => selectFlow(button.dataset.flow));
  }

  function pauseCard(title, detail, actionId, actionLabel) {
    return `<div class="step-paused"><strong>${esc(title)}</strong><span>${esc(detail)}</span><button type="button" class="small-button" id="${actionId}">${esc(actionLabel)}</button></div>`;
  }

  function renderStepList() {
    const flow = FLOW_BY_ID.get(state.flowId);
    if (state.level === "layers") {
      stepList.innerHTML = pauseCard(T.layers, T.layersHint, "back-flow", T.backToFlow);
      $("#back-flow").addEventListener("click", () => { state.level = "modules"; state.mode = "flow"; state.selectedNode = null; state.layerFocus = null; syncLevelButtons(); render(); fit(); });
      return;
    }
    if (state.mode === "node") {
      stepList.innerHTML = pauseCard(T.flowPaused, `${flow.label} · ${T.step} ${state.stepIndex + 1}`, "resume-flow", T.backToFlow);
      $("#resume-flow").addEventListener("click", clearNode);
      return;
    }
    stepList.innerHTML = flow.steps.map((step, index) => `<button type="button" class="step-item${index === state.stepIndex ? " is-active" : ""}" data-step="${index}"><span>${String(index + 1).padStart(2, "0")}</span>${esc(step.title)}</button>`).join("");
    for (const button of $$(".step-item", stepList)) button.addEventListener("click", () => selectStep(Number(button.dataset.step)));
  }

  /* ── info panel ───────────────────────────────────────────────────── */

  function moduleName(key) {
    const module = MODULE_BY_KEY.get(key);
    return module ? module.name : key;
  }

  function moduleLabel(key) {
    const module = MODULE_BY_KEY.get(key);
    if (!module) return key;
    const layer = LAYER_BY_ID.get(module.layer);
    return `${layer ? layer.label : module.layer} · ${module.name}`;
  }

  function termLabel(key) {
    const term = window.GLOSSARY && window.GLOSSARY.terms.find((candidate) => candidate.key === key);
    return term ? (LANG === "es" ? term.labelEs || term.label : term.label) : key;
  }

  /** The blob view of this repository: a ref names a path in it, and the site is served from docs/, not from a clone. */
const SOURCE_BASE = "https://github.com/ArielFalcon/ye-ast/blob/main/";

function refLink(ref) {
    const match = /^(.+?):([\d-]+)$/.exec(ref);
    const path = match ? match[1] : ref;
    const line = match ? match[2].split("-")[0] : null;
    return `<a href="${SOURCE_BASE}${esc(path)}${line ? "#L" + line : ""}" target="_blank" rel="noreferrer">${esc(ref)}</a>`;
  }

  function layerDeps(layerId) {
    const outgoing = new Map();
    const incoming = new Map();
    for (const edge of EDGES) {
      const from = MODULE_BY_KEY.get(edge.from);
      const to = MODULE_BY_KEY.get(edge.to);
      if (!from || !to || from.layer === to.layer) continue;
      if (from.layer === layerId) outgoing.set(to.layer, (outgoing.get(to.layer) || 0) + 1);
      if (to.layer === layerId) incoming.set(from.layer, (incoming.get(from.layer) || 0) + 1);
    }
    const format = (map) => [...map].map(([id, count]) => `${LAYER_BY_ID.get(id) ? LAYER_BY_ID.get(id).label : id} (${count})`).join(" · ") || "—";
    return { outgoing: format(outgoing), incoming: format(incoming) };
  }

  function stepContentHTML(step, flow) {
    return `
      <p class="info-kicker">${esc(T.step)} ${state.stepIndex + 1} ${esc(T.of)} ${flow.steps.length} · ${esc(flow.label)}</p>
      <h2>${esc(step.title)}</h2>
      <div class="info-body">${step.body}</div>
      ${step.why ? `<div class="info-why"><strong>${esc(T.why)}</strong><p>${esc(step.why)}</p></div>` : ""}
      <div class="info-block">
        <h3>${esc(T.relations)}</h3>
        <ul class="relation-list">${step.edges.map(([from, to]) => {
          const edge = EDGE_BY_ID.get(`${from}>${to}`);
          const kind = edge ? edge.kind : "uses";
          const label = T.relationNames && T.relationNames[kind] ? T.relationNames[kind] : kind;
          return `<li><span class="term-chip is-static">${esc(moduleLabel(from))} → ${esc(moduleLabel(to))}</span><em>${esc(label)}</em></li>`;
        }).join("")}</ul>
      </div>
      <div class="info-block"><h3>${esc(T.activeNodes)}</h3><div class="term-chips">${step.focus.map((key) => `<button type="button" class="term-chip" data-info-node="${esc(key)}">${esc(moduleLabel(key))}</button>`).join("")}</div></div>
      <div class="info-block"><h3>${esc(T.terms)}</h3><div class="term-chips">${(flow.terms || []).map((key) => `<button type="button" class="term-chip" data-term="${esc(key)}">${esc(termLabel(key))}</button>`).join("")}</div></div>
      <div class="info-block"><h3>${esc(T.evidence)}</h3>${step.refs && step.refs.length ? `<div class="ref-list">${step.refs.map(refLink).join("")}</div>` : `<p class="info-role">${esc(T.noRefs)}</p>`}</div>`;
  }

  function bindStepInfo(onNode) {
    for (const button of $$("[data-info-node]", infoPanel)) button.addEventListener("click", () => onNode(button.dataset.infoNode));
    for (const button of $$("[data-term]", infoPanel)) button.addEventListener("click", () => { if (window.explorerShowTerm) window.explorerShowTerm(button.dataset.term); });
  }

  function renderInfoPanel() {
    const flow = FLOW_BY_ID.get(state.flowId);

    if (state.level === "files") {
      const step = flow.steps[state.stepIndex];
      const module = MODULE_BY_KEY.get(state.selectedNode) || MODULE_BY_KEY.get(defaultFilesNode());
      if (!step || !module) return;
      const layer = LAYER_BY_ID.get(module.layer);
      infoPanel.innerHTML = stepContentHTML(step, flow) + `
        <div class="info-block">
          <h3>${esc(T.filesOf)} ${esc(module.name)}</h3>
          <p class="info-sub">${esc(layer.label)} · ${esc(module.sub)}</p>
          <ul class="file-list">${module.files.map((file) => `<li><code>${esc(file)}</code></li>`).join("")}</ul>
        </div>
        <div class="info-block"><h3>${esc(T.modulesInStep)}</h3><div class="term-chips">${step.focus.map((key) => `<button type="button" class="term-chip" data-files-node="${esc(key)}">${esc(moduleLabel(key))}</button>`).join("")}</div></div>
        <div class="info-actions">
          <button type="button" class="small-button" id="focus-step">${esc(T.focusStep)}</button>
          <button type="button" class="small-button" id="inspect-module">${esc(T.inspectModule)}</button>
          <button type="button" class="small-button" id="back-modules">${esc(T.backToModules)}</button>
          <a class="small-button" href="#concept-glossary">${esc(T.glossary)}</a>
        </div>`;
      $("#focus-step").addEventListener("click", () => fit());
      $("#inspect-module").addEventListener("click", () => { state.level = "modules"; state.layerFocus = null; syncLevelButtons(); selectNode(module.key); });
      $("#back-modules").addEventListener("click", () => { state.level = "modules"; state.selectedNode = null; state.mode = "flow"; state.previousFlow = null; syncLevelButtons(); render(); fit(); });
      for (const button of $$("[data-files-node]", infoPanel)) button.addEventListener("click", () => selectFilesNode(button.dataset.filesNode));
      bindStepInfo(selectFilesNode);
      return;
    }

    if (state.selectedNode) {
      const module = MODULE_BY_KEY.get(state.selectedNode);
      if (!module) return;
      const layer = LAYER_BY_ID.get(module.layer);
      const details = detailsOf(module.key);
      infoPanel.innerHTML = `
        <p class="info-kicker">${esc(layer.label)} · ${esc(T.module)}</p>
        <h2>${esc(module.name)}</h2>
        <p class="info-sub">${esc(module.sub)}</p>
        <p class="info-role">${details.role || ""}</p>
        <div class="info-block"><h3>${esc(T.mayImport)}</h3><p class="ok">${details.may || "—"}</p></div>
        <div class="info-block"><h3>${esc(T.never)}</h3><p class="bad">${details.never || "—"}</p></div>
        <div class="info-block"><h3>${esc(T.owns)}</h3><ul>${(details.facts || []).map((fact) => `<li>${fact}</li>`).join("")}</ul></div>
        <div class="info-block"><h3>${esc(T.filesTitle)}</h3><ul class="file-list">${module.files.map((file) => `<li><code>${esc(file)}</code></li>`).join("")}</ul></div>
        <div class="info-actions">
          ${module.files.length > 0 ? `<button type="button" class="small-button" id="open-files">${esc(T.openFiles)}</button>` : ""}
          <button type="button" class="small-button" id="back-step">${esc(T.backToStep)}</button>
        </div>`;
      const openFiles = $("#open-files");
      if (openFiles) openFiles.addEventListener("click", () => { state.level = "files"; state.mode = "flow"; state.previousFlow = null; syncLevelButtons(); render(); fit(); });
      $("#back-step").addEventListener("click", clearNode);
      return;
    }

    if (state.level === "layers") {
      const layer = state.layerFocus ? LAYER_BY_ID.get(state.layerFocus) : null;
      if (!layer) {
        infoPanel.innerHTML = `
          <p class="info-kicker">${esc(T.layers)}</p>
          <h2>${esc(T.layers)}</h2>
          <p class="info-role">${esc(T.layersHint)}</p>
          <div class="info-block"><h3>${esc(T.layer)}</h3><div class="layer-modules">${LAYERS.map((item) => `<button type="button" class="small-button" data-pick-layer="${item.id}">${esc(item.label)}</button>`).join("")}</div></div>`;
        for (const button of $$("[data-pick-layer]", infoPanel)) button.addEventListener("click", () => { state.layerFocus = button.dataset.pickLayer; render(); });
        return;
      }
      const modules = MODULES_BY_LAYER.get(layer.id) || [];
      const deps = layerDeps(layer.id);
      infoPanel.innerHTML = `
        <p class="info-kicker">${esc(T.layer)}</p>
        <h2>${esc(layer.label)}</h2>
        <p class="info-role">${esc(layer.description || "")}</p>
        <div class="info-block"><h3>${esc(T.layerDeps)}</h3><p class="ok">${esc(T.outgoing)}: ${esc(deps.outgoing)}</p><p class="bad">${esc(T.incoming)}: ${esc(deps.incoming)}</p></div>
        <div class="info-block"><h3>${esc(T.modules)}</h3><div class="layer-modules">${modules.map((module) => `<button type="button" class="small-button" data-layer-module="${module.key}">${esc(module.name)}</button>`).join("")}</div></div>
        <div class="info-actions"><button type="button" class="small-button" id="open-layer">${esc(T.openLayer)}</button></div>`;
      for (const button of $$("[data-layer-module]", infoPanel)) button.addEventListener("click", () => { state.level = "modules"; state.layerFocus = layer.id; selectNode(button.dataset.layerModule); });
      $("#open-layer").addEventListener("click", () => { state.level = "modules"; state.selectedNode = null; state.mode = "flow"; state.previousFlow = null; syncLevelButtons(); render(); fit(); });
      return;
    }

    const step = flow.steps[state.stepIndex];
    infoPanel.innerHTML = stepContentHTML(step, flow) + `
      <div class="info-actions">
        <button type="button" class="small-button" id="focus-step">${esc(T.focusStep)}</button>
        ${state.layerFocus ? `<button type="button" class="small-button" id="clear-layer">${esc(T.showAll)}</button>` : ""}
        <a class="small-button" href="#concept-glossary">${esc(T.glossary)}</a>
        ${state.stepIndex > 0 ? `<button type="button" class="small-button" id="back-flow">${esc(T.flowStart)}</button>` : ""}
      </div>`;
    $("#focus-step").addEventListener("click", () => fitStep());
    const clearLayer = $("#clear-layer");
    if (clearLayer) clearLayer.addEventListener("click", () => { state.layerFocus = null; render(); fit(); });
    bindStepInfo(selectNode);
    const backFlow = $("#back-flow");
    if (backFlow) backFlow.addEventListener("click", () => selectStep(0));
  }

  /* ── callout ──────────────────────────────────────────────────────── */

  function updateCallout() {
    const step = currentStep();
    if (!step || state.selectedNode || state.level !== "modules" || !step.callout) {
      calloutLayer.classList.remove("is-visible");
      calloutCard.innerHTML = "";
      calloutLine.setAttribute("d", "");
      return;
    }
    const position = POSITIONS.get(step.callout);
    const module = MODULE_BY_KEY.get(step.callout);
    if (!position || !module) {
      calloutLayer.classList.remove("is-visible");
      return;
    }
    const html = `<p class="callout-kicker">${esc(T.step)} ${state.stepIndex + 1}</p><strong>${esc(module.name)}</strong><p>${esc(step.calloutText || "")}</p>`;
    if (calloutCard.innerHTML !== html) {
      calloutCard.innerHTML = html;
      calloutCard.classList.remove("is-stamped");
      void calloutCard.offsetWidth;
      calloutCard.classList.add("is-stamped");
    }
    calloutLayer.classList.add("is-visible");
    placeCallout(step.callout);
  }

  function screenPoint(key) {
    const position = POSITIONS.get(key);
    if (!position) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: state.view.x + (position.x + position.w / 2) * state.view.k,
      y: state.view.y + (position.y + position.h / 2) * state.view.k,
      w: position.w * state.view.k,
      h: position.h * state.view.k,
      rect,
    };
  }

  function placeCallout(key) {
    const point = screenPoint(key);
    if (!point) return;
    const cardWidth = Math.min(300, point.rect.width - 32);
    calloutCard.style.width = cardWidth + "px";
    const cardHeight = calloutCard.offsetHeight || 96;
    let left = point.x + point.w / 2 + 42;
    if (left + cardWidth > point.rect.width - 12) left = point.x - point.w / 2 - cardWidth - 42;
    left = clamp(left, 12, point.rect.width - cardWidth - 12);
    let top = point.y - cardHeight / 2;
    top = clamp(top, 12, point.rect.height - cardHeight - 12);
    calloutCard.style.left = left + "px";
    calloutCard.style.top = top + "px";
    const startX = left > point.x ? point.x + point.w / 2 : point.x - point.w / 2;
    const endX = left > point.x ? left : left + cardWidth;
    const endY = top + cardHeight / 2;
    calloutLine.setAttribute("d", `M ${startX} ${point.y} C ${startX + (endX > startX ? 30 : -30)} ${point.y}, ${endX + (endX > startX ? -30 : 30)} ${endY}, ${endX} ${endY}`);
  }

  /* ── zoom and pan ─────────────────────────────────────────────────── */

  function graphSize() {
    if (state.level === "files") return compactLayout.matches ? { w: 390, h: 420 } : { w: 1100, h: 700 };
    if (state.level === "layers") return compactLayout.matches ? { w: 390, h: 400 } : { w: 900, h: 800 };
    return { w: GRAPH_W, h: GRAPH_H };
  }

  function centerNode(key, scale) {
    const position = POSITIONS.get(key);
    if (!position) return;
    const rect = canvas.getBoundingClientRect();
    state.view.k = scale;
    state.view.x = rect.width / 2 - (position.x + position.w / 2) * scale;
    state.view.y = rect.height / 2 - (position.y + position.h / 2) * scale;
    applyView();
  }

  function fitStep() {
    const step = currentStep();
    if (!step || !step.focus || step.focus.length === 0) { fit(); return; }
    const positions = step.focus.map((key) => POSITIONS.get(key)).filter(Boolean);
    if (positions.length === 0) { fit(); return; }
    const rect = canvas.getBoundingClientRect();
    const minX = Math.min(...positions.map((p) => p.x)) - 45;
    const maxX = Math.max(...positions.map((p) => p.x + p.w)) + 45;
    const minY = Math.min(...positions.map((p) => p.y)) - 70;
    const maxY = Math.max(...positions.map((p) => p.y + p.h)) + 90;
    const scale = Math.min((rect.width - 20) / (maxX - minX), (rect.height - 20) / (maxY - minY));
    if (compactLayout.matches && scale < 0.7 && step.callout) { centerNode(step.callout, 0.8); return; }
    state.view.k = clamp(scale, 0.35, compactLayout.matches ? 1 : 1.5);
    state.view.x = rect.width / 2 - ((minX + maxX) / 2) * state.view.k;
    state.view.y = rect.height / 2 - ((minY + maxY) / 2) * state.view.k;
    applyView();
  }

  function applyView() {
    viewport.setAttribute("transform", `translate(${state.view.x} ${state.view.y}) scale(${state.view.k})`);
    zoomLabel.textContent = Math.round(state.view.k * 100) + "%";
    updateCallout();
  }

  function fit() {
    const rect = canvas.getBoundingClientRect();
    const size = graphSize();
    const scale = Math.min((rect.width - 32) / size.w, (rect.height - 32) / size.h);
    state.view.k = clamp(scale, 0.15, 2);
    state.view.x = (rect.width - size.w * state.view.k) / 2;
    state.view.y = (rect.height - size.h * state.view.k) / 2;
    applyView();
  }

  function zoomAt(factor, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const next = clamp(state.view.k * factor, 0.15, 4);
    state.view.x = mx - ((mx - state.view.x) * next) / state.view.k;
    state.view.y = my - ((my - state.view.y) * next) / state.view.k;
    state.view.k = next;
    applyView();
  }

  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
  }, { passive: false });

  const pointers = new Map();
  let drag = null;
  let pinch = null;

  svg.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".gnode") || event.target.closest(".gfile") || event.target.closest(".gband.is-overview")) return;
    svg.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) drag = { x: event.clientX, y: event.clientY, vx: state.view.x, vy: state.view.y };
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: state.view.k };
      drag = null;
    }
  });

  svg.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && pinch) {
      const [a, b] = Array.from(pointers.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const next = clamp((pinch.k * dist) / pinch.dist, 0.15, 4);
      const rect = canvas.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - rect.left;
      const cy = (a.y + b.y) / 2 - rect.top;
      state.view.x = cx - ((cx - state.view.x) * next) / state.view.k;
      state.view.y = cy - ((cy - state.view.y) * next) / state.view.k;
      state.view.k = next;
      applyView();
      return;
    }
    if (drag) {
      state.view.x = drag.vx + (event.clientX - drag.x);
      state.view.y = drag.vy + (event.clientY - drag.y);
      applyView();
    }
  });

  function endPointer(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) drag = null;
  }
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);

  $("#zoom-in").addEventListener("click", () => zoomAt(1.25, canvas.getBoundingClientRect().left + canvas.clientWidth / 2, canvas.getBoundingClientRect().top + canvas.clientHeight / 2));
  $("#zoom-out").addEventListener("click", () => zoomAt(0.8, canvas.getBoundingClientRect().left + canvas.clientWidth / 2, canvas.getBoundingClientRect().top + canvas.clientHeight / 2));
  $("#zoom-fit").addEventListener("click", fit);

  /* ── levels ───────────────────────────────────────────────────────── */

  function syncLevelButtons() {
    for (const button of $$("[data-level]")) {
      const active = button.dataset.level === state.level;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
  }

  for (const button of $$("[data-level]")) {
    button.addEventListener("click", () => {
      const selected = state.selectedNode;
      state.level = button.dataset.level;
      state.playing = false;
      stopPlayback();
      state.mode = "flow";
      state.previousFlow = null;
      state.layerFocus = null;
      state.selectedNode = state.level === "files" ? (selected || defaultFilesNode()) : null;
      syncLevelButtons();
      render();
      fit();
    });
  }

  /* ── steps and hash ───────────────────────────────────────────────── */

  function stopPlayback() {
    if (state.playTimer !== null) { clearInterval(state.playTimer); state.playTimer = null; }
    state.playing = false;
    const play = $("#step-play");
    if (play) play.textContent = T.play;
  }

  function updateHash() {
    const value = `${state.flowId}/${state.stepIndex + 1}`;
    try { history.replaceState(null, "", "#" + value); } catch (_) { window.location.hash = value; }
  }

  $("#step-prev").addEventListener("click", () => { stopPlayback(); selectStep(state.stepIndex - 1); });
  $("#step-next").addEventListener("click", () => { stopPlayback(); selectStep(state.stepIndex + 1); });
  $("#step-play").addEventListener("click", () => {
    if (state.playing) { stopPlayback(); return; }
    const flow = FLOW_BY_ID.get(state.flowId);
    state.playing = true;
    $("#step-play").textContent = T.pause;
    if (state.stepIndex >= flow.steps.length - 1) selectStep(0);
    state.playTimer = setInterval(() => {
      const current = FLOW_BY_ID.get(state.flowId);
      if (state.stepIndex >= current.steps.length - 1) { stopPlayback(); return; }
      selectStep(state.stepIndex + 1);
      if (state.stepIndex >= current.steps.length - 1) stopPlayback();
    }, prefersReduced ? 1200 : 2800);
  });

  /* ── language hash and theme ──────────────────────────────────────── */

  for (const link of $$(".lang-switch")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      window.location.href = link.getAttribute("href") + window.location.hash;
    });
  }

  const root = document.documentElement;
  try {
    const stored = localStorage.getItem("yeast-explorer-theme");
    if (stored === "light" || stored === "dark") root.dataset.theme = stored;
  } catch (_) { /* ignore */ }
  const themeToggle = $("#theme-toggle");
  function syncTheme() {
    const light = root.dataset.theme === "light";
    themeToggle.setAttribute("aria-pressed", String(light));
    themeToggle.setAttribute("aria-label", light ? (T.toDark || "Switch to dark theme") : (T.toLight || "Switch to light theme"));
  }
  themeToggle.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    try { localStorage.setItem("yeast-explorer-theme", root.dataset.theme); } catch (_) { /* ignore */ }
    syncTheme();
  });
  syncTheme();

  /* ── init ─────────────────────────────────────────────────────────── */

  installHalftone();
  if (!prefersReduced && state.level === "modules") {
    svg.classList.add("is-building");
    setTimeout(() => svg.classList.remove("is-building"), 2400);
  }
  renderFlowList();
  render();
  syncLevelButtons();
  requestAnimationFrame(() => compactLayout.matches ? fitStep() : fit());

  window.explorerOpenNode = (key) => {
    if (!MODULE_BY_KEY.has(key)) return;
    state.level = "modules";
    state.layerFocus = null;
    state.playing = false;
    stopPlayback();
    syncLevelButtons();
    selectNode(key);
    document.getElementById("graph-canvas").scrollIntoView({ behavior: prefersReduced ? "auto" : "smooth", block: "center" });
  };

  window.addEventListener("resize", () => {
    clearTimeout(window.__fitTimer);
    window.__fitTimer = setTimeout(() => {
      if (state.level === "files" || state.level === "layers") render();
      if (state.level === "modules" && compactLayout.matches) fitStep(); else fit();
    }, 180);
  });

  compactLayout.addEventListener("change", () => {
    render();
    fit();
  });

  window.addEventListener("hashchange", () => {
    const parts = window.location.hash.replace(/^#/, "").split("/");
    if (FLOW_BY_ID.has(parts[0])) {
      state.flowId = parts[0];
      state.stepIndex = clamp((Number(parts[1]) || 1) - 1, 0, FLOW_BY_ID.get(parts[0]).steps.length - 1);
      state.selectedNode = null;
      state.level = "modules";
      state.mode = "flow";
      state.previousFlow = null;
      state.layerFocus = null;
      syncLevelButtons();
      renderFlowList();
      render();
      requestAnimationFrame(() => compactLayout.matches ? fitStep() : fit());
    }
  });
})();
