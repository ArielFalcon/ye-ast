> **Archived source.** This folder is the original narrative explainer, kept as source for the graph site. The
> unified site is [`../explorer/`](../explorer/) and is the one served.
>
# Interactive architecture explainer

Open [`index.html`](index.html) for English or [`es.html`](es.html) for Spanish. No build and no network request: the
pages are plain HTML, CSS and JavaScript, and every asset is local.

It explains ye-ast's architecture and mechanics in one place:

| Section | What it answers |
| --- | --- |
| Atlas | Which layer owns what, what it may import, and what the dependency rule forbids. |
| Fact contract | Why every answer is `complete`, `partial` or `unknown`, and what a cut names. |
| Impact walk | Twelve steps from `ye-ast impact` to a fact, with `file:line` evidence. |
| Simulator | The same policy on a toy graph, with seeds, owner expansion, confidence, bounds, cuts and entrypoints. |
| Other queries | `map`, `callers` and `importers`, with real captured output. |
| Trust & surfaces | Export-at-sha, the live mirror, and the CLI/MCP/protocol boundary. |
| Sources | The claim-by-claim evidence table and the limits of the page. |

## The `visual-explainer` question

[`visual-explainer`](https://github.com/nicobailon/visual-explainer) is an agent skill, not a library: a `SKILL.md`
contract, a `kit/` stylesheet and scripts, command templates, and a renderer that writes self-contained HTML into
`~/.agent/diagrams/`. There is no component API to import. This page borrows its design principles — figure first, one
visual register, linked emphasis, stepped replay, self-contained output — and implements them with no dependency. It
does not vendor the kit or use the renderer. Section 08 of the page states the same, with the license note.

## Files

| File | Role |
| --- | --- |
| `index.html` | English structure and copy. Every `src/` or `docs/` reference is a relative link from this folder. |
| `es.html` | Spanish structure and copy. Same ids, classes and data attributes as `index.html`. |
| `content.es.js` | Spanish overrides for the dynamic content (atlas, steps, simulator labels). English remains the source of truth in `app.js`. |
| `styles.css` | The blueprint register, light and dark themes, responsive layout, reduced-motion and print rules. |
| `app.js` | Atlas inspector, dependency checker, fact playground, step player and the walk simulator. It selects `EN_UI` or `window.EXPLAINER_ES` from `<html lang>`. |
| `README.md` | This file. |

The topbar language switch links the two pages. If you add a UI string, add it to `EN_UI` in `app.js` and to
`ui` in `content.es.js`; if you add a step or an atlas entry, add only its translatable fields to the Spanish file
(`role`, `may`, `never`, `facts`, or `title`, `body`, `why`).

## The real runs

The two run cards and the query cards are copied from local runs of this build (0.2.0, schema 0.4.0) on two fixture
repositories created outside the worktree:

- a plain TypeScript repository (`complete`);
- an Angular-route repository with one `.rb` file (`partial`, cut `no-extractor`).

To refresh them, create a fixture with a small git history and run:

```bash
node --import tsx src/composition/main.ts map      <fixture>
node --import tsx src/composition/main.ts impact   <fixture> --base HEAD~1
node --import tsx src/composition/main.ts callers  <fixture> src/auth/token.ts:validateToken
node --import tsx src/composition/main.ts importers <fixture> src/auth/token.ts src/auth/auth.service.ts
```

Then update the `REAL` object in `app.js`. The fixture is intentionally not committed: it needs its own git history,
and the page only needs the captured values.

## Serve it

For a local preview:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory docs/explainer
# http://127.0.0.1:8080/
```

To reach it from a phone on the tailnet, proxy that server through Tailscale Serve on a free port (macOS cannot serve a
directory directly, so it proxies the local server):

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory docs/explainer &
tailscale serve --bg --https=8443 http://127.0.0.1:8080
# https://<machine>.<tailnet>.ts.net:8443/
```

## Verification

- `node --check docs/explainer/app.js` and `node --check docs/explainer/content.es.js`
- Open both pages at 1440 px and 390 px; both themes; English and Spanish; no console errors and no page-level
  horizontal overflow. The tables stack, the simulator canvas pans horizontally, and the mobile section selector jumps
  to each section.
- The simulator is a model, not the engine. Its rules cite the real files; its numbers are illustrative.
- `npm run check` is unaffected: the page adds no file under `src/`.
