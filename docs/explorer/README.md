# Architecture explorer

The unified site: the graph-first explorer plus the concept sections and the walk simulator from the original
narrative explainer. The original [`../explainer/`](../explainer/) stays on disk as source material; this is the site
that is served.

Open [`index.html`](index.html) (English) or [`es.html`](es.html) (Spanish). No build and no network request from the
page.

## What it does

| Piece | Behaviour |
| --- | --- |
| Graph | Six layers, 37 modules and 68 edges: entrypoints, composition, application, domain, ports and adapters. |
| Levels | `Layers` is an overview: select a band to read its description, its modules and its cross-layer dependency counts, then open the module graph deliberately. `Modules` shows every module; `Files` shows the files of the current step's module while keeping the flow, its steps and the step explanation available. |
| Zoom | Wheel zoom, drag pan, two-pointer pinch, `+`/`−`/`Fit`; URL hash like `#impact/7`. |
| Flows | `impact`, `map`, `callers`, `importers`, `workspace`, `install` and `live`; 31 steps in total. |
| Step | Highlights the nodes and edges of the step, dims the rest, anchors a callout to a node with a leader line and opens an explanation with why, relations, nodes, terms and evidence. |
| Node | Clicking a node pauses the flow and switches the header to `Node inspection`; `Back to flow` restores the exact flow and step. The panel shows role, what it may import, what it never reaches, its facts and its files. |
| Concepts | Fact contract and cuts; edge policy and mechanics; a bounds block that explains depth, `fan-in`, `hub fan-in`, expansions and deadline inline; walk simulator; real executions and fixture; trust; surfaces; glossary; sources. |
| Glossary | 30 terms with localized labels and definitions, a filter and "show in graph" links. |

The graph is horizontal in reading order, but arrows show the **flow of a request**, not the import direction. The
dependency rule is the layer order in `AGENTS.md`; the graph is a data-flow view of the same architecture.

## Files

| File | Role |
| --- | --- |
| `index.html`, `es.html` | App shell, concept sections and static UI. Same ids/classes in both. |
| `styles.css` | Application layout, graph, callout, inputs, desktop and phone breakpoints. |
| `concepts.css` | The original document styles, scoped to `.docs`; docs shell, glossary and form controls. |
| `graph.js` | Graph layout, SVG rendering, zoom/pan, levels, flows, callouts, terms and node details. |
| `data.js` | English data: layers, 37 modules, 68 edges, 7 flows and UI labels. |
| `content.es.js` | Spanish UI, module subtitles/details and all 31 flow steps. |
| `modules.en.js`, `modules.es.js` | Module details reused from the original explainer. |
| `glossary.js` | Terms and definitions used by the glossary and the info panel. |
| `concepts.js` | Glossary filter, "show in graph" links and the fact-status playground. |
| `simulator.js` | The walk simulator: seeds, bounds, edge policy, cuts and entrypoints. |
| `sim-ui.js` | Simulator labels in English and Spanish. |
| `README.md` | This file. |

## Adding content

- A module: add it to `modules` in `data.js`; its details go in `modules.en.js`/`modules.es.js` or in
  `extraDetails` (`data.js`) / `modules` (`content.es.js`). Add its edges to `edges`.
- A flow: add it to `flows` in `data.js` and translate its `label`, `question` and each step's `title`, `body` and
  `calloutText` in `content.es.js`. Every `focus`, `edges` pair and `callout` key must exist in the graph.
- A term: add it to `glossary.js` with an English `label` and, when the Spanish label differs, a `labelEs`; use the key in a
  flow's `terms` list or in an info-panel chip.
- A UI string: add it to `ui` in `data.js` and to `ui` in `content.es.js`.

## Serve

```bash
python3 -m http.server 8081 --bind 127.0.0.1 --directory docs/explorer &
tailscale serve --bg --https=8443 http://127.0.0.1:8081
tailscale serve --bg --https=8444 http://127.0.0.1:8081
# https://<machine>.<tailnet>.ts.net:8443/  (original URL, now the unified site)
# https://<machine>.<tailnet>.ts.net:8444/  (canonical)
```

## Verification

- `node --check` on every JS file.
- Both languages, both viewports (1440 × 1000 and 390 × 844): 37 modules, 68 edges, 7 flows, 31 steps, 30 glossary
  terms, simulator and fact playground working, 0 console/page errors, no page-level horizontal overflow.
- `Files` keeps the flow header, the step list and the step explanation, so prev/next, play and every step item work
  without leaving the level; selecting a step moves the hub to that step's callout or focus module, and the step's modules
  remain selectable chips.
- The `Runs` section reveals its cards with the scoped `reveal` animation; its top padding is trimmed so the content
  starts below the sticky navigation.
- `Layers` selects a band in place and shows its description, modules and outgoing/incoming counts; `Open modules` is the
  only action that changes level.
- `hub fan-in` is defined inline in the rules bounds block and again under the simulator controls; `fan-in` and
  `hub fan-in` stay in the glossary with localized labels.
- Every module file and every flow `refs` path exists; every internal hash target exists.
- The old `docs/explainer/` is archived source, not a second served site.
- `npm run check` is unaffected: this folder adds no file under `src/`.
