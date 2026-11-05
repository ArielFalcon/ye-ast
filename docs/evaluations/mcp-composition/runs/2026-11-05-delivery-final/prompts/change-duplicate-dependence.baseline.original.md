# ye-ast composition evaluation — change-duplicate-dependence / baseline / original

You receive evidence returned by a read-only code-analysis MCP server. Use only the responses below: no outside knowledge, no tools, no assumptions about code that is not shown.

## Question

Which declarations depend on the changed code, and which entrypoints did the change reach? Separate what is recorded from what is not proven.

## Proposition catalogue

Assert a proposition only when the responses support it; omit any proposition you reject or cannot support. You may add your own claims.

- p1: A symbol dependence on a changed declaration is recorded, and it is attested by both impact and callers.
- p2: Because the change reaches an entrypoint, that entrypoint is broken by the change.
- p3: There is a further dependency chain beyond the recorded relations that connects the change to additional entrypoints.
- p4: A traversal bound, cut or unknown read limits what these responses prove.

## Citations

Cite a baseline response as `q<N>:<JSON pointer>`, where N is the number in the response heading and the RFC 6901 pointer (starting with `/`) selects the supporting value inside that response's structured channel. Example: `q0:/value/routes/0`.
Every claim and every uncertainty needs at least one citation that supports it. A shared location alone does not prove a call, a dependency or a breakage.

## Answer format

Reply with exactly one JSON object and nothing else:

```json
{"answer":"<your prose answer to the question>","claims":[{"id":"p1","text":"<your wording>","citations":["<citation>"]}],"uncertainties":[{"id":"extra:1","text":"<limitation you assert>","citations":["<citation>"]}]}
```

- `claims`: catalogue propositions you assert (their catalogue id) and your own factual claims (`extra:<n>`).
- `uncertainties`: unknown, partial, limited or unresolved points you assert, with a catalogue id or `extra:<n>`.

## Responses (2; families: impact, callers)

### q0 — ye_ast_impact

Request:

```json
{"repo":"shop","base":"d186f90284ad2f98e081d03d8d1ef60020aaab6f","head":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c","changed":["src/main/java/**"],"offline":true,"mode":"full"}
```

Text channel:

```text
status: complete
full structured result: structuredContent
Investigation guide:
  JSON navigation: paths below are relative to structuredContent.
  Selection lookup: use handler path, symbol and line with owner {kind:"local"}.
  To inspect a reached entrypoint, select value.entrypoints by kind/name and handler.path, handler.symbol, handler.line. Its seeds are zero-based indexes into value.seeds; resolve those indexes to recover all associated origins, not a complete call chain.
  To inspect a dependency omitted from text, filter value.symbols by file, symbol and line. Read via.file/symbol for its recorded dependency; via.lines are locations in that symbol's own file, not in via.file. Preserve via.basis and confidence when interpreting it.
  Keep repo "shop" and the same snapshot when repeating this query: head "59b76e9aa54fe237d02cba8200a7bb93ca11c30c" and base "d186f90284ad2f98e081d03d8d1ef60020aaab6f"; retain the declared scope and change selection. For a related callers/outline/importers query about head evidence use revision "59b76e9aa54fe237d02cba8200a7bb93ca11c30c" instead of impact base/head. It answers a new question, not a filter over this result.
Recovery recipe and resultIdentity: structuredContent.recovery.
Repository locations: match repositoryRoots[].repo to evidence ownership; repositoryRoots[].path locates the clone on disk, while evidence paths are relative to its repository at the recorded snapshot.
```

Structured channel:

```json
{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c"},"producer":{"name":"ye-ast","version":"0.4.0+edge-policy.e98d5a56243d"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"0bc3e20675988140245ff6255fa73930ed8ea03c5121f98bff1bb684f15ce14c","config":"a62c539ac5894d97778c82921ed43b5414433ec9bc73cb97ae0f052bd4935118","declaredConfig":{"changed":["src/main/java/**"]},"origin":{"kind":"full"},"engines":{"@angular/compiler":"22.2.4","@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":{"mergeBase":"d186f90284ad2f98e081d03d8d1ef60020aaab6f","seeds":[{"file":"src/main/java/shop/OrderController.java","symbol":"one","line":10,"endLine":14,"basis":"lines"}],"changedEntrypoints":[],"symbols":[{"file":"src/main/java/shop/OrderController.java","symbol":"OrderController","kind":"class","line":7,"endLine":17,"depth":0,"confidence":1,"fanIn":0,"via":{"file":"src/main/java/shop/OrderController.java","symbol":"one","basis":"contains"}},{"file":"src/main/java/shop/OrderController.java","symbol":"one","kind":"method","line":10,"endLine":14,"depth":0,"confidence":1,"fanIn":0}],"entrypoints":[{"kind":"http-route","name":"GET /orders/{id}","handler":{"path":"src/main/java/shop/OrderController.java","symbol":"OrderController.one","line":10,"endLine":14},"depth":0,"confidence":1,"seeds":[0]}],"cost":{"expansionsUsed":2}},"mode":"full","recovery":{"version":1,"status":"available","resultIdentity":"mcp-r1:d53223fdb5ab4fea1e4ac3876f784c9b13e62c15738f5d24708e40dafce593bd","query":{"name":"ye_ast_impact","arguments":{"repo":"shop","base":"d186f90284ad2f98e081d03d8d1ef60020aaab6f","head":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c","changed":["src/main/java/**"]}}},"repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"}]}
```

### q1 — ye_ast_callers

Request:

```json
{"repo":"shop","revision":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c","targets":[{"file":"src/main/java/shop/OrderController.java","symbol":"OrderController.one"}],"workspace":{"repos":[{"path":"<fixture-root>/web","id":"web","revision":"3e69e9d3c2285375dd92629e23a8ef4487d2bb9e"}],"gateways":[{"prefix":"shop-api","repo":"shop"}]},"offline":true,"mode":"full"}
```

Text channel:

```text
status: partial
full structured result: structuredContent
Investigation guide:
  JSON navigation: paths below are relative to structuredContent.
  Select value.sections by the exact repository key, not a shared relative file path. Check section.status and, when present, section.reason/cuts and section.value.reads[].fact status/reason before using its evidence; an unknown section has no value.
  The originating repository's walk is at value.sections["shop"].value.impact.
  Selection lookup: use handler path, symbol and line with owner {kind:"section",repo:<repository key>}.
  To inspect a reached entrypoint, select value.sections["shop"].value.impact.entrypoints by kind/name and handler.path, handler.symbol, handler.line. Its seeds are zero-based indexes into value.sections["shop"].value.impact.seeds; resolve those indexes to recover all associated origins, not a complete call chain.
  To inspect a dependency omitted from text, filter value.sections["shop"].value.impact.symbols by file, symbol and line. Read via.file/symbol for its recorded dependency; via.lines are locations in that symbol's own file, not in via.file. Preserve via.basis and confidence when interpreting it.
  Other repository walks are at value.sections[repo].value.impact only when that field exists. In each walk, entrypoints[].seeds indexes that same walk's seeds array; never join origins across repositories.
  To follow a cross-repository consequence, filter value.links by link.from (repo/file/symbol/line) or link.to (repo/name/handler). Each reach contains link IDs in recorded order: resolve them against value.links[].link.id, not the text's display numbers. Retain direction, basis and confidence; reach does not establish an unrecorded path inside a repository.
  Selection lookup: cutIndex is the zero-based position in cuts; owner identifies the fact, entrypoints section, repository section or indexed read.
  Before treating this result as exhaustive, inspect cuts: filter by kind and the relevant anchor in at; a recorded limit explains where coverage stopped. Full JSON does not extend that coverage.
  Repository-local limits remain in value.sections[repo].cuts; inspect contributing section.value.reads[].fact too. Do not treat a complete independent read as resolving an unknown contributing read.
  For a related callers or outline query about head evidence choose the recorded owner with repo and its own snapshot from value.repositorySnapshots; base-side modules require their owning walk's recorded merge base instead. An undeclared owner requires a host registration update or an instance bound to that clone. A symbol name may match multiple declarations.
  Destination: repo "shop", revision "59b76e9aa54fe237d02cba8200a7bb93ca11c30c", file "src/main/java/shop/OrderController.java", symbol "OrderController.one". Use outline or callers on the declared owner.
  Repeat callers with repo "shop" and revision "59b76e9aa54fe237d02cba8200a7bb93ca11c30c", retaining declared scope and symbol selection. Related outline/importers queries answer a new question.
Recovery recipe and resultIdentity: structuredContent.recovery.
Repository locations: match repositoryRoots[].repo to evidence ownership; repositoryRoots[].path locates the clone on disk, while evidence paths are relative to its repository at the recorded snapshot.
```

Structured channel:

```json
{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"0fe3f6830e95a6f3c8e1831a560fe76c3a426170669e048845353d55249f7284","config":"8615ff023f90e46eca141e6d22d70b2fb37ad23fe4f68dc5d6c10782164ef52b","declaredConfig":{"targets":["src/main/java/shop/OrderController.java:OrderController.one"]},"engines":{"@angular/compiler":"22.2.4","@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"partial","value":{"workspace":{"repos":["shop","web"],"gateways":[{"prefix":"shop-api","repo":"shop","basis":"gateway-prefix"}],"unmatchedGateways":[],"unserved":[],"source":"request"},"repositorySnapshots":[{"repo":"shop","snapshot":{"repo":"shop","kind":"sha","sha":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c"}},{"repo":"web","snapshot":{"repo":"web","kind":"sha","sha":"3e69e9d3c2285375dd92629e23a8ef4487d2bb9e"}}],"trigger":{"repo":"shop"},"sections":{"shop":{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"d7adb270bb95b04d93af51fd1a9a27fafaf693877aa7dc952c93cbb23f24e636","config":"148d35378902116aa95bcde63948d74dadeb2a0d1c7b258d3953d2d2cc3fac9d","declaredConfig":{"targets":["src/main/java/shop/OrderController.java:OrderController.one"]},"engines":{"@angular/compiler":"22.2.4","@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":{"reads":[{"kind":"discovery","fact":{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"02c60757baced2ace102d1ee768e5357ca81023f6bca930e3dc69fe8d7648e73","config":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete"}},{"kind":"trigger","fact":{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c"},"producer":{"name":"ye-ast","version":"0.4.0+edge-policy.e98d5a56243d"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"f742c7bb02d12b5d4b7f4e364a602110be13666837dc788ad388919d56bf1f6d","config":"a337eb90d6fea0bef173e3b75298d9dd9c9b6a5b6c791964d594eddc94539e19","declaredConfig":{"targets":["src/main/java/shop/OrderController.java:OrderController.one"]},"origin":{"kind":"full"},"engines":{"@angular/compiler":"22.2.4","@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete"}}],"impact":{"cost":{"expansionsUsed":2},"seeds":[{"file":"src/main/java/shop/OrderController.java","symbol":"one","line":10,"endLine":14,"basis":"requested"}],"symbols":[{"file":"src/main/java/shop/OrderController.java","symbol":"OrderController","kind":"class","line":7,"endLine":17,"depth":0,"confidence":1,"fanIn":0,"via":{"file":"src/main/java/shop/OrderController.java","symbol":"one","basis":"contains"}},{"file":"src/main/java/shop/OrderController.java","symbol":"one","kind":"method","line":10,"endLine":14,"depth":0,"confidence":1,"fanIn":0}],"entrypoints":[{"kind":"http-route","name":"GET /orders/{id}","handler":{"path":"src/main/java/shop/OrderController.java","symbol":"OrderController.one","line":10,"endLine":14},"depth":0,"confidence":1,"seeds":[0]}]},"callSites":[],"unmatched":[],"external":[]}},"web":{"schema":"0.12.0","snapshot":{"repo":"web","kind":"sha","sha":"3e69e9d3c2285375dd92629e23a8ef4487d2bb9e"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"aa99841059a94909b987a53ac021133598880d8f472099a7205d682c3012c627","config":"0aeaae6845f13ce9e9d4cf4d9f24d840668eaa7421c35f3710740af01f81f831","declaredConfig":{},"engines":{"@angular/compiler":"22.2.4","@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[{"path":"src/app/order.page.ts","line":9,"endLine":9},{"path":"src/app/order.page.ts","line":12,"endLine":12}],"status":"partial","value":{"reads":[{"kind":"discovery","fact":{"schema":"0.12.0","snapshot":{"repo":"web","kind":"sha","sha":"3e69e9d3c2285375dd92629e23a8ef4487d2bb9e"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"2a34a243ac5fdcb23e079540e485bf30c2eca68f200f28041e5f1ce044fce3f9","config":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[{"path":"src/app/order.page.ts","line":9,"endLine":9},{"path":"src/app/order.page.ts","line":12,"endLine":12}],"status":"complete"}},{"kind":"upstream","fact":{"schema":"0.12.0","snapshot":{"repo":"web","kind":"sha","sha":"3e69e9d3c2285375dd92629e23a8ef4487d2bb9e"},"producer":{"name":"ye-ast","version":"0.4.0+edge-policy.e98d5a56243d"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"096b6035e1dad00b70d4deca988872f2a5478746fd86c84804f23e52f9540d5d","config":"a531d0c3ae20a155b17b7df958b943e7b81c6238420b3527fe17d225fbfd43c0","declaredConfig":{"targets":["src/app/order.page.ts:9-9"]},"origin":{"kind":"full"},"engines":{"@angular/compiler":"22.2.4","@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"partial","cuts":[{"kind":"unresolved-link","at":["src/app/order.page.ts","src/app/order.page.ts:1 no-project"]}]}}],"impact":{"cost":{"expansionsUsed":2},"seeds":[{"file":"src/app/order.page.ts","symbol":"open","line":7,"endLine":10,"basis":"lines"}],"symbols":[{"file":"src/app/order.page.ts","symbol":"OrderPage","kind":"class","line":5,"endLine":17,"depth":0,"confidence":1,"fanIn":0,"via":{"file":"src/app/order.page.ts","symbol":"open","basis":"contains"}},{"file":"src/app/order.page.ts","symbol":"open","kind":"method","line":7,"endLine":10,"depth":0,"confidence":1,"fanIn":0}],"entrypoints":[]},"callSites":[{"repo":"web","file":"src/app/order.page.ts","line":9,"endLine":9,"symbol":"OrderPage.open","ancestors":[{"symbol":"open","line":7,"endLine":10},{"symbol":"OrderPage","line":5,"endLine":17}],"transport":"http","target":{"status":"complete","value":{"method":"GET","path":"shop-api/orders/7"},"evidence":[{"path":"src/app/order.page.ts","line":9}]}}],"unmatched":[{"repo":"web","file":"src/app/order.page.ts","line":12,"endLine":12,"symbol":"OrderPage.missing","ancestors":[{"symbol":"missing","line":11,"endLine":13},{"symbol":"OrderPage","line":5,"endLine":17}],"transport":"http","target":{"status":"complete","value":{"method":"GET","path":"shop-api/refunds/7"},"evidence":[{"path":"src/app/order.page.ts","line":12}]}}],"external":[]},"cuts":[{"kind":"unresolved-link","at":["src/app/order.page.ts","src/app/order.page.ts:1 no-project"]}]}},"links":[{"link":{"from":{"repo":"web","file":"src/app/order.page.ts","line":9,"symbol":"OrderPage.open"},"to":{"repo":"shop","kind":"http-route","name":"GET /orders/{id}","handler":{"path":"src/main/java/shop/OrderController.java","symbol":"OrderController.one","line":10,"endLine":14}},"transport":"http","basis":"gateway-prefix","confidence":1,"id":"[\"web\",\"src/app/order.page.ts\",9,\"OrderPage.open\",\"shop\",\"http-route\",\"GET /orders/{id}\",\"src/main/java/shop/OrderController.java\",\"OrderController.one\",10,\"http\",\"gateway-prefix\",null]"},"direction":"upstream","reach":["[\"web\",\"src/app/order.page.ts\",9,\"OrderPage.open\",\"shop\",\"http-route\",\"GET /orders/{id}\",\"src/main/java/shop/OrderController.java\",\"OrderController.one\",10,\"http\",\"gateway-prefix\",null]"]}]},"cuts":[{"kind":"section","at":["web"]}],"mode":"full","recovery":{"version":1,"status":"available","resultIdentity":"mcp-r1:cbc615f474e655f3b0918ef10150d69cd95839f71c1999dc3af08dbdbd714faa","query":{"name":"ye_ast_callers","arguments":{"repo":"shop","workspace":{"repos":[{"path":"<fixture-root>/web","id":"web","revision":"3e69e9d3c2285375dd92629e23a8ef4487d2bb9e"}],"gateways":[{"prefix":"shop-api","repo":"shop"}]},"replay":{"version":1,"declaration":"ws-r1:d1107efcdf6127d70e4ebfb6e020d7bcc8ecd5529e2c1181be5d719f884723c7","snapshots":[{"repo":"shop","kind":"sha","sha":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c"},{"repo":"web","kind":"sha","sha":"3e69e9d3c2285375dd92629e23a8ef4487d2bb9e"}]},"offline":true,"revision":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c","targets":[{"file":"src/main/java/shop/OrderController.java","symbol":"OrderController.one"}]}}},"repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"},{"repo":"web","path":"<fixture-root>/web"}]}
```
