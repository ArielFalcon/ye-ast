# ye-ast composition evaluation — decision-options / composed / original

You receive evidence returned by a read-only code-analysis MCP server. Use only the responses below: no outside knowledge, no tools, no assumptions about code that is not shown.

## Question

Which configuration decisions are open, which options are available, and is any option recommended by the evidence?

## Proposition catalogue

Assert a proposition only when the responses support it; omit any proposition you reject or cannot support. You may add your own claims.

- p1: At least one decision lists its options exactly as reported, including whether each is recommended and whether free text is allowed.
- p2: An option not listed by the decisions response is available or recommended.
- p3: The decisions response recommends one of the listed options.

## Citations

Cite composed evidence by a full wire id that appears in the structured channel's `graph` tables (for example a `p1:…` part, `l1:…` relation, `c1:…` connection, `e1:…` evidence or `r1:…` read).
Every claim and every uncertainty needs at least one citation that supports it. A shared location alone does not prove a call, a dependency or a breakage.

## Answer format

Reply with exactly one JSON object and nothing else:

```json
{"answer":"<your prose answer to the question>","claims":[{"id":"p1","text":"<your wording>","citations":["<citation>"]}],"uncertainties":[{"id":"extra:1","text":"<limitation you assert>","citations":["<citation>"]}]}
```

- `claims`: catalogue propositions you assert (their catalogue id) and your own factual claims (`extra:<n>`).
- `uncertainties`: unknown, partial, limited or unresolved points you assert, with a catalogue id or `extra:<n>`.

## Responses (1; families: decisions)

### ye_ast_compose (public-tool)

Request:

```json
{"queries":[{"name":"ye_ast_decisions","arguments":{"repo":"shop","revision":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c","repos":[{"path":"<fixture-root>/web","id":"web","revision":"3e69e9d3c2285375dd92629e23a8ef4487d2bb9e"}],"gateways":[{"prefix":"shop-api","repo":"shop"}],"offline":true}}],"mode":"full"}
```

Text channel:

```text
Composition full: 1 sources, 1 recorded reads (1 complete, 0 partial, 0 unknown), 0 unknown findings, 0 unknown components.
Tables: structuredContent.graph.sources (1), structuredContent.graph.snapshots (2), structuredContent.graph.reads (1), structuredContent.graph.files (0), structuredContent.graph.anchors (0), structuredContent.graph.evidence (0), structuredContent.graph.parts (3), structuredContent.graph.entities (0), structuredContent.graph.bindings (0), structuredContent.graph.relations (0), structuredContent.graph.connections (0).
structuredContent.coverage.issues (0), unknowns (0), limits (0); structuredContent.requests (1); structuredContent.delivery (1).
```

Structured channel:

```json
{"kind":"composition","compositionSchema":1,"mode":"full","verification":{"status":"available","identity":"mcp-c1:3c386bbd85ce5f0a952f65a4cdb23f76fa794e701392cbdd040aa83d508a134d"},"requests":[{"status":"available","query":{"name":"ye_ast_decisions","arguments":{"repo":"shop","revision":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c","offline":true,"repos":[{"path":"<fixture-root>/web","id":"web","revision":"3e69e9d3c2285375dd92629e23a8ef4487d2bb9e"}],"gateways":[{"prefix":"shop-api","repo":"shop"}]}},"strategy":"fresh-read"}],"graph":{"snapshots":[{"id":"v1:bf9ef89a0a9c9257ff33427e856b9f06d42718542e71a86829c5d686368bac51","value":{"repo":"shop","kind":"sha","sha":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c"},"identity":"exact"},{"id":"v1:c869d2d7e2fa0949bda4ad9c72bd5fe9ab5b48aa38cbb8594d37ddae2d6eb1d0","value":{"repo":"web","kind":"sha","sha":"3e69e9d3c2285375dd92629e23a8ef4487d2bb9e"},"identity":"exact"}],"sources":[{"family":"decisions","id":"s1:53a7935529dbf93fa2054266a98375831628dff999f26fbd2654639766cd105b","rootRead":"r1:e1ccd428e856d6f4213321bcce3792bf8533baf94f1311a8b497d1dabf83ce9e","snapshotVector":[{"repo":"shop","snapshot":"v1:bf9ef89a0a9c9257ff33427e856b9f06d42718542e71a86829c5d686368bac51"},{"repo":"web","snapshot":"v1:c869d2d7e2fa0949bda4ad9c72bd5fe9ab5b48aa38cbb8594d37ddae2d6eb1d0"}],"analysis":{"status":"complete"},"requestIndex":0}],"reads":[{"id":"r1:e1ccd428e856d6f4213321bcce3792bf8533baf94f1311a8b497d1dabf83ce9e","source":"s1:53a7935529dbf93fa2054266a98375831628dff999f26fbd2654639766cd105b","owner":{"kind":"fact"},"schema":"0.12.0","producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"05333f1b2750b5de88a162fe5dc43e3768cdbab9152854746ddcc714e5d22cde","config":"8cb0e2c77815376ead83c5454059002831d8c766ae6bfc7accf0c0e878a958c2","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"snapshot":"v1:bf9ef89a0a9c9257ff33427e856b9f06d42718542e71a86829c5d686368bac51","evidence":[],"analysis":{"status":"complete"}}],"files":[],"anchors":[],"evidence":[],"parts":[{"kind":"decision","context":"r1:e1ccd428e856d6f4213321bcce3792bf8533baf94f1311a8b497d1dabf83ce9e","decisionId":"trust:web","kindName":"trust","subject":"web","allowsFreeText":false,"required":true,"evidence":[],"options":[{"value":"trusted","evidence":[],"recommended":false},{"value":"untrusted","evidence":[],"recommended":false}],"id":"p1:476a07de8230ea78a84589f62fa3f757b8fdb9eb844f0199531af6d3afa335c7","supports":[{"source":"s1:53a7935529dbf93fa2054266a98375831628dff999f26fbd2654639766cd105b","read":"r1:e1ccd428e856d6f4213321bcce3792bf8533baf94f1311a8b497d1dabf83ce9e","pointer":"/value/decisions/1"}]},{"kind":"decision","context":"r1:e1ccd428e856d6f4213321bcce3792bf8533baf94f1311a8b497d1dabf83ce9e","decisionId":"trust:shop","kindName":"trust","subject":"shop","allowsFreeText":false,"required":true,"evidence":[],"options":[{"value":"trusted","evidence":[],"recommended":false},{"value":"untrusted","evidence":[],"recommended":false}],"id":"p1:8959c9828a78990fd7db7dfda5fce61c284633caef7fe8aafdce50d8b1bb4598","supports":[{"source":"s1:53a7935529dbf93fa2054266a98375831628dff999f26fbd2654639766cd105b","read":"r1:e1ccd428e856d6f4213321bcce3792bf8533baf94f1311a8b497d1dabf83ce9e","pointer":"/value/decisions/0"}]},{"kind":"workspace-context","context":{"family":"decisions","source":"request","repositories":[{"repo":"shop","snapshot":"v1:bf9ef89a0a9c9257ff33427e856b9f06d42718542e71a86829c5d686368bac51"},{"repo":"web","snapshot":"v1:c869d2d7e2fa0949bda4ad9c72bd5fe9ab5b48aa38cbb8594d37ddae2d6eb1d0"}]},"id":"p1:f4faffd8d96081a110fa95a482765929deb45fdc74a21252d314c7b104865e0e","supports":[{"source":"s1:53a7935529dbf93fa2054266a98375831628dff999f26fbd2654639766cd105b","read":"r1:e1ccd428e856d6f4213321bcce3792bf8533baf94f1311a8b497d1dabf83ce9e","pointer":"/value/repositories"},{"source":"s1:53a7935529dbf93fa2054266a98375831628dff999f26fbd2654639766cd105b","read":"r1:e1ccd428e856d6f4213321bcce3792bf8533baf94f1311a8b497d1dabf83ce9e","pointer":"/value/source"}]}],"entities":[],"bindings":[],"relations":[],"connections":[]},"coverage":{"reads":{"complete":1,"partial":0,"unknown":0},"unknowns":[],"limits":[],"issues":[]},"counts":{"sources":1,"reads":1,"files":0,"anchors":0,"entities":0,"evidence":0,"parts":3,"relations":0,"connections":0,"unknownFindings":0,"unknownComponents":0},"delivery":[{"source":"s1:53a7935529dbf93fa2054266a98375831628dff999f26fbd2654639766cd105b","repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"},{"repo":"web","path":"<fixture-root>/web"}]}]}
```
