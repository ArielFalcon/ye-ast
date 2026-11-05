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

Cite composed evidence by a full wire id that appears in the result JSON's `graph` tables (for example a `p1:…` part, `l1:…` relation, `c1:…` connection, `e1:…` evidence or `r1:…` read).
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
{"queries":[{"name":"ye_ast_decisions","arguments":{"repo":"shop","revision":"ece2918303f97235b271ef133b574de4984a4551","repos":[{"path":"<fixture-root>/web","id":"web","revision":"ba3965606c100bd15237938a02dab651206d05f1"}],"gateways":[{"prefix":"shop-api","repo":"shop"}],"offline":true}}],"mode":"full"}
```

Presentation:

```text
Composition full: 1 sources, 1 recorded reads (1 complete, 0 partial, 0 unknown), 0 unknown findings, 0 unknown components.
Tables: graph.sources (1), graph.snapshots (2), graph.reads (1), graph.files (0), graph.anchors (0), graph.evidence (0), graph.parts (3), graph.entities (0), graph.bindings (0), graph.relations (0), graph.connections (0).
coverage.issues (0), unknowns (0), limits (0); requests (1); delivery (1).
```

Result JSON:

```json
{"kind":"composition","compositionSchema":1,"mode":"full","verification":{"status":"available","identity":"mcp-c1:d853cd818db641400197f10d9205161748f2cb474a8d2618d13ddfbfc62bc8e7"},"requests":[{"status":"available","query":{"name":"ye_ast_decisions","arguments":{"repo":"shop","revision":"ece2918303f97235b271ef133b574de4984a4551","offline":true,"repos":[{"path":"<fixture-root>/web","id":"web","revision":"ba3965606c100bd15237938a02dab651206d05f1"}],"gateways":[{"prefix":"shop-api","repo":"shop"}]}},"strategy":"fresh-read"}],"graph":{"snapshots":[{"id":"v1:874965a285523ea26f21afdcba2b021224c6c5301f45ebee8140a7f59cd7d7a7","value":{"repo":"web","kind":"sha","sha":"ba3965606c100bd15237938a02dab651206d05f1"},"identity":"exact"},{"id":"v1:c9023c063c00b215461dfedc6f19a2e2f17116ae70a337aaab2257abceb6ea9b","value":{"repo":"shop","kind":"sha","sha":"ece2918303f97235b271ef133b574de4984a4551"},"identity":"exact"}],"sources":[{"family":"decisions","id":"s1:330aaff18db89c414dc785a64e41f0b495b0b21954c83643b695a1f9cbe49815","rootRead":"r1:c8851aea19d030d49d2dece3e83d63719b702dfeb3781ef8ce45d5c44079f22d","snapshotVector":[{"repo":"shop","snapshot":"v1:c9023c063c00b215461dfedc6f19a2e2f17116ae70a337aaab2257abceb6ea9b"},{"repo":"web","snapshot":"v1:874965a285523ea26f21afdcba2b021224c6c5301f45ebee8140a7f59cd7d7a7"}],"analysis":{"status":"complete"},"requestIndex":0}],"reads":[{"id":"r1:c8851aea19d030d49d2dece3e83d63719b702dfeb3781ef8ce45d5c44079f22d","source":"s1:330aaff18db89c414dc785a64e41f0b495b0b21954c83643b695a1f9cbe49815","owner":{"kind":"fact"},"schema":"0.15.0","producer":{"name":"ye-ast","version":"0.4.0"},"inputs":{"trust":"untrusted","scope":"fa4648f55a618e0296b4a7ce207508c12bbe7d7e682e4a5ac5a25787a8b96eb8","declaredScope":{"languages":["java","typescript"],"frameworks":["angular","spring"],"include":[],"exclude":[]},"content":"73719cc7f7c95a692093c766dc2c604ade399275e6624542d1154de18370d5ba","config":"eb37e1a119a10b1099dfc0625ccce789b2b486348ded29eb5240fde3b227ab87","declaredConfig":{},"engines":{"tree-sitter-java":"0.23.5","typescript":"6.0.3","web-tree-sitter":"0.27.1"}},"snapshot":"v1:c9023c063c00b215461dfedc6f19a2e2f17116ae70a337aaab2257abceb6ea9b","evidence":[],"analysis":{"status":"complete"}}],"files":[],"anchors":[],"evidence":[],"parts":[{"kind":"workspace-context","context":{"family":"decisions","source":"request","repositories":[{"repo":"shop","snapshot":"v1:c9023c063c00b215461dfedc6f19a2e2f17116ae70a337aaab2257abceb6ea9b"},{"repo":"web","snapshot":"v1:874965a285523ea26f21afdcba2b021224c6c5301f45ebee8140a7f59cd7d7a7"}]},"id":"p1:2f72b67f51147534d41698da6b88391f361148064ad276928d2d8ba391c5a1b9","supports":[{"source":"s1:330aaff18db89c414dc785a64e41f0b495b0b21954c83643b695a1f9cbe49815","read":"r1:c8851aea19d030d49d2dece3e83d63719b702dfeb3781ef8ce45d5c44079f22d","pointer":"/value/repositories"},{"source":"s1:330aaff18db89c414dc785a64e41f0b495b0b21954c83643b695a1f9cbe49815","read":"r1:c8851aea19d030d49d2dece3e83d63719b702dfeb3781ef8ce45d5c44079f22d","pointer":"/value/source"}]},{"kind":"decision","context":"r1:c8851aea19d030d49d2dece3e83d63719b702dfeb3781ef8ce45d5c44079f22d","decisionId":"trust:shop","kindName":"trust","subject":"shop","allowsFreeText":false,"required":true,"evidence":[],"options":[{"value":"trusted","evidence":[],"recommended":false},{"value":"untrusted","evidence":[],"recommended":false}],"id":"p1:ae59bc269d681863bdffdaeb4826207f480d61a4fe4fe7c348bc8e04e3c75acd","supports":[{"source":"s1:330aaff18db89c414dc785a64e41f0b495b0b21954c83643b695a1f9cbe49815","read":"r1:c8851aea19d030d49d2dece3e83d63719b702dfeb3781ef8ce45d5c44079f22d","pointer":"/value/decisions/0"}]},{"kind":"decision","context":"r1:c8851aea19d030d49d2dece3e83d63719b702dfeb3781ef8ce45d5c44079f22d","decisionId":"trust:web","kindName":"trust","subject":"web","allowsFreeText":false,"required":true,"evidence":[],"options":[{"value":"trusted","evidence":[],"recommended":false},{"value":"untrusted","evidence":[],"recommended":false}],"id":"p1:b6c0e023ed4e1334c2f8e942ee49de607deb5ab94ab49aa6acf832da69088d31","supports":[{"source":"s1:330aaff18db89c414dc785a64e41f0b495b0b21954c83643b695a1f9cbe49815","read":"r1:c8851aea19d030d49d2dece3e83d63719b702dfeb3781ef8ce45d5c44079f22d","pointer":"/value/decisions/1"}]}],"entities":[],"bindings":[],"relations":[],"connections":[]},"coverage":{"reads":{"complete":1,"partial":0,"unknown":0},"unknowns":[],"limits":[],"issues":[]},"counts":{"sources":1,"reads":1,"files":0,"anchors":0,"entities":0,"evidence":0,"parts":3,"relations":0,"connections":0,"unknownFindings":0,"unknownComponents":0},"delivery":[{"source":"s1:330aaff18db89c414dc785a64e41f0b495b0b21954c83643b695a1f9cbe49815","repositoryRoots":[{"repo":"shop","path":"<fixture-root>/shop"},{"repo":"web","path":"<fixture-root>/web"}]}]}
```
