# ye-ast composition evaluation — no-overlap / baseline / reversed

You receive evidence returned by a read-only code-analysis MCP server. Use only the responses below: no outside knowledge, no tools, no assumptions about code that is not shown.

## Question

Summarize the file consumers and the open configuration decisions.

## Proposition catalogue

Assert a proposition only when the responses support it; omit any proposition you reject or cannot support. You may add your own claims.

- p1: File consumers and configuration decisions are reported as independent findings with no relation between them.
- p2: A configuration decision is caused by, or determines, a file import.

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

## Responses (2; families: importers, decisions)

### q1 — ye_ast_decisions

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

### q0 — ye_ast_importers

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
