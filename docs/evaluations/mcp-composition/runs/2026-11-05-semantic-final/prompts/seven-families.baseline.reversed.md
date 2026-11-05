# ye-ast composition evaluation — seven-families / baseline / reversed

You receive evidence returned by a read-only code-analysis MCP server. Use only the responses below: no outside knowledge, no tools, no assumptions about code that is not shown.

## Question

Across all seven responses, what is recorded about the changed code, its callers, its routes and its consumers? Separate recorded relations from what is unknown or limited.

## Proposition catalogue

Assert a proposition only when the responses support it; omit any proposition you reject or cannot support. You may add your own claims.

- p1: A route handler is connected to its declaration with both supports retained.
- p2: A recorded dependence on changed code is attested by more than one family.
- p3: An entrypoint reached by the change is broken.
- p4: A file import proves a call between the two files' declarations.
- p5: A decision option that the decisions response does not list is available.
- p6: At least one read or finding is partial or unknown, and its owner is identified.

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

## Responses (7; families: entrypoints, impact, callers, importers, outline, workspace, decisions)

### q6 — ye_ast_decisions

Request:

```json
{"repo":"shop","revision":"62bbcc206956d889687af5c78ffa1e68bc73b3b3","repos":[{"path":"<fixture-root>/web","id":"web","revision":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"}],"gateways":[{"prefix":"shop-api","repo":"shop"}],"offline":true,"mode":"full"}
```

Text channel:

```text
status: complete
full structured result: structuredContent
Select value.decisions by kind and subject; inspect evidence, options[].basis and options[].recommended. Match evidence repositories to value.repositories snapshots.
Repository locations: match repositoryRoots[].repo to evidence ownership; repositoryRoots[].path locates the clone on disk, while evidence paths are relative to its repository at the recorded snapshot.
```

Structured channel:

```json
{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"9939135e997b4577309281cfaff36813280c2ef4e82800fdd8dfc756eba07f2c","config":"b41cbb85ed8831d64578484788d87825bc6e45ebd920881cd09a68704bd673f8","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":{"decisions":[{"id":"trust:shop","kind":"trust","subject":"shop","evidence":[],"options":[{"value":"trusted","evidence":[],"recommended":false},{"value":"untrusted","evidence":[],"recommended":false}],"allowsFreeText":false,"required":true},{"id":"trust:web","kind":"trust","subject":"web","evidence":[],"options":[{"value":"trusted","evidence":[],"recommended":false},{"value":"untrusted","evidence":[],"recommended":false}],"allowsFreeText":false,"required":true}],"repositories":[{"repo":"shop","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"}},{"repo":"web","snapshot":{"repo":"web","kind":"sha","sha":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"}}],"source":"request"},"mode":"full","repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"},{"repo":"web","path":"<fixture-root>/web"}]}
```

### q5 — ye_ast_workspace

Request:

```json
{"repo":"shop","revision":"62bbcc206956d889687af5c78ffa1e68bc73b3b3","repos":[{"path":"<fixture-root>/web","id":"web","revision":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"}],"gateways":[{"prefix":"shop-api","repo":"shop"}],"offline":true,"mode":"full"}
```

Text channel:

```text
status: complete
full structured result: structuredContent
Match value.sections by repository and check each section status, reason and cuts; value.repositorySnapshots identifies each revision. Inspect value.candidates by name and repo for basis and evidence, and value.unserved for unmatched names.
Repository locations: match repositoryRoots[].repo to evidence ownership; repositoryRoots[].path locates the clone on disk, while evidence paths are relative to its repository at the recorded snapshot.
```

Structured channel:

```json
{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"abe807e57a5d6431b15aefda61ea5f20f43200de24c914f259087c9c7bcdd55e","config":"07a691115d845343d3368ae4d37db47098aab593c02a3e54ac605994962f6402","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":{"workspace":{"repos":["shop","web"],"gateways":[{"prefix":"shop-api","repo":"shop"}],"source":"request"},"repositorySnapshots":[{"repo":"shop","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"}},{"repo":"web","snapshot":{"repo":"web","kind":"sha","sha":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"}}],"sections":{"shop":{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"02c60757baced2ace102d1ee768e5357ca81023f6bca930e3dc69fe8d7648e73","config":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":{"names":[],"unresolved":[]}},"web":{"schema":"0.12.0","snapshot":{"repo":"web","kind":"sha","sha":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"2a34a243ac5fdcb23e079540e485bf30c2eca68f200f28041e5f1ce044fce3f9","config":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[{"path":"src/app/order.page.ts","line":9,"endLine":9},{"path":"src/app/order.page.ts","line":12,"endLine":12}],"status":"complete","value":{"names":[{"name":"shop-api","kind":"path-prefix","evidence":[{"path":"src/app/order.page.ts","line":9,"endLine":9},{"path":"src/app/order.page.ts","line":12,"endLine":12}]}],"unresolved":[]}}},"candidates":[],"unserved":[{"name":"shop-api","kind":"path-prefix","evidence":[{"path":"src/app/order.page.ts","line":9,"endLine":9,"repo":"web"},{"path":"src/app/order.page.ts","line":12,"endLine":12,"repo":"web"}]}]},"mode":"full","repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"},{"repo":"web","path":"<fixture-root>/web"}]}
```

### q4 — ye_ast_outline

Request:

```json
{"repo":"shop","revision":"62bbcc206956d889687af5c78ffa1e68bc73b3b3","files":["src/main/java/shop/OrderController.java"],"mode":"full"}
```

Text channel:

```text
status: complete
full structured result: structuredContent
Select value.files by file; declarations contain name, kind, line and endLine, and imports are paths. Inspect value.unheld for unavailable files and cuts when partial.
Repository locations: match repositoryRoots[].repo to evidence ownership; repositoryRoots[].path locates the clone on disk, while evidence paths are relative to its repository at the recorded snapshot.
```

Structured channel:

```json
{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"f742c7bb02d12b5d4b7f4e364a602110be13666837dc788ad388919d56bf1f6d","config":"e5226cebb27da894d267f86abc995526abf862ca35801b6cc4b945893d301ed6","declaredConfig":{"files":["src/main/java/shop/OrderController.java"]},"origin":{"kind":"full"},"engines":{"@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":{"files":[{"file":"src/main/java/shop/OrderController.java","declarations":[{"kind":"namespace","name":"shop","line":1,"endLine":1},{"kind":"class","name":"OrderController","line":7,"endLine":17},{"kind":"route","name":"GET /orders/{id}","line":10,"endLine":10},{"kind":"method","name":"one","line":10,"endLine":14},{"kind":"method","name":"first","line":15,"endLine":15},{"kind":"method","name":"second","line":16,"endLine":16}],"imports":[]}],"unheld":[]},"mode":"full","repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"}]}
```

### q3 — ye_ast_importers

Request:

```json
{"repo":"web","revision":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02","files":["src/app/order.service.ts"],"mode":"full"}
```

Text channel:

```text
status: partial
full structured result: structuredContent
Select value.files by file; inspect importers and users for recorded links and unresolvedNamers for unconfirmed matches. These are paths only, with no relationship line locations; inspect cuts for partial results.
Repository locations: match repositoryRoots[].repo to evidence ownership; repositoryRoots[].path locates the clone on disk, while evidence paths are relative to its repository at the recorded snapshot.
```

Structured channel:

```json
{"schema":"0.12.0","snapshot":{"repo":"web","kind":"sha","sha":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"},"producer":{"name":"ye-ast","version":"0.4.0+edge-policy.e98d5a56243d"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"096b6035e1dad00b70d4deca988872f2a5478746fd86c84804f23e52f9540d5d","config":"f85707db3cf3d33970e06f6e9276630320ef7fba8f766d74eeea5a3ec60098c7","declaredConfig":{"files":["src/app/order.service.ts"]},"origin":{"kind":"full"},"engines":{"@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"partial","value":{"files":[{"file":"src/app/order.service.ts","importers":["src/app/order.page.ts"],"reexporters":[],"dynamicImporters":[],"typeImporters":[],"users":["src/app/order.page.ts"],"unresolvedNamers":[]}]},"cuts":[{"kind":"unresolved-link","at":["src/app/order.page.ts:1 @angular/common/http"]},{"kind":"unresolved-link","at":["src/app/order.page.ts:2 @angular/core"]}],"mode":"full","repositoryRoots":[{"repo":"web","path":"<fixture-root>/web"}]}
```

### q2 — ye_ast_callers

Request:

```json
{"repo":"shop","revision":"62bbcc206956d889687af5c78ffa1e68bc73b3b3","targets":[{"file":"src/main/java/shop/OrderController.java","symbol":"OrderController.one"}],"workspace":{"repos":[{"path":"<fixture-root>/web","id":"web","revision":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"}],"gateways":[{"prefix":"shop-api","repo":"shop"}]},"offline":true,"mode":"full"}
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
  Destination: repo "shop", revision "62bbcc206956d889687af5c78ffa1e68bc73b3b3", file "src/main/java/shop/OrderController.java", symbol "OrderController.one". Use outline or callers on the declared owner.
  Repeat callers with repo "shop" and revision "62bbcc206956d889687af5c78ffa1e68bc73b3b3", retaining declared scope and symbol selection. Related outline/importers queries answer a new question.
Recovery recipe and resultIdentity: structuredContent.recovery.
Repository locations: match repositoryRoots[].repo to evidence ownership; repositoryRoots[].path locates the clone on disk, while evidence paths are relative to its repository at the recorded snapshot.
```

Structured channel:

```json
{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"938e5438e41fc51de153254c357d9be392305d9a3a87ba054c54e59a65684c6f","config":"dd694c4548dfecdf8277cb48d562ecbc9ed50f7e00fb2b7aa2b47f4dacaff042","declaredConfig":{"targets":["src/main/java/shop/OrderController.java:OrderController.one"]},"engines":{"@angular/compiler":"22.2.4","@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"partial","value":{"workspace":{"repos":["shop","web"],"gateways":[{"prefix":"shop-api","repo":"shop","basis":"gateway-prefix"}],"unmatchedGateways":[],"unserved":[],"source":"request"},"repositorySnapshots":[{"repo":"shop","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"}},{"repo":"web","snapshot":{"repo":"web","kind":"sha","sha":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"}}],"trigger":{"repo":"shop"},"sections":{"shop":{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"0c67f95ca01a40c2ee868cf749950659273b637af211e0bd152df74cd320ec71","config":"87dc84057204b09654adad8bc71d0fb03dc9ebc7d62b2dcc226cbe3aac0af0c8","declaredConfig":{"targets":["src/main/java/shop/OrderController.java:OrderController.one"]},"engines":{"@angular/compiler":"22.2.4","@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":{"reads":[{"kind":"discovery","fact":{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"02c60757baced2ace102d1ee768e5357ca81023f6bca930e3dc69fe8d7648e73","config":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete"}},{"kind":"trigger","fact":{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"},"producer":{"name":"ye-ast","version":"0.4.0+edge-policy.e98d5a56243d"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"f742c7bb02d12b5d4b7f4e364a602110be13666837dc788ad388919d56bf1f6d","config":"a337eb90d6fea0bef173e3b75298d9dd9c9b6a5b6c791964d594eddc94539e19","declaredConfig":{"targets":["src/main/java/shop/OrderController.java:OrderController.one"]},"origin":{"kind":"full"},"engines":{"@angular/compiler":"22.2.4","@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete"}}],"impact":{"cost":{"expansionsUsed":2},"seeds":[{"file":"src/main/java/shop/OrderController.java","symbol":"one","line":10,"endLine":14,"basis":"requested"}],"symbols":[{"file":"src/main/java/shop/OrderController.java","symbol":"OrderController","kind":"class","line":7,"endLine":17,"depth":0,"confidence":1,"fanIn":0,"via":{"file":"src/main/java/shop/OrderController.java","symbol":"one","basis":"contains"}},{"file":"src/main/java/shop/OrderController.java","symbol":"one","kind":"method","line":10,"endLine":14,"depth":0,"confidence":1,"fanIn":0}],"entrypoints":[{"kind":"http-route","name":"GET /orders/{id}","handler":{"path":"src/main/java/shop/OrderController.java","symbol":"OrderController.one","line":10,"endLine":14},"depth":0,"confidence":1,"seeds":[0]}]},"callSites":[],"unmatched":[],"external":[]}},"web":{"schema":"0.12.0","snapshot":{"repo":"web","kind":"sha","sha":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"73e29faff0073976249618868c4595f95c1f5616644f2f26bfa0f05bd1a85125","config":"85ee8fbed174d79c0f65febb55275cdfab23b7a0a05df244646f0db6dd3a68da","declaredConfig":{},"engines":{"@angular/compiler":"22.2.4","@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[{"path":"src/app/order.page.ts","line":9,"endLine":9},{"path":"src/app/order.page.ts","line":12,"endLine":12}],"status":"partial","value":{"reads":[{"kind":"discovery","fact":{"schema":"0.12.0","snapshot":{"repo":"web","kind":"sha","sha":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"2a34a243ac5fdcb23e079540e485bf30c2eca68f200f28041e5f1ce044fce3f9","config":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[{"path":"src/app/order.page.ts","line":9,"endLine":9},{"path":"src/app/order.page.ts","line":12,"endLine":12}],"status":"complete"}},{"kind":"upstream","fact":{"schema":"0.12.0","snapshot":{"repo":"web","kind":"sha","sha":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"},"producer":{"name":"ye-ast","version":"0.4.0+edge-policy.e98d5a56243d"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"096b6035e1dad00b70d4deca988872f2a5478746fd86c84804f23e52f9540d5d","config":"a531d0c3ae20a155b17b7df958b943e7b81c6238420b3527fe17d225fbfd43c0","declaredConfig":{"targets":["src/app/order.page.ts:9-9"]},"origin":{"kind":"full"},"engines":{"@angular/compiler":"22.2.4","@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"partial","cuts":[{"kind":"unresolved-link","at":["src/app/order.page.ts","src/app/order.page.ts:1 no-project"]}]}}],"impact":{"cost":{"expansionsUsed":2},"seeds":[{"file":"src/app/order.page.ts","symbol":"open","line":7,"endLine":10,"basis":"lines"}],"symbols":[{"file":"src/app/order.page.ts","symbol":"OrderPage","kind":"class","line":5,"endLine":17,"depth":0,"confidence":1,"fanIn":0,"via":{"file":"src/app/order.page.ts","symbol":"open","basis":"contains"}},{"file":"src/app/order.page.ts","symbol":"open","kind":"method","line":7,"endLine":10,"depth":0,"confidence":1,"fanIn":0}],"entrypoints":[]},"callSites":[{"repo":"web","file":"src/app/order.page.ts","line":9,"endLine":9,"symbol":"OrderPage.open","ancestors":[{"symbol":"open","line":7,"endLine":10},{"symbol":"OrderPage","line":5,"endLine":17}],"transport":"http","target":{"status":"complete","value":{"method":"GET","path":"shop-api/orders/7"},"evidence":[{"path":"src/app/order.page.ts","line":9}]}}],"unmatched":[{"repo":"web","file":"src/app/order.page.ts","line":12,"endLine":12,"symbol":"OrderPage.missing","ancestors":[{"symbol":"missing","line":11,"endLine":13},{"symbol":"OrderPage","line":5,"endLine":17}],"transport":"http","target":{"status":"complete","value":{"method":"GET","path":"shop-api/refunds/7"},"evidence":[{"path":"src/app/order.page.ts","line":12}]}}],"external":[]},"cuts":[{"kind":"unresolved-link","at":["src/app/order.page.ts","src/app/order.page.ts:1 no-project"]}]}},"links":[{"link":{"from":{"repo":"web","file":"src/app/order.page.ts","line":9,"symbol":"OrderPage.open"},"to":{"repo":"shop","kind":"http-route","name":"GET /orders/{id}","handler":{"path":"src/main/java/shop/OrderController.java","symbol":"OrderController.one","line":10,"endLine":14}},"transport":"http","basis":"gateway-prefix","confidence":1,"id":"[\"web\",\"src/app/order.page.ts\",9,\"OrderPage.open\",\"shop\",\"http-route\",\"GET /orders/{id}\",\"src/main/java/shop/OrderController.java\",\"OrderController.one\",10,\"http\",\"gateway-prefix\",null]"},"direction":"upstream","reach":["[\"web\",\"src/app/order.page.ts\",9,\"OrderPage.open\",\"shop\",\"http-route\",\"GET /orders/{id}\",\"src/main/java/shop/OrderController.java\",\"OrderController.one\",10,\"http\",\"gateway-prefix\",null]"]}]},"cuts":[{"kind":"section","at":["web"]}],"mode":"full","recovery":{"version":1,"status":"available","resultIdentity":"mcp-r1:69d53ead1c3e976a0e182c94dd87d14e9bc0fb66e335b80e2435acab776d2e38","query":{"name":"ye_ast_callers","arguments":{"repo":"shop","workspace":{"repos":[{"path":"<fixture-root>/web","id":"web","revision":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"}],"gateways":[{"prefix":"shop-api","repo":"shop"}]},"replay":{"version":1,"declaration":"ws-r1:bba76240c0855ac8e41f2f18ddf30514e9c188fd8f7e2ea320550ee2f3614668","snapshots":[{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"},{"repo":"web","kind":"sha","sha":"b222c7c8b1e6b6d7b9dba3c9a9cc67b7e1df7c02"}]},"offline":true,"revision":"62bbcc206956d889687af5c78ffa1e68bc73b3b3","targets":[{"file":"src/main/java/shop/OrderController.java","symbol":"OrderController.one"}]}}},"repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"},{"repo":"web","path":"<fixture-root>/web"}]}
```

### q1 — ye_ast_impact

Request:

```json
{"repo":"shop","base":"6b9ea72b0431fe963122022594396e3c2546a7b2","head":"62bbcc206956d889687af5c78ffa1e68bc73b3b3","changed":["src/main/java/**"],"offline":true,"mode":"full"}
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
  Keep repo "shop" and the same snapshot when repeating this query: head "62bbcc206956d889687af5c78ffa1e68bc73b3b3" and base "6b9ea72b0431fe963122022594396e3c2546a7b2"; retain the declared scope and change selection. For a related callers/outline/importers query about head evidence use revision "62bbcc206956d889687af5c78ffa1e68bc73b3b3" instead of impact base/head. It answers a new question, not a filter over this result.
Recovery recipe and resultIdentity: structuredContent.recovery.
Repository locations: match repositoryRoots[].repo to evidence ownership; repositoryRoots[].path locates the clone on disk, while evidence paths are relative to its repository at the recorded snapshot.
```

Structured channel:

```json
{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"},"producer":{"name":"ye-ast","version":"0.4.0+edge-policy.e98d5a56243d"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"1fc42211742061989b0e630d4678a56b2b814410b2a58e0719df1240fad268d7","config":"a62c539ac5894d97778c82921ed43b5414433ec9bc73cb97ae0f052bd4935118","declaredConfig":{"changed":["src/main/java/**"]},"origin":{"kind":"full"},"engines":{"@angular/compiler":"22.2.4","@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":{"mergeBase":"6b9ea72b0431fe963122022594396e3c2546a7b2","seeds":[{"file":"src/main/java/shop/OrderController.java","symbol":"one","line":10,"endLine":14,"basis":"lines"}],"changedEntrypoints":[],"symbols":[{"file":"src/main/java/shop/OrderController.java","symbol":"OrderController","kind":"class","line":7,"endLine":17,"depth":0,"confidence":1,"fanIn":0,"via":{"file":"src/main/java/shop/OrderController.java","symbol":"one","basis":"contains"}},{"file":"src/main/java/shop/OrderController.java","symbol":"one","kind":"method","line":10,"endLine":14,"depth":0,"confidence":1,"fanIn":0}],"entrypoints":[{"kind":"http-route","name":"GET /orders/{id}","handler":{"path":"src/main/java/shop/OrderController.java","symbol":"OrderController.one","line":10,"endLine":14},"depth":0,"confidence":1,"seeds":[0]}],"cost":{"expansionsUsed":2}},"mode":"full","recovery":{"version":1,"status":"available","resultIdentity":"mcp-r1:d02123e958d2ab7314ccfd07a04ea68fa386a6fbe88350fb905f6800d5783960","query":{"name":"ye_ast_impact","arguments":{"repo":"shop","base":"6b9ea72b0431fe963122022594396e3c2546a7b2","head":"62bbcc206956d889687af5c78ffa1e68bc73b3b3","changed":["src/main/java/**"]}}},"repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"}]}
```

### q0 — ye_ast_entrypoints

Request:

```json
{"repo":"shop","revision":"62bbcc206956d889687af5c78ffa1e68bc73b3b3","mode":"full"}
```

Text channel:

```text
status: complete
full structured result: structuredContent
Selection lookup: findingIndex is the zero-based position in value.entrypoints.value. Check value.entrypoints.status and value.entrypoints.value; match each complete finding in value.entrypoints.value[].value by kind/name and handler or component coordinates. Inspect basePath status and evidence for HTTP routes; unknown findings carry reason and evidence, and partial sections carry cuts.
Recovery recipe and resultIdentity: structuredContent.recovery.
Repository locations: match repositoryRoots[].repo to evidence ownership; repositoryRoots[].path locates the clone on disk, while evidence paths are relative to its repository at the recorded snapshot.
```

Structured channel:

```json
{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"f742c7bb02d12b5d4b7f4e364a602110be13666837dc788ad388919d56bf1f6d","config":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":{"entrypoints":{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"f742c7bb02d12b5d4b7f4e364a602110be13666837dc788ad388919d56bf1f6d","config":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":[{"status":"complete","value":{"kind":"http-route","name":"GET /orders/{id}","method":"GET","path":"/orders/{id}","handler":{"path":"src/main/java/shop/OrderController.java","symbol":"OrderController.one","line":10,"endLine":14},"basePath":{"status":"unknown","reason":"unresolved","evidence":[{"path":"src/main/java/shop/OrderController.java","line":10,"endLine":14}]}},"evidence":[{"path":"src/main/java/shop/OrderController.java","line":10,"endLine":14}]}]}},"mode":"full","recovery":{"version":1,"status":"available","resultIdentity":"mcp-r1:6a9af306121c9eb14c91b53c939f3df0981dbae34ad12b3d1f6cf25fc44be717","query":{"name":"ye_ast_entrypoints","arguments":{"repo":"shop","revision":"62bbcc206956d889687af5c78ffa1e68bc73b3b3"}}},"repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"}]}
```
