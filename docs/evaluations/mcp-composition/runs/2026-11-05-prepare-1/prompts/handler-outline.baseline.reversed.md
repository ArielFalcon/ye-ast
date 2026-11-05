# ye-ast composition evaluation — handler-outline / baseline / reversed

You receive evidence returned by a read-only code-analysis MCP server. Use only the responses below: no outside knowledge, no tools, no assumptions about code that is not shown.

## Question

Which declaration handles each HTTP route reported here, and where is it declared? State what is known about the route's deployed URL.

## Proposition catalogue

Assert a proposition only when the responses support it; omit any proposition you reject or cannot support. You may add your own claims.

- p1: An HTTP route reported by entrypoints is handled by a declaration that outline also reports in the same snapshot.
- p2: Every reported route has a known, complete deployment URL.
- p3: An import listed by outline proves that the route handler calls the imported module.
- p4: At least one finding or read in these responses is unknown or partial, and it is reported as such rather than as absent.

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

## Responses (2; families: entrypoints, outline)

### q1 — ye_ast_outline

Request:

```json
{"repo":"shop","revision":"f89dbb6760c1df3b345c5f15e726ddd1c0509f32","files":["src/main/java/shop/OrderController.java"],"mode":"full"}
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
{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"f89dbb6760c1df3b345c5f15e726ddd1c0509f32"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"f742c7bb02d12b5d4b7f4e364a602110be13666837dc788ad388919d56bf1f6d","config":"e5226cebb27da894d267f86abc995526abf862ca35801b6cc4b945893d301ed6","declaredConfig":{"files":["src/main/java/shop/OrderController.java"]},"origin":{"kind":"full"},"engines":{"@colbymchenry/codegraph":"1.6.2","tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":{"files":[{"file":"src/main/java/shop/OrderController.java","declarations":[{"kind":"namespace","name":"shop","line":1,"endLine":1},{"kind":"class","name":"OrderController","line":7,"endLine":17},{"kind":"route","name":"GET /orders/{id}","line":10,"endLine":10},{"kind":"method","name":"one","line":10,"endLine":14},{"kind":"method","name":"first","line":15,"endLine":15},{"kind":"method","name":"second","line":16,"endLine":16}],"imports":[]}],"unheld":[]},"mode":"full","repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"}]}
```

### q0 — ye_ast_entrypoints

Request:

```json
{"repo":"shop","revision":"f89dbb6760c1df3b345c5f15e726ddd1c0509f32","mode":"full"}
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
{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"f89dbb6760c1df3b345c5f15e726ddd1c0509f32"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"f742c7bb02d12b5d4b7f4e364a602110be13666837dc788ad388919d56bf1f6d","config":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":{"entrypoints":{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"f89dbb6760c1df3b345c5f15e726ddd1c0509f32"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"f742c7bb02d12b5d4b7f4e364a602110be13666837dc788ad388919d56bf1f6d","config":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":[{"status":"complete","value":{"kind":"http-route","name":"GET /orders/{id}","method":"GET","path":"/orders/{id}","handler":{"path":"src/main/java/shop/OrderController.java","symbol":"OrderController.one","line":10,"endLine":14},"basePath":{"status":"unknown","reason":"unresolved","evidence":[{"path":"src/main/java/shop/OrderController.java","line":10,"endLine":14}]}},"evidence":[{"path":"src/main/java/shop/OrderController.java","line":10,"endLine":14}]}]}},"mode":"full","recovery":{"version":1,"status":"available","resultIdentity":"mcp-r1:35e9ddade95755d54eb2c64491261e81f4952c1a7169dcc024846638dd302fd6","query":{"name":"ye_ast_entrypoints","arguments":{"repo":"shop","revision":"f89dbb6760c1df3b345c5f15e726ddd1c0509f32"}}},"repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"}]}
```
