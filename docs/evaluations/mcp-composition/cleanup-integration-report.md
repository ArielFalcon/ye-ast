# Composición transversal MCP: limpieza e integración con main

Status: **completed**. Cleanup, commits, conflict resolution and the merge into local `main` are complete.
The initial blocked state below is retained as history; the follow-up records how the pending changes were
preserved in commits and integrated after the owner authorized it. Nothing was pushed.

## Alcance

- Skill aplicada: `.claude/skills/code-cleanup/SKILL.md` y `references/cleanup-bar.md` del checkout principal, con
  `AGENTS.md` como fuente de arquitectura.
- Incluido: todo el trabajo de la sesión sobre `t3/common-mcp-response-modes-steps-1-3`. La rama ya era ancestro de
  `main` (HEAD original `98b9cc5`, 0 commits por delante), así que el trabajo pendiente era solo el WIP sin commit:
  `ye_ast_compose`, runner semántico compartido, normalización tipada, unión canónica, esquemas, renderer compacto,
  evaluador, corpus, informes, runs crudos y el plan.
- Excluido: áreas ajenas del proyecto. El WIP del checkout de `main` no se leyó para modificarlo ni se tocó.

## Reutilizado

- `RESULT_JSON_LABEL` y `delivered()` de main para la entrega de `ye_ast_compose` y del evaluador; `resultFields()` de
  `test-session.ts` en los tests.
- Validación local por esquema antes de entregar (patrón `emit` de main), aplicada desde el runner compartido con un
  único mapa `OUTPUTS` por familia y con `COMPOSE_OUTPUT` para la composición.
- El tipo de parte existente `unresolved-call-site` para los sitios no resueltos de las secciones de workspace impact.
- `RecordedCollectionState` para `changedContracts`, con un único helper `collectionState()` que también usa importers.
- El helper existente `handler()` del adaptador de impact para anclar los handlers de contratos cambiados.
- El guard de compilación `Accepts` se deja en un único sitio (`composition-schema-parts.ts`).

## Cambios de limpieza (antes del merge)

- Eliminados banners de sección `// ----` sin precedente en el proyecto; se conservan solo las frases que describen un
  invariante.
- Eliminadas referencias a secciones del plan (`plan §…`, `§5.2`, …) en comentarios: eran historia de decisión.
- Eliminado código sin consumidores: `compareIds`, `IssueKind`, la reexportación `escapePointer` de
  `composition-identity.ts` y el `Accepts` duplicado.
- Corregidos una línea en blanco final y una línea doble en tests.

## Integración con main: conflictos y resolución

`main` aportó 14 commits; el semántico relevante es `7da3722` (entrega única por texto, sin `structuredContent` ni
`outputSchema`, presupuesto de catálogo de 32 KB) más los hechos nuevos de contratos y call sites.

- `src/mcp/server.ts`: se conserva la estructura de la feature (runner compartido) y se aplica la entrega de main en
  `respond()` (selección, full y receipt validados antes de entregar) y en `failure()` (línea `fault fields:` más la
  causa de `composition-source-fault`). `ye_ast_compose` entrega su receipt o la composición completa en la línea
  `result JSON:` tras `COMPOSE_OUTPUT.parse`, sin `outputSchema`.
- `composition-schema.ts`: eliminados `composeOutputGuide` y `compactComposeOutput`, que quedaban sin uso al no
  anunciarse esquemas de salida; su test se elimina (la integridad de referencias sigue cubierta por otro test).
- `compact-schema.test.ts`: se mantiene el presupuesto de 32.000 bytes de main para las siete familias, cero esquemas
  de salida para todas, y un tope propio de 40 KB para el input de `ye_ast_compose`.
- **Conflicto semántico sin marcadores**: tras el merge, la composición descartaba en silencio tres hechos públicos
  nuevos de main. Resuelto en el normalizador, no en el texto:
  - `ImpactValue.changedContracts` → nueva parte `contract-change` (documento, línea, lados de datos cambiados,
    handlers anclados en el lado que declara la operación) y estado de colección en `impact-context`.
  - `RepoImpact.unresolved` → partes `unresolved-call-site` existentes.
  - `ImpactedLink.operations` → campo de la parte `workspace-link` y texto en la atestación de su relación, con la
    advertencia de que una llamada no prueba que se lean los datos cambiados.
  - RED observado antes del cambio: la reconstrucción del hecho público desde las tablas fallaba
    (`Cannot read properties of undefined (reading 'state')`).
- Tests y evaluador leen la línea `result JSON:`; el evaluador mide el bloque entregado completo.
- Los tests de tamaño leían el run histórico `2026-11-05-semantic-final` (formato de dos canales). No se alteró: se
  preparó un run nuevo `runs/2026-11-05-integrated` sobre el árbol integrado y los tests apuntan a él.
- Docs: `mcp-schema-compaction.md` conserva el texto de main y añade una sección de composición con medidas nuevas;
  RFC-0005, README y el README de la evaluación describen la entrega única.

## Sin tocar (deliberado)

- `sortedUnique` de composición no se sustituye por el de `core/domain/impact`: el de impact es de un único
  subdominio y perdería el tipado genérico.
- Comentarios de contrato restantes: describen invariantes o la API transversal.
- `implementation-report.md` y los runs anteriores quedan como historia; sus medidas son del contrato de dos canales.
- README: las secciones de las siete herramientas originales siguen nombrando `structuredContent`
  (líneas ~303, 346, 352, 361). Es deuda previa de `main` tras `7da3722`, fuera de este alcance.
- Instrucciones del servidor: 3.760 caracteres (presupuesto de la feature 3.900; main tenía 3.400 sin composición).

## Verificación (Node 24.22.2, `.nvmrc`)

| Comando | Árbol | Resultado |
|---|---|---|
| `npm run check` | WIP limpiado, antes del merge | 2.367 pruebas, 2.367 pasan, 0 fallos/cancelados/skips/todo |
| `node --import tsx --test scripts/evaluate-mcp-composition.test.ts` | antes del merge | 23/23 pasan |
| `npm run build` | antes del merge | exit 0 |
| `git diff --check`, `git diff --cached --check` | antes del merge | sin errores |
| `npm run check` | merge `a2e8906` | 2.398 pruebas, 2.398 pasan, 0 fallos/cancelados/skips/todo |
| `node --import tsx --test scripts/evaluate-mcp-composition.test.ts` | merge `a2e8906` | 23/23 pasan |
| `npm run build` | merge `a2e8906` | exit 0 |
| `git diff --cached --check` | merge `a2e8906` | sin errores |

`d5f66d6` solo añade un documento de `docs/superpowers/specs/`; no se repitió la suite completa sobre ese árbol. Un
primer intento de `npm run check` arrancó con Node 26 por error y se detuvo; no cuenta como evidencia.

Logs: `/tmp/ye-ast-cleanup-YYUj/check-pre-merge.log`, `/tmp/ye-ast-cleanup-YYUj/check-merged.log`.

## Medidas del run integrado

Bloque entregado completo (presentación más línea `result JSON:`), UTF-8, details, mismas consultas. No son tokens.

| Caso | Herramientas separadas | Composición |
|---|---:|---:|
| handler-outline | 1.676 | 1.532 |
| change-duplicate-dependence | 8.946 | 4.481 |
| seven-families | 13.132 | 8.246 |

Catálogo: 8 operaciones, 53.335 bytes; `ye_ast_compose` 22.054 bytes. El orden de consultas sigue siendo invariante en
los ocho casos. El run nuevo no tiene respuestas de consumidores: no hay evaluación LLM nueva.

## Commits

| Hash | Mensaje |
|---|---|
| `54043f8` | feat(mcp): compose evidence from the seven query families |
| `6374aeb` | test(mcp): evaluate composition against the original tools over one closed corpus |
| `1100eba` | docs(evaluations): keep the raw composition evaluation runs |
| `13d8798` | docs(plans): record composition delivery, ownership and collection-state outcomes |
| `a2e8906` | merge: integrate main's single content delivery and contract changes with composition |
| `d5f66d6` | merge: bring in the scoped proof uncertainty design from main |

Este informe va en un commit posterior de docs. `1100eba` añade unos 6,6 MB de runs crudos bajo `docs/`, que GitHub
Pages publica: está aislado para poder descartarlo antes de un push si no deben publicarse.

## Estado de ramas

- Feature `t3/common-mcp-response-modes-steps-1-3`: contiene `main` completo (`a9bd5d5`) más el trabajo de la sesión.
- `main` local: `a9bd5d5`, sin cambios por mi parte. Avanzó durante la tarea (de `0f66550` a `a9bd5d5`, solo docs),
  y ese commit también está integrado en la feature.
- Sin push, sin PR, sin cambios de dependencias.

## Bloqueo para el avance de main

`main` es ancestro de la feature, así que un fast-forward es posible a nivel de refs, pero el checkout
`/Users/arielyumn/Desktop/TRABAJO/ye-ast` tiene WIP ajeno en `src/mcp/server.ts` y `src/mcp/server.test.ts`, dos de los
archivos que cambia el merge. `git merge --ff-only` se negaría, y mover la ref sin el árbol dejaría ese WIP como un
diff invertido. Además, ese WIP añade una comprobación de selección redactada dentro de `answer()`, que en la feature
tiene otra forma: hay que adaptarlo a mano.

Acción necesaria: el dueño de ese WIP lo commitea o lo aparta, y entonces
`git -C /Users/arielyumn/Desktop/TRABAJO/ye-ast merge --ff-only t3/common-mcp-response-modes-steps-1-3`; si su WIP ya
está commiteado en `main`, primero se integra en la feature y se adapta su guard al `answer()` del runner compartido.

WIP ajeno preservado: el `git diff` del checkout de main tiene el mismo SHA-1 al inicio y al final
(`d3aad895e02844746a5671b47b58ea7b70ef96fa`), con los mismos cinco archivos modificados.

## Límites

- Los tests muestran que no hay regresiones en lo que cubren; no prueban que no haya ninguna.
- El piloto de consumidores sigue siendo limitado e histórico; no hay evaluación LLM completa.
- La composición sigue reejecutando consultas y no garantiza menor latencia ni un instante atómico del workspace.


## Follow-up: preserving the inactive main changes

The owner explicitly authorized reviewing the pending main changes, committing them and completing the merge.
At 21:20 CET all five files still had their last modification at 20:14 CET (about 67 minutes earlier), and their
patch was unchanged from the cleanup review. The only other active project worker used its own worktree and did not
own these files in the main checkout.

The original pending diff was saved outside the repository as
`/tmp/ye-ast-main-wip-before-integration.patch`. It was committed without edits in two behavior units:

- `8858518`: refuse a held live capture if HEAD changed while acquiring it; keep lease cleanup and its regression test.
- `5d9722b`: reject redacted selection coordinates before dispatch or reflection, in all public modes.

A byte comparison between the saved patch and `git diff --binary a9bd5d5..5d9722b` was identical.
SHA-256: `6c079654324b5dd178bbfdf8f664d087b291189a6cc35d231b1b9406a4b7baaa`.

The integration into the composition branch conflicted only in the server imports. The shared query runner remains
the dispatch owner; the selection guard remains in the server before cursor processing and dispatch, with the
canonical JSON import it requires. No original pending change was discarded or replaced by a parallel mechanism.

The original checkout tests passed 206/206. The integrated focused suite passed 207/207. Both commands used
Node 24.22.2 and the live-captures, workspace-snapshots and MCP server test files.


### Final integration and verification

The integrated source tree was committed as `d333e79`. Local main advanced from `5d9722b` to `d333e79` with
`git merge --ff-only t3/common-mcp-response-modes-steps-1-3`. No stash, reset, forced branch update or push was used.
The only subsequent change is this completion report.

Observed verification on that source tree, using Node 24.22.2:

- `npm run check`: 2,400 passed; zero failures, cancellations, skips or todos. Typecheck and architecture passed
  (417 modules and 2,477 dependencies).
- `node --import tsx --test scripts/evaluate-mcp-composition.test.ts`: 23 passed, zero failures.
- `npm run build`: exit 0.
- `git diff --check` and `git diff --cached --check`: clean.

Logs: `/tmp/ye-ast-main-integration-check.log`, `/tmp/ye-ast-main-integration-evaluator.log`,
`/tmp/ye-ast-main-integration-build.log` and `/tmp/ye-ast-final-guards-focused.log`.

The previous main WIP blocker is resolved. The bounded LLM evaluation and the full-output size caveats described
above remain unchanged. Verification establishes the covered behavior, not a guarantee against all regressions.
