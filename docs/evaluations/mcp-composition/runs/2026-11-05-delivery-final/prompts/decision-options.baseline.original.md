# ye-ast composition evaluation — decision-options / baseline / original

You receive evidence returned by a read-only code-analysis MCP server. Use only the responses below: no outside knowledge, no tools, no assumptions about code that is not shown.

## Question

Which configuration decisions are open, which options are available, and is any option recommended by the evidence?

## Proposition catalogue

Assert a proposition only when the responses support it; omit any proposition you reject or cannot support. You may add your own claims.

- p1: At least one decision lists its options exactly as reported, including whether each is recommended and whether free text is allowed.
- p2: An option not listed by the decisions response is available or recommended.
- p3: The decisions response recommends one of the listed options.

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

## Responses (1; families: decisions)

### q0 — ye_ast_decisions

Request:

```json
{"repo":"shop","revision":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c","repos":[{"path":"<fixture-root>/web","id":"web","revision":"3e69e9d3c2285375dd92629e23a8ef4487d2bb9e"}],"gateways":[{"prefix":"shop-api","repo":"shop"}],"offline":true,"mode":"full"}
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
{"schema":"0.12.0","snapshot":{"repo":"shop","kind":"sha","sha":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c"},"producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"05333f1b2750b5de88a162fe5dc43e3768cdbab9152854746ddcc714e5d22cde","config":"8cb0e2c77815376ead83c5454059002831d8c766ae6bfc7accf0c0e878a958c2","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"evidence":[],"status":"complete","value":{"decisions":[{"id":"trust:shop","kind":"trust","subject":"shop","evidence":[],"options":[{"value":"trusted","evidence":[],"recommended":false},{"value":"untrusted","evidence":[],"recommended":false}],"allowsFreeText":false,"required":true},{"id":"trust:web","kind":"trust","subject":"web","evidence":[],"options":[{"value":"trusted","evidence":[],"recommended":false},{"value":"untrusted","evidence":[],"recommended":false}],"allowsFreeText":false,"required":true}],"repositories":[{"repo":"shop","snapshot":{"repo":"shop","kind":"sha","sha":"59b76e9aa54fe237d02cba8200a7bb93ca11c30c"}},{"repo":"web","snapshot":{"repo":"web","kind":"sha","sha":"3e69e9d3c2285375dd92629e23a8ef4487d2bb9e"}}],"source":"request"},"mode":"full","repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"},{"repo":"web","path":"<fixture-root>/web"}]}
```
