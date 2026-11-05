# Composición transversal de evidencia MCP — plan de implementación

> **Para agentes implementadores:** usar `superpowers:executing-plans` para ejecutar este documento tarea por tarea; `superpowers:subagent-driven-development` solo cuando la sesión de implementación autorice delegar. Los pasos usan casillas de verificación. Este encargo entrega diseño y planificación: no autoriza implementar, instalar, hacer commit ni publicar.

**Objetivo:** entregar una respuesta conjunta donde una declaración, una relación o una evidencia idéntica tenga una representación compartida, conservando los soportes y los límites que permiten a un agente formular conclusiones verificables.

**Arquitectura:** añadir `ye_ast_compose`, una operación MCP acotada que recibe consultas tipadas de las siete familias, ejecuta sus puertos existentes y normaliza sus hechos públicos durante la llamada. Una unión pura conserva las observaciones; una materialización determinista identifica coincidencias demostrables y construye conexiones limitadas. La presentación comparte contexto y referencias sin almacenar resultados entre llamadas.

**Tecnología:** TypeScript 6.0.3, Node 24.22.2 (`.nvmrc`), Zod 4.6.7, MCP SDK 2.4.0, `node:test`, `tsx`, `canonicalJson`, `Digest` y redacción existentes. Ninguna dependencia nueva.

**Especificación:** el contrato normativo está integrado en las secciones 3–10 de este mismo documento. No se requiere una especificación compañera inexistente. Los documentos anteriores citados en la sección 2 conservan la autoridad sobre las consultas originales.

**Estado:** plan terminado, pendiente de implementación. Las decisiones de este documento son recomendaciones cerradas del diseñador dentro del encargo de planificación; no se presentan como funcionalidades existentes ni como aprobación de un cambio de producto ya desplegado.

## 1. Comportamiento que se construirá

Un consumidor podrá enviar `entrypoints` y `outline` sobre el mismo repositorio y snapshot. Si las coordenadas del handler identifican de forma única una declaración del outline, verá una sola declaración con su asociación a la ruta y su ubicación. Si añade `impact` y `callers`, una dependencia registrada entre declaraciones aparecerá una vez, con todos sus soportes compatibles. La respuesta conservará por separado la selección de cambios, la procedencia de cada recorrido y los cortes que limitan sus conclusiones.

La composición no necesita una implementación por pareja o triple. Cada familia transforma su propio contrato en partes tipadas; la operación común reconoce identidades y relaciones explícitas. Algunas combinaciones solo comparten evidencia o muestran información independiente. No se exige que cualquier combinación produzca una conclusión nueva.

### Objetivos y exclusiones

| Construir | Conservar fuera de alcance |
|---|---|
| Identificación tipada de las partes significativas de las siete familias, incluidos sus estados y propietarios | Interpretar encabezados, texto de presentación, regex sobre nombres o similitud de rutas para descubrir significado |
| Unión de evidencia, deduplicación exacta y conexiones demostrables con referencias verificables | Un motor nuevo de análisis, un grafo completo de código, inferencia abierta o puntuación de seguridad de cambios |
| Invocación pública concreta, sin objetos gigantes reenviados por el cliente | Almacén de resultados finales, handles, lenguaje de pipelines, plugins o workflows configurables |
| Respuesta autosuficiente y compacta para agentes, con versiones y límites explícitos | Leer código fuente mediante outline; deduplicar snippets inexistentes; prometer recuperación de un estado live antiguo |
| Medir repetición, coste completo y calidad de conclusiones | Declarar optimalidad universal, ahorro de tokens no medido o prosa LLM idéntica entre ejecuciones |

### Restricciones globales

- Los identificadores de código incluyen `SnapshotRef` completo: `repo + sha`, o `repo + head + stateId` para live. SHA y live nunca son equivalentes por compartir `head`.
- La disponibilidad en el catálogo no concede confianza, pertenencia al workspace ni autorización de remotos. Las consultas conservan sus comprobaciones actuales.
- `scope`, `changed`, `targets`, budgets, membresía, configuración, versiones, frescura y redacción no se convierten en detalles prescindibles de formato.
- Una ausencia desconocida nunca produce una colección conocida vacía. La cobertura parcial y sus cortes sobreviven a cualquier unión.
- `full` de una herramienta original conserva su hecho completo. Esta operación nueva entrega una composición explícita, no un `Fact<T>` supuestamente equivalente a todos los hechos.
- Solo los datos públicos, después del filtrado y la redacción actuales, pueden salir por MCP. No se publican `repositorySources` ni `WorkspaceValue.repositories`.
- El trabajo de implementación respetará las modificaciones concurrentes y las reglas de capas de `.dependency-cruiser.cjs`. No se añaden dependencias ni se modifica el análisis para facilitar la composición.

### Focos de revisión

1. Un mismo archivo relativo en dos repositorios o dos snapshots no debe producir una identidad compartida. Pruebas en T3 y T6.
2. Un nombre `via` sin declaración única, dos overloads o dos declaraciones indistinguibles en una línea deben quedar sin resolver. Pruebas en T3.
3. Un importador, un usuario de archivo o una asociación a origen no debe convertirse en una llamada ni en una rotura. Pruebas en T2, T3 y T7.
4. Dos recomendaciones de configuración con contexto distinto, o evidencia de `.git/config`, no deben atribuirse automáticamente al commit ni consolidarse por `Decision.id`. Pruebas en T2, T3 y T6.
5. Redacción, deadline, cancelación o cambio live no deben permitir referencias falsas, replay aparente o resultados truncados presentados como completos. Pruebas en T4–T6.

## 2. Arquitectura observada y evidencia de partida

### 2.1 Lectura y frescura

La exploración utilizó el proyecto indexado `Users-arielyumn-.t3-worktrees-ye-ast-t3-f0c80fb3`, `search_graph`, `get_code_snippet` y búsquedas estructurales. El índice existía; no se reindexó ni se creó un artefacto del grafo. Se comparó el snippet completo de `createMcpServer` con las líneas actuales 493–888: igualdad exacta, 27.170 caracteres. Las lecturas de archivos actuales prevalecen sobre el índice y los estados históricos de documentos.

El checkout compartido avanzó durante el análisis: de `b17e4ca37e82de1a0c27303f98d9914a6d8faca7` a `fe153d5110b65bac1ecca280949c1bc905f069e5`. Había además modificaciones de análisis/resolución de llamadas de otro trabajo. Las líneas de este plan son ayudas de navegación; los símbolos y contratos son la referencia estable. Antes de T1 hay que comprobar nuevamente HEAD y el diff, sin revertir trabajo ajeno.

No se encontró un `AGENTS.md` físico en el checkout ni en los ancestros comprobados; se aplicaron las instrucciones proporcionadas con el encargo. La ruta `.claude/skills/ye-ast-testing/SKILL.md` citada por planes antiguos no existía en la inspección. Las pruebas y criterios necesarios están definidos aquí. Engram no estaba expuesto entre las herramientas disponibles; no se afirma haber guardado memoria.

### 2.2 Propietarios reales

| Propietario actual | Observado | Consecuencia para este diseño |
|---|---|---|
| `src/mcp/server.ts`: `createMcpServer`, `answer`, `outputFor`, `withSelections`, `ENTRYPOINTS_OUTPUT`…`DECISIONS_OUTPUT` | Registra siete herramientas; resuelve catálogo, llama puertos, filtra workspace, redacta, construye recovery, selecciona/pagina y presenta. Los esquemas públicos originales se definen aquí, no en un supuesto `output-schema.ts` existente | Extraer el despacho y los contratos de entrada con pruebas de paridad; el compositor no se llamará a sí mismo por MCP ni analizará `CallToolResult.content` |
| `src/mcp/presentation.ts`, `render.ts`, `render-evidence.ts` | `ResponseMode`, `ToolFamily`, `ResponseRenderer`; renderizadores de hechos y proyecciones | Añadir un renderizador de composición separado; no cambiar el significado de los modos originales |
| `presentation-context.ts`, `presentation-sharing.ts`, `presentation-guidance.ts` | Contexto, igualdad exacta de bloques, selección literal y recovery compartidos | Reutilizar `shareExactContext`, `preferShorterText`, `blockBytes` y las reglas de navegación cuando proceda |
| `src/mcp/recovery.ts` | `entrypointRecovery`, `callersRecovery`, `impactRecovery`; `mcp-r1` usa hecho público completo y contexto normalizado. `hasDeadline` desactiva replay estable | Mantener sus identidades; no sustituirlas por IDs de entidades o de composición |
| `select-evidence.ts`, `evidence-schema.ts`, `evidence-cursor.ts` | Unión cerrada de cinco categorías, fuentes entrypoints/local/workspace, `SourceSummary`, owners e índices públicos; cursor vinculado a identidad, selector y límite | Una página no es una fuente completa para componer. La composición conserva las coordenadas necesarias para volver a estas herramientas |
| `src/mcp/compact-schema.ts` | `compactInput` omite condiciones de raíz al publicar; `compactOutput` publica una guía deliberadamente aproximada y conserva el validador original | La guía de descubrimiento no puede validar el modelo de composición. Se requieren esquemas runtime completos y pruebas del canal real |
| `repository-targeting.ts`: `repositoryCatalog` | Catálogo copiado al arrancar, IDs exactos, fallos sin fallback | Mismo catálogo y misma resolución por consulta del lote |
| `src/core/domain/shared/fact.ts` | `SCHEMA = "0.12.0"`, `Fact`, `Finding`, `FactProvenance`, `SnapshotRef`, `Evidence`, `Cut`, `FactInputs`, `sameIdentity` | Reutilizar los contratos; `sameIdentity` no compara valor/status y no es identidad suficiente de respuesta |
| `src/core/domain/shared/code-node.ts`: `joinsFact` | Une archivo exacto, línea contenida en span y nombre simple exacto si se proporciona | Es la única regla existente reutilizable para unir un handler a una declaración; exigir unicidad adicional, sin aproximación de nombres |
| `outline/outline.ts`: `readOutline`; `outline-queries.port.ts` | Proyecta `GraphSymbol` a `{kind,name,line,endLine}` y descarta `id`; imports son archivos relativos. No abre ni devuelve código fuente | La identidad pública es conservadora; no se presupone que se dispone de `GraphNodeId` ni de snippets |
| `impact-fact.ts`, `module-dependency.ts`, `changed-entrypoints.ts`, `importers-fact.ts` | Coordenadas, `DependenceBasis`, `via`, índices de semillas/orígenes, lados base/head y relaciones de archivos distintas | No homogeneizar todo como `calls`; no perder los índices de asociación al normalizar |
| `workspace-impact-queries.port.ts`: `RepoImpact`, `WorkspaceImpactValue`; `topology/link.ts`: `Link`, `ImpactedLink` | Workspace impact/callers ya une y recorre dominio; `reads` conserva provenance, `reach` conserva orden y `Link.id` no contiene snapshots | Reutilizar resultados de ese trabajo. Un `Link.id` necesita el vector de snapshots/contexto para deduplicación transversal |
| `workspace-queries.port.ts`, `workspace-repos.port.ts` | `FactRead`, `WorkspaceReplayContext`, snapshots, raíces públicas, fuentes privadas, membresía y sidecars | Conservar todos los propietarios y distinguir identidad determinista de observaciones de frescura |
| `decision-queries.port.ts`, `decisions/decision.ts`, `decisions/decision-queries.ts` | `DecisionsRequest` excluye replay; `buildDecisions` lee membresía confirmada, origins y resoluciones. Las opciones incluyen basis/recommended, no son solo strings | No ampliar silenciosamente el replay de decisions. `.git/config` puede ser evidencia de contexto externo, no del árbol del commit |
| `src/composition/compose.ts`: `composeQueries`, `ComposedQueries` | Inyecta los puertos, cachés de snapshots/índice, extracción y captura; no es un combinador de respuestas MCP | No añadir un motor paralelo aquí. MCP puede usar los mismos puertos ya inyectados sin importar application/adapters |

`DeclarationEvidenceReader` valida nombres propuestos por un diff; no es un buscador general de declaraciones. No se utilizará para resolver artificialmente la identidad que falta en respuestas públicas.

### 2.3 Decisiones anteriores que se conservan

Se leyeron el [plan de modos](2026-11-04-common-mcp-response-modes.md), en particular sus semánticas de composición y selección; el [plan de capacidades](2026-11-04-mcp-capabilities-implementation.md); los diseños de [targeting](../specs/2026-11-04-mcp-typed-follow-ups-design.md) y [recovery](../specs/2026-11-04-mcp-selective-evidence-recovery-design.md); [ADR-0022](../../architecture/adr/0022-typed-query-replay-and-selective-evidence.md); [RFC-0005](../../architecture/rfc/0005-transports.md), [RFC-0015](../../architecture/rfc/0015-answer-coordinates.md) y la [guía de compacción](../../mcp-schema-compaction.md).

Estas fuentes excluyen pipelines genéricos y retención de hechos finales, distinguen selección de cobertura, y mantienen el replay como nueva ejecución verificada. Este plan **añade explícitamente una operación de composición**, fuera del alcance de la antigua migración de modos; no reinterpreta esa migración como autorización previa de una herramienta nueva. Conserva sus siete APIs y no añade un almacén ni replay a decisions.

### 2.4 Auditorías anteriores: alcance, no prueba universal

Los informes `/tmp/ye-ast-mcp-{contract,local,workspace}-composition-report.md` son evidencia de otros auditores. El local ejercitó cinco familias y veinte pares ordenados A,B,A en una sesión caliente, con transferencias concretas. El de workspace ejercitó stdio, algunas parejas/triples y replay después de llamadas ajenas. Ninguno evaluó una síntesis LLM de las siete familias, todas las sesiones frías, un triple dependiente completo ni todas las opciones de decisions.

El encargo informa de una ejecución posterior del lead de 13 pruebas y typecheck. No fue ejecutada por este diseñador y no se usa como validación del código actual. Las pruebas observadas en los informes no demostraron contradicciones en sus fixtures; tampoco demostraron composición óptima general. T6 y T7 cubren precisamente esas lagunas.

## 3. Decisión de integración pública

### 3.1 Alternativas mínimas

| Alternativa | Ventaja | Coste/límite | Decisión |
|---|---|---|---|
| Biblioteca pura que el consumidor aplica a siete respuestas `full` | Sin herramienta nueva | Obliga a cada consumidor a implementar integración y a recibir primero todos los cuerpos; por sí sola no satisface una invocación MCP utilizable | Mantener la unión como función interna, no como única entrega |
| `compose` recibe hechos/respuestas devueltos antes | Evita repetir análisis | Entradas enormes y no confiables; requiere validación exhaustiva de procedencia o una falsa autoridad de hechos suministrados por el agente | Rechazada |
| IDs de resultados retenidos en el servidor | Entradas pequeñas | Nuevo ciclo de vida, memoria/expiración, dependencia de sesión y contradicción con ADR-0022 sin necesidad demostrada | Rechazada |
| `ye_ast_compose` recibe consultas tipadas y vuelve a ejecutarlas | Usa puertos y autoridad existentes; no recibe hechos; funciona en sesión fría; controla el resultado conjunto | Más análisis y latencia; no resuelve dependencias de coordenadas ni recupera estados live pasados | **Elegida** |
| Pipelines con variables, planificación automática o llamadas arbitrarias | Ejecutaría descubrimiento y seguimiento de una vez | Complejidad y superficie innecesarias; combina adquisición con inferencia | Rechazada |

La operación no es un JSON-RPC batch genérico. Acepta exclusivamente la unión cerrada de estas siete familias, sin recursión a `ye_ast_compose`, código, HTTP, JSONPath, transformaciones ni variables entre pasos. El servidor coordina la ejecución independiente del lote; el consumidor coordina los pasos que necesitan coordenadas obtenidas antes.

### 3.2 Contrato de entrada

Extraer a `src/mcp/query-schema.ts` los esquemas actuales y exportar sus tipos inferidos. `SemanticArguments<F>` significa los argumentos exactos de la familia F **sin** `mode`, `select`, `page` ni `expect`. Conserva `replay` únicamente donde ya existe: impact/callers con workspace. No se redefine un diccionario de argumentos sin validar.

```ts
type QueryName =
  | "ye_ast_entrypoints" | "ye_ast_impact" | "ye_ast_callers"
  | "ye_ast_importers" | "ye_ast_outline" | "ye_ast_workspace"
  | "ye_ast_decisions";

type SemanticQuery = {
  [F in ToolFamily]: {
    name: `ye_ast_${F}`;
    arguments: SemanticArguments<F>;
  }
}[ToolFamily];

// expect se admite solo en las tres familias que ya tienen Recovery.
type ComposeQuery = SemanticQuery & (
  | { name: "ye_ast_entrypoints" | "ye_ast_impact" | "ye_ast_callers";
      expect?: `mcp-r1:${string}` }
  | { name: "ye_ast_importers" | "ye_ast_outline" | "ye_ast_workspace"
      | "ye_ast_decisions"; expect?: never }
);

type ComposeInput = {
  queries: readonly ComposeQuery[];
  mode?: ResponseMode;             // default summary
  expect?: `mcp-c1:${string}`;      // verifica la composición completa
  deadlineMs?: number;             // entero 1..2147483647, sin default
};
```

`SemanticArguments<F>` se implementa como mapa de `z.infer` de siete esquemas semánticos exportados; los esquemas completos actuales se construyen con esos mismos campos más sus controles. No usar `Omit` de una unión que elimine accidentalmente campos de ramas ni perder refinamientos al usar `.shape`. Los refinamientos compartidos se aplican a ambos esquemas desde funciones existentes o extraídas. Los esquemas de `ComposeQuery` son objetos estrictos especializados por `name`; el refinamiento real sigue siendo obligatorio aunque la guía publicada sea aproximada.

Ejemplo ejecutable cuando se implemente la herramienta; los SHAs son valores ilustrativos completos:

```json
{
  "queries": [
    {"name":"ye_ast_entrypoints","arguments":{"repo":"shop","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},
    {"name":"ye_ast_outline","arguments":{"repo":"shop","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","files":["src/OrderController.java"]}},
    {"name":"ye_ast_callers","arguments":{"repo":"shop","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","targets":[{"file":"src/OrderService.java","symbol":"OrderService.find"}]}}
  ],
  "mode":"details"
}
```

Un agente que aún no conoce el archivo del handler consulta primero entrypoints, toma su owner/snapshot/coordenadas y después construye el lote. Puede incorporar su receta de recovery con `expect`. No se promete que outline del ejemplo sea necesario cuando el agente ya conoce el span; tampoco que volver a ejecutar sea siempre más barato que usar las respuestas disponibles.

### 3.3 Ejecución, autoridad y límites

1. Validar el objeto completo, sus límites y cada consulta antes de ejecutar ninguna. Resolver los IDs primarios en `repositoryCatalog`; validar estructuras workspace actuales. Los permisos de membresía/remotos siguen perteneciendo al core y se comprueban al ejecutar cada consulta.
2. Deduplicar consultas semánticas exactamente iguales antes de despacharlas. Excluir presentación y assertions de la clave. Si se repite una consulta con un `expect` y sin él, conservar la assertion; dos assertions diferentes son `composition-conflicting-expectations` antes del análisis.
3. Ordenar consultas únicas por `canonicalJson([name, semanticArguments])`, usando `compareText`. Ejecutarlas **secuencialmente**, sin fan-out ni retención de locks entre consultas. No se añade una captura común a todo el lote: cada operación de dominio mantiene su captura consistente y puede devolver un snapshot distinto.
4. Usar el mismo `AbortSignal` enlazado a `ctx.mcpReq.signal` y, si se pide, al deadline del lote. Comprobarlo antes de cada despacho y entre etapas. Ceder al event loop entre fuentes y antes de materializar/entregar; comprobar también el tiempo monotónico transcurrido antes de entregar aunque un bloque síncrono haya retrasado el timer. Liberar timer/listeners con `finally`; los puertos conservan su limpieza de recursos. No se promete preempción de CPU síncrona ni deadline de tiempo real, ni se usa el deadline como criterio de ranking.
5. Tras cada lectura, aplicar el filtrado público/redacción y las comprobaciones de identidad originales. Normalizarla; descartar el cuerpo original cuando ya se hayan extraído sus partes y su fingerprint. No conservarlo después de la llamada.
6. Unir, materializar, validar referencias, comprobar `expect` compuesto y renderizar. Toda entrega es posterior a la verificación. Una mutación live entre consultas produce snapshots separados e incompatibilidad visible, no sustitución silenciosa.

El lote no eleva autoridad: `repo` sigue siendo un ID declarado y los miembros workspace explícitos conservan exactamente su semántica actual de paths, trust y remotos. Un candidato descubierto no se añade al catálogo ni a otra consulta automáticamente. `offline` se conserva por consulta; no se inventa un default global que cambie decisions o refrescos.

**Límites de la operación nueva:** `1..16` consultas suministradas, antes de deduplicarlas; máximo `1.048.576` bytes UTF-8 de `canonicalJson(input)`. El primer límite permite dos consultas por familia más dos comparaciones concretas y evita fan-out arbitrario; el segundo acota el transporte de argumentos, no la cantidad de evidencia ni tokens. Son límites operativos de versión 1, no umbrales de utilidad derivados de mediciones. Se describen y prueban en descubrimiento. No se crea un parámetro de configuración ni una dependencia para ellos.

No se impone en esta versión un tope nuevo de bytes de salida ni un top-N silencioso: las herramientas existentes tampoco lo garantizan. El resultado puede ser grande si las preguntas lo son; el coste es proporcional a los hechos solicitados y a su soporte. Se procesa una fuente a la vez para no retener simultáneamente los siete cuerpos más su copia normalizada. T7 medirá pico de memoria/tamaño y registrará cuándo esta decisión necesite reconsiderarse. Una futura cota de salida deberá fallar explícitamente o definir una proyección recuperable; no podrá recortar el grafo y llamarlo completo.

### 3.4 Fallos y lecturas desconocidas

El resultado compuesto se entrega solo si todas las consultas terminaron como hechos válidos. Un error de una consulta aborta el lote y usa `isError`, texto redactado y `_meta["ye-ast/fault"]`; no se emite una composición parcial de los éxitos anteriores. Esto evita añadir una segunda API de batch con resultados/errores mezclados. No hay rollback de refrescos ya permitidos por consultas anteriores ni afirmación de atomicidad.

| Fallo | Canal/datos |
|---|---|
| Estructura, familia/control no admitido, queries vacías o más de 16 | Validación SDK/runtime, sin despacho |
| `composition-request-too-large` | Bytes observados y límite, sin eco de argumentos |
| `composition-conflicting-expectations` | Clave de consulta opaca; sin despacho |
| `composition-source-fault` | `queryKey`, familia y causa tipada pública de la consulta; preserva kind y stage de replay |
| `result-changed` compuesto | `stage: "composition"`, expected y actual si disponible; sin composición |
| `replay-unavailable` compuesto | `stage: "composition"`, razón de no verificabilidad; sin composición afirmada |
| `deadline` / `aborted` del lote | Fallo, sin fuentes anteriores devueltas como resultado final; limpieza obligatoria |
| `internal-fault` | Error redactado de invariantes de normalización/referencias, nunca un hecho vacío |

Un `Fact` con `status:"unknown"` es éxito de lectura: se conserva su razón/evidencia, no produce partes de un valor ausente. Un hecho parcial también es éxito. Un corte `deadline` contenido en una fuente permite entrega ordinaria de la composición con esa limitación, pero desactiva su verification y rechaza un `expect` compuesto. Se distingue del deadline que aborta el lote entero.

## 4. Parte A: contratos tipados de las partes significativas

### 4.1 Fuente interna autorizada

`query-runner.ts` expondrá `executeQuery(query: SemanticQuery, ctx: QueryExecutionContext): Promise<Result<ExecutedSource, QueryFault>>`. El contexto lleva los puertos ya incluidos en `McpDeps`, el catálogo, redacción, digest y signal; no crea otro contenedor de servicios.

```ts
type PublicWorkspaceValue = Omit<WorkspaceValue, "repositories">;
type PublicRead<T> = Omit<FactRead<T>, "repositorySources">;
type SourcePayload =
  | { family: "entrypoints"; read: PublicRead<EntrypointMap> }
  | { family: "impact" | "callers"; branch: "local"; read: PublicRead<ImpactValue> }
  | { family: "impact" | "callers"; branch: "workspace"; read: PublicRead<WorkspaceImpactValue> }
  | { family: "importers"; read: PublicRead<ImportersValue> }
  | { family: "outline"; read: PublicRead<OutlineValue> }
  | { family: "workspace"; read: PublicRead<PublicWorkspaceValue> }
  | { family: "decisions"; read: PublicRead<DecisionValue> };
```

`ExecutedSource` contiene esa unión pública redactada, su consulta validada, la información de recovery existente cuando aplica y un `RedactionIdentityGuard`. Este guard indica qué coordenadas/campos de identidad cambiaron al redactar comparando original y público **dentro del runner**. No exporta valores originales ni hashes de secretos. Se obtiene antes de descartar el original. Las ramas de la unión se recorren exhaustivamente con `never`, no con detección heurística de propiedades ni `Fact<unknown>` para despachar familias.

Las salidas privadas del core se filtran antes de construir `SourcePayload`; el tipo workspace público elimina `repositories`, y `PublicRead` elimina `repositorySources`. El guard de redacción tiene `{changedIdentityPointers:readonly string[], changedArguments:boolean, changedSnapshot:boolean}`: solo pointers/cambios, sin valores privados. `QueryExecutionDeps` se define en el runner con los seis puertos actuales más redaction/digest; `McpDeps` lo extiende y añade version/bindings. `QueryExecutionContext = {deps:QueryExecutionDeps,catalog:ReturnType<typeof repositoryCatalog>,signal?:AbortSignal}`. Así el runner no importa server y no crea un ciclo de tipos. `QueryFault` es la unión de los faults actuales de esos puertos y `RepositoryTargetFault`; exceptions se convierten en el `internal-fault` redactado actual. `ExecutedSource = SourcePayload & { query:SemanticQuery; recovery?:Recovery; identityGuard:RedactionIdentityGuard }`.

El renderer original sigue recibiendo su `Fact<V>`. `answer` consume el resultado tipado del runner para aplicar su presentación/selección actual. No convierte primero a JSON MCP para que luego el compositor vuelva a decodificarlo.

### 4.2 Tablas normalizadas y referencias

`src/mcp/composition-contract.ts` será el único propietario de estos tipos. Los prefijos son parte del wire y todos los digests tienen 64 hex minúsculas:

```ts
type SourceId = `s1:${string}`;
type ReadId = `r1:${string}`;
type SnapshotId = `v1:${string}`;
type FileId = `f1:${string}`;
type AnchorId = `a1:${string}`;
type EvidenceId = `e1:${string}`;
type PartId = `p1:${string}`;
type EntityId = `n1:${string}`;
type RelationId = `l1:${string}`;
type ConnectionId = `c1:${string}`;
type CompositionIdentity = `mcp-c1:${string}`;

type Support = { source: SourceId; read: ReadId; pointer: string };
type EvidenceFinding<T> =
  | { status: "complete"; value: T; evidence: readonly EvidenceId[] }
  | { status: "unknown"; reason: UnknownReason; evidence: readonly EvidenceId[] };
type EvidenceOrigin =
  | { kind: "snapshot"; snapshot: SnapshotId }
  | { kind: "query-context"; read: ReadId };
type EvidenceRecord = {
  id: EvidenceId; origin: EvidenceOrigin;
  value: Evidence; supports: readonly Support[];
};
type AnchorRecord = {
  id: AnchorId; file: FileId; symbol: string; line: number; endLine?: number;
  supports: readonly Support[];
};
type SymbolNameRef = { file: FileId; symbol: string }; // no inventa una línea
type BoundAnchor =
  | { status: "resolved"; entity: EntityId }
  | { status: "unresolved"; anchor: AnchorId;
      reason: "ambiguous" | "redacted" | "conflicting-coordinate" };
```

Los strings de `pointer` son JSON Pointers de salida generados por el adaptador (RFC 6901, escapado `~0`/`~1`). Localizan el soporte en el hecho público original, por ejemplo `/value/sections/shop/value/impact/symbols/2`. No son un selector ejecutable suministrado por el cliente. Índices y pointers siempre se interpretan junto al `SourceId`; no son IDs globales de entidades.

Las tablas son:

| Tabla | Campos obligatorios / significado |
|---|---|
| `snapshots` | `{id, value: SnapshotRef}`; una representación por snapshot exacto |
| `sources` | `{id, family, branch?, rootRead, snapshotVector, requestIndex}`; `branch` solo impact/callers; vector actual completo y ordenado por repo |
| `reads` | `{id, source, owner: CutOwner, schema, producer, inputs: FactInputs, snapshot, evidence: EvidenceId[], analysis}`; `analysis` es unión complete / partial con `cuts: Cut[]` no vacíos / unknown con reason. Añadir `readKind` en owners `read` usando `RepoImpact.reads[].kind` |
| `files` | `{id, snapshot, path, supports}`; identifica una coordenada de archivo, sin afirmar que el archivo existe o está indexado por el mero hecho de nombrarlo |
| `anchors` | Coordenadas declarativas originales; no confundidas con líneas de call site. `endLine` ausente se conserva ausente |
| `evidence` | `EvidenceRecord`; el objeto completo incluye `via` y confidence. Igual ubicación con distinto `via`/confidence comparte archivo, pero sigue siendo evidencia distinta |
| `parts` | Unión `Part` definida abajo, con `{id, supports}`; conserva asociaciones e información semántica original |
| `entities` | Declaraciones/entrypoints resueltos y sus bindings a anchors/parts; atributos apoyados por partes, sin elegir un ganador arbitrario |
| `relations` | Unión cerrada de relaciones registradas; soportes por variante/contexto, no una confidence máxima inventada |
| `connections` | Conjunciones limitadas de partes/relaciones; cada una identifica una regla y todos sus soportes |
| `issues` | Incompatibilidades, referencias ambiguas/faltantes y conflictos estructurados; no se llaman `Cut` del análisis |

Los `Cut[]` permanecen una vez por lectura propietaria: dos owners pueden describir el mismo stop; no se suman como huecos independientes. Se puede compartir su representación textual por igualdad exacta conservando ambos owners. No se parsean `Cut.at` ni `Evidence.via` para inventar entidades o relaciones.

`ReadAnalysis = {status:"complete"}|{status:"partial",cuts:readonly [Cut,...Cut[]]}|{status:"unknown",reason:UnknownReason}`. Es distinto de `Analysis` de `select-evidence.ts`, que sirve para descriptores y no lleva cuts. Un read unknown nunca lleva `value` ni un array inventado de partes; su evidence original sí permanece.

### 4.3 Unión `Part`: formas concretas, sin payload universal

Todos los miembros llevan `id: PartId` y `supports: readonly Support[]`. Esta tabla fija el payload de cada discriminante; los alias `*Data` se definirán en `composition-contract.ts` usando los tipos originales indicados, sin `unknown`, `any` ni campos libres:

| `kind` | Payload tipado y transformación exacta |
|---|---|
| `entrypoint` | `entry: EntryData`; unión de `HttpRoute`, `UiRoute`, `Listener`, `Job`. Sustituir handler/component conocido por `AnchorId`; conservar `component:"unknown"`, path/outlet/guards, method/version, protocolo/destination y trigger. `HttpRoute.basePath` se convierte a `EvidenceFinding<BasePath>` |
| `unknown-finding` | `{reason: UnknownReason, evidence: EvidenceId[]}`; posición/owner en supports, sin identidad de ruta inventada |
| `seed` | `{anchor: AnchorId, basis: SeedBasis, comparison?: ComparisonData}`; un target requested no se llama cambio. `ComparisonData = {repo, mergeBase, head: SnapshotId}` solo cuando el impacto registra merge base |
| `symbol-reach` | `{anchor: AnchorId, kindName: ImpactedSymbol["kind"], depth, confidence, fanIn, via?: ViaData}`; `ViaData = {target: SymbolNameRef, lines?: readonly number[], basis: DependenceBasis}`. Las líneas pertenecen al símbolo alcanzado, no al destino |
| `entrypoint-reach` | `{kindName: ReachedEntrypoint["kind"], name?: string, handler: AnchorId, depth, confidence, seeds: PartId[]}`; convertir los índices usando la tabla de semillas del mismo owner |
| `entrypoint-change` | `{change: ChangedEntrypoint["change"], kindName, name, handler: AnchorId, comparison: ComparisonData}`; removed usa merge base; added/altered, head. Altered no aporta la coordenada anterior |
| `module-origin` | `{comparison: ComparisonData, file: string, change: ModuleOrigin["change"]}`; describe un diff, sin inventar existencia en head para deleted |
| `module-reach` | `{file: FileId, side: ReachedModule["snapshot"], depth, origins: PartId[], via?: ReachedModule["via"]}`; base resuelve merge base del owner, head su snapshot. Los índices de origins nunca se buscan en seeds |
| `file-dependency` | `{from: FileId, to: FileId, category: "importer"|"reexporter"|"dynamic-importer"|"type-importer"|"user"|"unresolved-namer"|"outline-import"}`. La ausencia de una categoría opcional se conserva en `file-query` |
| `file-query` | `{file: FileId, presentCategories: readonly FileCategory[]}`; distingue campo opcional ausente de categoría presente vacía; `FileCategory` son las seis categorías de `ImportedFile` |
| `outline-declaration` | `{anchor: AnchorId, kindName: OutlineDeclaration["kind"]}`; conserva cada aparición, incluso duplicados dentro de una fuente que puedan indicar ambigüedad |
| `outline-file` | `{file: FileId, declarations: PartId[], imports: PartId[]}`; arrays de referencias conservan multiplicidad/orden del hecho, aunque un objeto idéntico se represente una vez |
| `unheld-file` | `{file: FileId}`; no se sustituye por `outline-file` con arrays vacíos |
| `outward-name` | `{origin: EvidenceOrigin, name: string, kindName: OutwardKind, evidence: EvidenceId[], disposition: "stated"|"unserved"}`; la diferencia de disposición no se borra |
| `name-candidate` | `{context: ReadId, name, repo, basis: NameCandidate["basis"], evidence: EvidenceId[]}`; mantener basis exacta; no es `Link` |
| `call-site` | `site: CallSiteData`, `disposition:"matched"|"unmatched"|"external"`; `CallSiteData` conserva todos los campos de `CallSite`, sustituye file/line/span por una ubicación tipada de call site y target por `EvidenceFinding<HttpTarget|EventTarget>`; `ancestors` y `stated` permanecen. La línea no se usa como comienzo de declaración |
| `unresolved-call-site` | `site: UnresolvedCallSite` más owner/snapshot mediante supports; conserva via/stated/transport. No se le fabrica target |
| `workspace-link` | `link: LinkData, direction: ImpactedLink["direction"], reach: LinkReference[]`; `LinkData` conserva `Link.id`, from/to, transport, basis, profiles/confidence, sustituyendo coordenadas por refs tipadas. `LinkReference = {status:"present",part:PartId}|{status:"missing",linkId:string}`; se conserva el orden original y un self-reference válido |
| `workspace-context` | Unión por `family`: workspace conserva `WorkspaceValue.workspace`; impact/callers conserva `WorkspaceImpactValue.workspace` y trigger; decisions conserva `DecisionValue.source` y su vector. Ningún miembro incluye repositories privados |
| `decision` | `{context: ReadId, id: Decision["id"], kindName: DecisionKind, subject, outwardKinds?, allowsFreeText, required, evidence: EvidenceId[], options: DecisionOptionData[]}`; `DecisionOptionData = Omit<DecisionOption,"evidence"> & {evidence: EvidenceId[]}` |
| `walk-cost` | `{owner: ReadId, walk:"symbols"|"modules", expansionsUsed:number}`; son costes registrados por análisis, no costes de deduplicación ni cardinalidades de entidades |

`FileCategory` usa los nombres originales `importers`, `reexporters`, `dynamicImporters`, `typeImporters`, `users`, `unresolvedNamers`; el adaptador los traduce a `category` mediante una tabla exhaustiva. `CallSiteData` define `location:{file:FileId,line:number,endLine?:number}`, mantiene `repo`, `symbol` y `ancestors` literales. `LinkData.from` utiliza la misma ubicación de call site más `repo/symbol`; `LinkData.to` conserva `repo/kind/name` más `handler:AnchorId`. No se tipa un call site como declaración.

`EntryData`, `ViaData`, `ComparisonData`, `CallSiteData`, `LinkData`, `DecisionOptionData` y las uniones de contexto son alias cerrados de los campos descritos; se implementan y validan en T2. El esquema runtime cubre sus campos opcionales originales, incluidos `guards`, `profiles`, `ancestors`, `stated`, `typeOnly`, `form` y evidence finding desconocido. Añadir un campo al dominio requiere revisar el adaptador mediante las pruebas de conservación; no se permite descartarlo silenciosamente para pasar typecheck.

### 4.4 Adaptadores de las siete familias

| Familia y valor actual | Partes que aporta | Unión permitida | Inferencias prohibidas / límites |
|---|---|---|---|
| entrypoints: `value.entrypoints: Fact<Finding<Entrypoint>[]>` | Root y sección como reads, entrypoints conocidos, unknown findings, handlers/component, basePath/guards y evidencia | Handler ↔ declaración outline única; entrypoint ↔ reached entrypoint si coinciden todos los campos de identidad disponibles de manera única | Finding complete puede contener basePath o component unknown. No se rellena. Alias de rutas no se colapsan por handler |
| impact local: `ImpactValue` | Comparison, seeds, símbolos/via, reached entrypoints/seeds, changed entrypoints, módulos/orígenes, costes/cortes | Mismas declaraciones que callers/outline; misma dependencia explícita; ruta ↔ handler ↔ alcance registrado | Reach no prueba rotura; origins no prueban cadena. Removed/base no es head. Un módulo solo no es resultado vacío |
| callers local: `ImpactValue` sin merge base del diff | Targets/semillas requested, símbolos/via y entrypoints; costes/cortes | Declaraciones y dependencias con impact cuando owner/snapshot/contexto aplicable coinciden | No inventar merge base, cambios ni módulos; una consulta por nombre puede seleccionar varias declaraciones |
| impact/callers workspace: `WorkspaceImpactValue` | Lo anterior por sección, todos los reads, call sites con sus disposiciones, links/reach y contexto/vector | Link ya admitido ↔ sus endpoints y coordenadas exactas de otras fuentes; duplicación de link con provenance unida | El compositor no ejecuta el join/traversal de dominio a partir de workspace discovery; no convierte downstream en afectación ni depth en hops |
| importers: `ImportersValue.files[]` | Archivos objetivo y categorías, dependencias orientadas consumidor → objetivo, categorías opcionales/solapamiento | `outline.files[].imports` y categoría importer comparten la relación genérica de importación solo cuando ambas la registran; cada atestación conserva su categoría | `users` no es calls; unresolvedNamers no es dependencia resuelta; categorías se solapan y no se suman como conjuntos disjuntos |
| outline: `OutlineValue` | Archivos, declaraciones/spans, imports, unheld | Coordenadas únicas permiten conectar handler/seed/símbolo. Imports aportan solo relaciones de archivos | No contiene snippets, firmas ni código. Una declaración dentro de otra no es el mismo símbolo; no basta solapamiento de spans |
| workspace: `PublicWorkspaceValue` | Nombres, unresolved sites, candidatos, unserved, secciones, membresía/gateways/vector | Compartir evidencia de un mismo repo/snapshot; relacionar un candidato con la observación de nombre que el contrato identifica exactamente y con su contexto | Nombre candidato no prueba destino ni llamada; no se generaliza route-overlap a Link; no inscribe membresía |
| decisions: `DecisionValue` | Gaps y opciones completas, evidence, recommended/required/freeText, source/vector | Igualdad exacta dentro del mismo contexto; coincidencia de evidence identificada como tal | `Decision.id` no identifica entre contextos. Una recomendación no es decisión del usuario, permiso de trust ni aprobación de código |

Hay siete familias; las dos variantes workspace de impact/callers son adaptaciones de esas familias, no herramientas adicionales. Cada adaptador recorre únicamente campos tipados conocidos; las salidas normales no se descubren mirando su texto.

### 4.5 Evidencia cuyo snapshot no está demostrado

Para un `Evidence` local, el owner leído suministra repo/snapshot. Para `RepositoryEvidence`, resolver su `repo` en el vector de esa fuente; no usar el snapshot del trigger. Si falta o contradice el vector, conservar `origin:{kind:"query-context",read}` y emitir `missing-provenance`; no inventar un SHA.

Una opción de decisions con `basis:"origin"` está respaldada por la configuración externa que `buildDecisions` leyó, aunque señale `.git/config:1`. Su evidencia se marca `query-context`, nunca `snapshot`. Las decisiones de trust/membresía/revisión también conservan su contexto de lectura; sus options sin evidence no se rellenan. El resto de evidence code/config de repositorio solo usa `snapshot` cuando el vector lo identifica. Esta clasificación viene del tipo/kind/basis del productor, no de regex del path.

La deduplicación de `Evidence` exige igualdad de origin y del objeto completo; una coordenada de commit y una evidencia de contexto externo no son el mismo soporte. `shares-evidence` solo expresa coincidencia del soporte, nunca causalidad entre los hallazgos que lo citan.

## 5. Parte B: unión, identidad y compatibilidad

### 5.1 Identidad y límites de deduplicación

| Objeto | Clave canónica y guards |
|---|---|
| Snapshot | Todos los campos de `SnapshotRef` en canonical JSON. No acortar SHAs ni stateId para comparar |
| Archivo | SnapshotId + path relativo exacto. Sin case-folding, basename, realpath de archivos analizados ni resolución de symlinks añadida |
| Anchor declarativo | FileId + symbol literal + line + presencia/valor de endLine. El nombre simple solo se usa dentro de `joinsFact`, no como identidad global |
| Declaración outline | FileId + name + line + endLine + kind. Si una misma fuente conserva varias apariciones indistinguibles, registrar ambigüedad: el ID interno fue proyectado fuera y no puede recuperarse por adivinación |
| Entidad declarativa sin outline | Anchor exacto compartido cuando no hay contradicción. No fusionar nombres calificados distintos por sus últimos segmentos |
| Entidad con outline | Declaración outline única y anchors que pasan `joinsFact` y los guards de esta sección. Las grafías originales permanecen en anchors; se presenta una entidad con aliases respaldados |
| Entrypoint | Snapshot y campos de identidad de su unión discriminada: HTTP method/path/version/handler; UI path/outlet/component; listener protocol/destination/handler; job trigger/handler. `basePath`/guards son observaciones conservadas, no strings borrados. Un reached entrypoint con información menor se conecta solo a un candidato único |
| Evidence | Origin exacto + `canonicalJson(Evidence)`; union de supports. Dos citas del mismo sitio no son dos confirmaciones independientes |
| Relación | Kind, endpoints canónicos y basis/calificadores semánticos. Cada atestación conserva su contexto requerido; contextos incompatibles no se funden en una afirmación conjunta. La ubicación y confidence del testigo no se maximizan |
| Decision | Contexto de lectura + `Decision.id` + contenido de gap/opciones; conflictos de opciones quedan como variantes de contexto, sin unión de recomendaciones |
| Parte | Discriminante + payload tipado con refs y contexto semántico aplicable; supports se unen como conjunto. El orden de colecciones con semántica propia se conserva |

Los IDs son `prefix + Digest.of(canonicalJson(["mcp-composition-v1", kind, key]))`. `SourceId` usa familia/branch, contexto semántico normalizado y el hecho público redactado completo antes de normalizar; incluye schema, producer, inputs, value/status/reason y provenance. Para las tres familias con recovery se reutiliza la preparación del contexto existente, sin cambiar `mcp-r1`. Las otras cuatro normalizan el repo seleccionado, snapshot/vector, scope/config efectivos y argumentos semánticos no ligados a presentación. Se excluyen roots absolutos y sidecars de frescura, no membresía, trust o provenance. Los paths explícitos de membresía se representan para identidad mediante los IDs y la declaración efectiva del contexto, sin publicar un hash del path ni borrar su efecto de selección.

`ReadId` incluye SourceId y owner; no se inventa la equivalencia de dos lecturas por compartir snapshot. `PartId` puede compartir representación entre fuentes cuando payload y contexto lo permiten; sus supports retienen todas las apariciones públicas. Los arrays de referencias de `outline-file`, origins, evidence findings y reach mantienen el orden y multiplicidad originales. Deduplicar el objeto referenciado no borra la diferencia entre una aparición repetida en una fuente y el mismo soporte aportado por dos fuentes.

No se usarán IDs numéricos asignados al insertar. Los IDs wire completos son opacos; el renderer puede asignar `S1`, `N1`, `R1` después de ordenar las tablas y debe dar una leyenda inequívoca. No son IDs persistentes reutilizables sin su composición/source.

### 5.2 Dos niveles de compatibilidad

**Compartir una coordenada física** exige owner/snapshot exactos y campos no redactados. Esto permite que dos scopes nombren el mismo archivo o declaración sin afirmar que ambos lo cubren entero. La cobertura y la interpretación de cada observación permanecen separadas.

**Conectar afirmaciones semánticas entre fuentes** exige además:

- Misma versión de schema soportada y mismo producer name/version.
- Trust igual en los reads necesarios; si difiere, mostrar variantes con `context-mismatch`, no promover la lectura más permisiva.
- Las versiones de engines comunes coinciden. Engines que solo intervienen en una familia permanecen en su provenance; no se exige que entrypoints y outline usen exactamente la misma lista de engines.
- `typeRoot` coincide para conexiones que atribuyen una dependencia resuelta por tipos. Presencia en un solo lado no equivale a igualdad. Una anotación puramente estructural de ubicación no necesita inventar una type root.
- Todos los repositorios usados por la conexión tienen snapshots compatibles. Para una relación workspace, incluir ambos endpoints y el contexto de membresía/gateways que justificó el match. Diferencias en repositorios ajenos a una anotación local no invalidan esa coordenada, pero siguen visibles en los vectores.
- Existe evidencia positiva en cada fuente para los sujetos usados. Diferencias en scope/budget/targets/changed no invalidan por sí solas una declaración observada, pero nunca permiten concluir cobertura conjunta completa ni trasladar un resultado negativo entre scopes.

`inputs.content` y `inputs.config` no se comparan ciegamente entre familias: sus productores pueden leer selecciones distintas. Se conservan completos y se comparan los campos semánticos necesarios para la regla. Los presupuestos, depth, fanIn, confianza y sets de orígenes son observaciones de cada recorrido; no se convierten en atributos únicos de la entidad.

Una diferencia de snapshot no es necesariamente un conflicto: puede ser una comparación solicitada. La composición contiene dos particiones y `issues.kind:"snapshot-difference"` con sus sources. Ninguna entidad o dependencia cruza esa frontera por similitud. Un mismo repo/vector no implica captura atómica de todos sus componentes.

Compatibilidad no se trata como una equivalencia transitiva. Si A y B no comparten engine X y B y C tampoco, eso no hace compatibles A(X=1) y C(X=2). Toda conexión evalúa conjuntamente todos sus reads necesarios y rechaza cualquier par con campos comunes contradictorios; una fuente intermedia no puede servir de puente para ocultar el conflicto.

### 5.3 Matching declarativo conservador

`materializeEvidence` trabaja sobre **todas** las observaciones acumuladas, no fusiona aliases de forma irreversible durante la llegada de fuentes:

1. Construir candidatos outline por archivo exacto y snapshot. Retener duplicidad dentro de una fuente como ambigüedad potencial.
2. Aplicar `joinsFact` al anchor y al candidato (`name`, `startLine=line`, `endLine`). Exigir un único candidato y compatibilidad; si varios spans anidados lo aceptan con el mismo nombre, no elegir el más pequeño implícitamente.
3. Si ambas fuentes aportan endLine, exigir coherencia; si discrepan, conservar valores y emitir `conflicting-coordinate`. Un line dentro de un span puede ser una anotación/decorador; no se reescribe como inicio hasta que el join único lo demuestra.
4. Unir anchors iguales y aliases demostrados con esa declaración. Sin outline, solo igualdad exacta de anchors. Un campo redactado bloquea el join transversal aunque dos strings redactados coincidan.
5. Resolver `ViaData.target` solo contra declaraciones/seeds/símbolos del **mismo read propietario** que identifican un destino único por file y symbol literal. Si ese read no lo resuelve, puede anotarse un candidato outline único compatible, pero la relación se marca `endpoint-resolved-from-outline` y conserva ambos soportes. Nunca usar solo el último segmento para elegir entre varios destinos.

Si el modelo público no permite separar dos declaraciones idénticas en línea/nombre/span, el resultado es `ambiguous`, no una afirmación de identidad perfecta. Exponer GraphNodeId de manera transversal requeriría otro cambio de contrato y no es necesario para esta versión. La limitación queda sometida a prueba en T3.

### 5.4 Unión algebraica y orden

`normalizeSource(source): EvidenceSet` produce observaciones inmutables con sus contextos. `mergeEvidence(left, right): EvidenceSet` hace unión por claves canónicas de esos datos; no renderiza, resuelve aliases ni elimina conflictos. `materializeEvidence(set): CompositionGraph` calcula bindings, relaciones, conexiones e issues a partir del conjunto entero.

Para sets de evidencia compatibles fijos se exige:

```text
merge(A,B) = merge(B,A)
merge(merge(A,B),C) = merge(A,merge(B,C))
merge(A,A) = A
materialize(merge(A,B,C)) es determinista para el mismo conjunto
```

La unión también conserva fuentes incompatibles; lo que no hace es fusionar sus afirmaciones. Añadir una observación ambigua puede hacer que una conexión antes posible deje de resolverse; recalcular sobre el conjunto completo es necesario para evitar dependencia del orden. No se usa union-find irreversible sobre aliases ni «primero gana».

Ordenar tablas por ID con `compareText`; supports por source/read/pointer; strings que representan sets por orden de code units. Conservar en sus partes los arrays cuyo orden significa algo: `reach`, índices/posiciones originales, targets/config y listas de evidencia. No ordenar arrays arbitrarios con `canonicalJson`, que solo ordena claves de objetos.

La identidad compuesta es `mcp-c1:Digest.of(canonicalJson(["mcp-composition-v1", sortedUniqueSourceIds]))`. Versionar el algoritmo cuando cambie su semántica. Cada SourceId ya cubre el hecho público íntegro y su contexto. Presentation, índices de entrada, duplicados de la misma consulta, deadlineMs solicitado y sidecars no entran en esa identidad.

Esto no promete que ejecutar consultas con inputs móviles en otro orden obtenga la misma evidencia. Una consulta dependiente necesita antes sus coordenadas. Una sesión fría puede registrar otra `inputs.origin` de índice; se preserva esa diferencia y se comparan por separado las conclusiones semánticas, sin eliminar provenance para forzar bytes iguales.

## 6. Relaciones y conexiones permitidas

`compose-evidence.ts` será el único propietario de estas reglas. Los adaptadores producen partes; el renderer nunca infiere relaciones.

| Relación registrada | Construcción y soporte | Lo que no afirma |
|---|---|---|
| `serves-entrypoint` | Entrypoint conocido → handler/component conocido, con parte original y binding declarativo si existe | Una UI route con component unknown no tiene handler inventado |
| `symbol-dependence` | Símbolo alcanzado → destino `via` resuelto, `basis:DependenceBasis`; líneas y confidence en atestaciones por read | `call` agrupa calls/instantiates; reference/contains/dispatch/relation/import no se renombran calls. `via` es la dependencia registrada que primero alcanzó el símbolo, no todas las edges del grafo |
| `file-import` | Consumidor → archivo importado cuando importer u outline-import lo registran; atestación conserva categoría, tipo/dinámica cuando el contrato los registra | Importers sin esos campos no prueban runtime ni uso de un símbolo |
| `file-use` | Categoría user con endpoints de archivo | No equivale a file-import ni a symbol-dependence |
| `unresolved-file-name` | unresolved-namer, explícitamente unresolved | No es dependencia demostrada |
| `module-dependence` | `module-reach.via`: módulo alcanzado → `via.file`, en el mismo lado/snapshot; location `via.line` pertenece al alcanzado. Conservar kind/specifier/typeOnly/form | No prueba ejecución del módulo ni símbolo llamado. Si falta merge base, no producir endpoint base |
| `entrypoint-origin` | Entrypoint alcanzado → cada seed que su array referencia, en ese owner | No es cadena de llamadas ni aplica automáticamente a todos los aliases del handler |
| `module-origin` | Módulo alcanzado → origen de su tabla de módulo, conservando comparación/lado | No mezcla índices con symbol seeds ni convierte deleted en declaración head |
| `workspace-match` | El Link que el dominio ya admitió; vector/contexto de match, basis/profiles, direction y reach por atestación | No vuelve a hacer matching desde los nombres de workspace ni convierte una invocación downstream en consecuencia |
| `candidate-for-name` | NameCandidate ya registrado y la observación de nombre compatible que identifica exactamente; si no hay correspondencia única se mantiene como parte candidata | No establece membresía, trust ni llamada |
| `shares-evidence` | Dos partes citan el mismo EvidenceId de origin exacto | No establece causalidad, equivalencia de hallazgos ni independencia estadística de soportes |

Deduplicar una relación idéntica une sus atestaciones, no duplica el endpoint ni el objeto relación. Cada atestación apunta a sus PartId/ReadId y conserva calificadores/contexto de observación. Basis o perfiles distintos son relaciones diferentes; contextos distintos de un mismo valor quedan como atestaciones distintas y no se transforman en una afirmación más fuerte. Si son incompatibles, se etiquetan como variantes y ninguna conexión combina sus soportes. No se promedian/maximizan confidences; en texto se muestran variantes o rango explícitamente etiquetado como valores registrados, sin probabilidad agregada.

### Formas de entidades, relaciones y atestaciones

Para cerrar el contrato de implementación, los payloads wire son los siguientes. `EntryIdentity` es la unión de identidad de entrypoint de §5.1 con handlers conocidos sustituidos por EntityId; conserva `component:"unknown"`. Si solo existe un reached entrypoint que no resuelve una identidad completa única, permanece como parte sin fabricar una Entity de ruta.

```ts
type EntityRecord =
  | { id: EntityId; kind: "declaration"; file: FileId;
      anchors: readonly AnchorId[]; declarations: readonly PartId[] }
  | { id: EntityId; kind: "entrypoint"; snapshot: SnapshotId;
      identity: EntryIdentity; parts: readonly PartId[] };
type CallLocation = { file: FileId; line: number; endLine?: number };
type Attestation = {
  contextKey: string;
  parts: readonly PartId[]; reads: readonly ReadId[];
  locations?: readonly CallLocation[]; confidence?: number;
};
type RelationValue =
  | { kind: "serves-entrypoint"; entrypoint: EntityId; handler: EntityId }
  | { kind: "symbol-dependence"; from: EntityId; to: EntityId; basis: DependenceBasis }
  | { kind: "file-import" | "file-use" | "unresolved-file-name"; from: FileId; to: FileId }
  | { kind: "module-dependence"; from: FileId; to: FileId;
      qualifier: Pick<NonNullable<ReachedModule["via"]>, "kind"|"typeOnly"|"form"|"specifier"> }
  | { kind: "entrypoint-origin"; entrypoint: PartId; seed: PartId }
  | { kind: "module-origin"; module: PartId; origin: PartId }
  | { kind: "workspace-match";
      from: CallLocation & {repo:string;symbol:string};
      to: {repo:string;kind:Entrypoint["kind"];name:string;handler:EntityId};
      transport:Link["transport"];basis:LinkBasis;profiles?:readonly string[] }
  | { kind: "candidate-for-name"; name:PartId; repo:string; basis:NameCandidate["basis"] }
  | { kind: "shares-evidence"; parts:readonly [PartId,PartId]; evidence:EvidenceId };
type RelationRecord = {
  id: RelationId; value: RelationValue;
  attestations: readonly Attestation[];
};
```

`contextKey` de cada atestación es el digest de su propio contexto requerido: snapshots relevantes, trust, producer/schema, engines registrados y typeRoot cuando procede; para workspace añade declaración efectiva, membresía y gateways. No se calcula con «engines comunes de la primera pareja» ni incluye SourceId, depth, budgets u orden de llegada. Los reads completos siguen en attestations; diferencias de presupuesto no se borran. La compatibilidad entre atestaciones se comprueba con §5.2 al construir conexiones, sin colapsar contextKeys distintos. Los calificadores de importación solo están en atestaciones/partes si el productor los conoce; un file-import genérico no se declara estático/de runtime sin esa evidencia.

Las tablas adicionales obligatorias son `bindings:readonly {anchor:AnchorId,binding:BoundAnchor}[]` y `connections:readonly Connection[]`, con `Connection.id:ConnectionId`. `CompositionGraph` es un objeto estricto con `snapshots,sources,reads,files,anchors,evidence,parts,entities,bindings,relations,connections` como arrays de sus tipos concretos. `EvidenceSet` mantiene las tablas normalizadas previas a entities/bindings/relations/connections, además de los datos de contexto y multiplicidad necesarios; los issues se materializan de nuevo y se entregan en coverage, no son una fuente de inferencia incremental.

### Conexiones derivadas cerradas

`Connection` tiene `{id, rule, parts:PartId[], relations:RelationId[], supports:Support[]}` y, solo cuando procede, `entities:EntityId[]`. `rule` es una unión cerrada:

- `handler-declaration`: un `serves-entrypoint` y su binding outline único permiten presentar ruta, handler y declaración juntos.
- `change-dependent`: seed de impact con comparison + `symbol-dependence` hacia esa misma entidad, en el head compatible. Permite decir «C tiene una dependencia registrada de S, que es semilla del diff». No dice que C se romperá ni que la dependency demuestre por sí sola todo el recorrido de impact.
- `reached-handler`: un `entrypoint-reach` y un entrypoint conocido compatibles permiten presentar el alcance registrado con el nombre/metadata completos de la ruta. La asociación de seeds sigue siendo la del reached entrypoint concreto.
- `shared-file-import`: evidencia de importers y outline del mismo file-import se agrupa; ambas atestaciones quedan disponibles y las categorías opcionales no se rellenan.
- `shared-support`: dos hallazgos comparten evidencia exacta; útil para relacionar workspace/decisions sin interpretar strings de subject/option como identidades de código.

No se deriva cierre transitivo de dependencias, ausencia de consumers, breakage, una cadena C→H→S no registrada ni una recomendación nueva. Un consumidor puede razonar sobre varias relaciones explícitas citándolas y sus límites; el servidor no añade esa inferencia como si fuese evidencia observada. `compare` se limita a mostrar particiones/variantes; calcular un diff semántico nuevo entre snapshots queda fuera.

## 7. Contrato de salida y consumo por agentes

### 7.1 Forma wire

La composición no usa `Fact.schema` ni `status` global de análisis. Una colección de análisis con preguntas distintas no tiene una cobertura completa común. Los estados originales siguen en `reads`; `summary` solo resume sus conteos sin rebajarlos ni promocionarlos.

```ts
type Verification =
  | { status: "available"; identity: CompositionIdentity }
  | { status: "unavailable";
      reason: "deadline" | "unresolved-context" | "redacted-context" };

type RepeatRequest =
  | { status: "available"; query: ComposeQuery;
      strategy: "pinned-replay" | "fresh-read" }
  | { status: "unavailable";
      reason: "redacted-context" | "unresolved-context" | "deadline" };

type ComposeReceipt = {
  kind: "composition-receipt"; compositionSchema: 1;
  mode: "summary" | "details";
  verification: Verification;
  requests: readonly RepeatRequest[];
  sources: readonly SourceDescriptor[];
  coverage: CoverageSummary;
  counts: CompositionCounts;
};
type ComposeFull = {
  kind: "composition"; compositionSchema: 1; mode: "full";
  verification: Verification;
  requests: readonly RepeatRequest[];
  graph: CompositionGraph;
  coverage: CoverageSummary;
  counts: CompositionCounts;
  delivery?: CompositionDelivery;
};
```

`SourceDescriptor` es `{id,family,branch?,rootRead,requestIndex,snapshotVector,analysis:Analysis}`. En receipt, `rootRead` es una referencia descriptiva y se acompaña del estado de raíz más los límites agrupados de sus reads en `coverage`, sin prometer acceso a una tabla ausente. Full usa `graph.sources` con la misma forma; no repite una segunda tabla sources al nivel superior.

`CoverageSummary` tiene `{reads:{complete:number,partial:number,unknown:number}, unknowns:{source,owner,reason}[], limits:{source,owner,kind,limit?,cuts,places}[], issues:CompositionIssue[]}`. Los conteos son de **lecturas registradas**, incluyen owners anidados y no se presentan como análisis independientes ni huecos disjuntos. Se conservan unknown findings y basePath/component desconocidos en partes y se cuentan aparte mediante `CompositionCounts.unknownFindings`; no cambian artificialmente el status de su colección.

`CompositionCounts` contiene `{sources,reads,files,anchors,entities,evidence,parts,relations,connections,unknownFindings}`; se cuentan objetos únicos de las tablas correspondientes. `CompositionDelivery` agrupa por SourceId las raíces/freshness/resolution/live/workspaceLive públicas ya redactadas. No forma parte de la identidad ni de una prueba de atomicidad/frescura verificada. Summary/details muestran sus avisos materiales en texto; full conserva todos los sidecars públicos presentes, sin serializarlos otra vez en el texto.

`CompositionGraph` incluye las tablas de 4.2; `issues` se transmite una sola vez en `coverage.issues`, y el tipo de grafo interno puede referir esa misma colección sin duplicarla en wire. La entrada de cada read y source es autosuficiente para resolver todos los IDs que usan las partes/relaciones/conexiones de full. Un verificador de integridad comprueba cada referencia y cada owner; missing `reach` explícito es un estado permitido, no una referencia colgante accidental.

`CompositionIssue` es la unión cerrada de objetos con discriminante `kind`: `snapshot-difference`, `context-mismatch`, `ambiguous-declaration`, `conflicting-coordinate`, `unresolved-endpoint`, `missing-provenance`, `missing-origin-reference`, `missing-link-reference`, `redacted-identity`. Cada rama requiere `sources:SourceId[]`, `reads:ReadId[]` y los anchors/part refs pertinentes según el kind; `context-mismatch` incluye `field:"trust"|"producer"|"schema"|"engine"|"typeRoot"|"workspace"`. No se añade una bolsa libre de detalles con información privada.

### 7.2 Modos

| Modo | Texto | Structured content |
|---|---|---|
| summary, default | Hallazgos/conexiones útiles, coordenadas necesarias, estados/cortes materiales, incompatibilidades y conteos de soporte omitido | ComposeReceipt; requests completos compactos y descriptors, no arrays de evidencia extensos |
| details | Hallazgos con relaciones explícitas, entidades, ubicación y sus supports legibles; contexto compartido por igualdad exacta; incertidumbre localizada | ComposeReceipt; same semantics que full |
| full | Acknowledgment y guía de navegación por tablas, relaciones/atestaciones y provenance; sin segundo listado de hallazgos | ComposeFull exhaustivo de todas las partes públicas registradas, sus asociaciones y límites |

No se genera prosa mediante un LLM dentro del servidor. El renderer es determinista y distingue «registrado», «asociado», «candidato», «desconocido» e «incompatible». Los hallazgos de summary/details se eligen por su categoría semántica: conexiones permitidas, consecuencias registradas de impact/callers, gaps de decisions y hallazgos independientes; nunca por un top-N oculto o confidence como ranking de riesgo. Las evidencias repetitivas pueden agruparse y contarse, pero cada categoría omitida identifica su conteo registrado y cómo obtenerla con full o una selección original realmente soportada.

Las coordenadas y la leyenda resuelven referencias en el mismo texto. No se imprime «N7 depende de N3» sin declarar ambos sujetos/ubicaciones y la base de la relación. Cuando un bloque compartido no ahorra bytes UTF-8 frente a la forma literal, reutilizar `preferShorterText`. Ahorrar repetición no autoriza borrar una distinción semántica ni una limitación.

### 7.3 Ejemplos antes/después

Ejemplos ilustrativos, no mediciones ni snapshots esperados de texto. `A`, `B`, `S1`, `N1` y `L1` son abreviaturas de la leyenda; el wire usa IDs completos.

**Handler y declaración complementarios**

```text
Antes, dos respuestas:
entrypoints: GET /orders -> src/OrderController.java:6-9 OrderController.one
outline: src/OrderController.java, method one, 6-9

Después:
Contexto A = shop @ sha aaaa…; S1 entrypoints, S2 outline.
N1 = src/OrderController.java:6-9 one (alias registrado: OrderController.one).
GET /orders servido por N1 [entrypoint S1; declaración S2].
basePath: unknown/unresolved (S1). La asociación no fija una URL de despliegue.
```

**Misma dependencia dos veces, hecho complementario una vez**

```text
N1 = OrderService.find @ shop/A, src/OrderService.java:31-38.
N2 = OrderController.one @ shop/A, src/OrderController.java:17-25.
L1 = N2 -> N1, symbol-dependence, basis call; sitio registrado 21.
Atestaciones: impact S1 y callers S2. Una relación; dos procedencias.
S1 registra N1 como semilla del diff B..A; también alcanza GET /orders.
Conclusión acotada: N2 depende de la declaración cambiada y la ruta fue
alcanzada en S1. No se ha probado una rotura ni una cadena adicional.
Límite de S1: depth=2 en el anchor registrado; S2 conserva su propio budget.
```

Un `L1` que no resuelva inequívocamente `via` se sustituye por la parte `symbol-reach` con destino nombrado y `unresolved-endpoint`, no por una edge fabricada. Si ambos soportes repiten la misma evidencia en el mismo contexto, la tabla evidence contiene un objeto con ambos supports.

**Importación y dependencia de símbolo**

```text
F1 src/ui.ts -> F2 src/service.ts: file-import [importers S3; outline S4].
N3 C -> N1 S: symbol-dependence basis reference [callers S2].
Se conservan dos relaciones de distinto nivel. El import no demuestra C llama S.
unresolvedNamers de S3 sigue siendo unresolved-file-name, aunque F1 sea importer.
```

**Snapshot distinto y fuente parcial**

```text
S1 impact: shop/A, partial, depth cut; S2 outline: shop/B, complete.
Dos declaraciones físicas; no se fusionan aunque coincidan archivo/nombre/línea.
snapshot-difference(S1,S2). S2 no explica la declaración de S1 ni completa su walk.
S3 workspace: api live(head=h,stateId=x); S4 callers: api live(head=h,stateId=y).
El head coincide, el estado no: particiones separadas; ninguna conexión entre ellas.
```

### 7.4 Full y recuperación de fuentes

La composición full conserva la información semántica pública completa mediante tablas y referencias; no adjunta además los siete hechos crudos. Debe permitir reconstruir los contenedores relevantes de cada fuente con sus índices/orden y distinguir opcionales ausentes, unknowns y categorías vacías. No se exige conservar el orden de claves JSON ni duplicar IDs/objetos originales cuando ya existe una referencia inequívoca. T2 verifica conservación de campos y asociaciones, no solo conteos.

Cuando un consumidor requiere el hecho público original, usa el `requests[source.requestIndex]` correspondiente:

- Entrypoints/impact/callers con recovery disponible: `query` es la receta existente con su `expect` mcp-r1 y `strategy:"pinned-replay"`. Para full original se añade `mode:"full"`; para selección, se añaden `select` y `page` al mismo tool, manteniendo expect. La identidad es la original, no un SourceId.
- Importers/outline/workspace/decisions: `strategy:"fresh-read"`; se entrega la consulta original validada/redactada sin falsificar un recipe equivalente. No se añaden select/page/expect originales inexistentes. El consumidor compara snapshots/contexto o verifica el conjunto con `ye_ast_compose.expect`.
- Recovery original indisponible por deadline/contexto/redacción: `RepeatRequest` conserva esa indisponibilidad cuando no puede emitirse una consulta segura. Nunca se devuelve un objeto con argumentos secretos parcialmente reemplazados que parezca una receta válida.

Para repetir/verificar el conjunto, enviar a `ye_ast_compose` las `requests[].query` disponibles y el `verification.identity` como expect de composición. El receipt entrega todas esas requests, no exige un request anterior oculto. Las recetas pinned estabilizan las tres familias implementadas; las fresh vuelven a leer su contexto actual y pueden fallar la comparación. Un cambio de branch/manifest/trust/remoto/origin/live no se traduce en éxito de replay histórico. No se promete que un conjunto con decisions sea recuperable en el futuro aunque hoy se pueda verificar su igualdad al recalcular.

`verification` puede ser available para una lectura fresh si todo su contexto público tiene identidad determinista y no contiene deadlines: es una assertion sobre lo recalculado, no disponibilidad de un snapshot histórico. Si falta contexto para identificar la evidencia, o la redacción altera argumentos de identidad, es unavailable. Cualquier `expect` en ese caso falla `replay-unavailable`; la entrega no afirmada sigue disponible.

`ye_ast_compose` rechaza `select` y `page` en la raíz y dentro de queries. No se implementa paginación del grafo nuevo en esta versión. Las páginas de fuentes originales siguen respondiendo a la selección original, no se insertan como hechos completos ni se confunde `page.total` con total real de callers. Esta decisión mantiene acotado el alcance y evita otra gramática de cursores/retención.

## 8. Redacción, confianza y seguridad de identidad

El runner conserva el orden actual: filtrado público → redacción → identidad/recovery → presentación. El compositor solo ve lo público más el guard booleano/por referencia que indica si una clave cambió al redactarse. No se deduplican declaraciones porque ambas terminen en `[REDACTED]`; se emite `redacted-identity`, se conservan las observaciones por source/owner/pointer y se bloquean sus joins entre fuentes.

Si una clave cambia con redacción, su ID se deriva de su contenido público más source/owner/pointer; **no** se publica el hash de la coordenada secreta original. Los supports no exponen strings de error privados, raíces internas ni argumentos alterados. La asignación occurrence-local sacrifica deduplicación antes que autoridad incorrecta. Verification/repeat se desactiva según el contexto afectado; no se entrega un source identity aparentemente reutilizable para abrir datos ocultos.

Una relación workspace necesita snapshots reales de ambos extremos y contexto compatible. Si solo se conoce el repo destino pero falta su snapshot, se conserva LinkData como parte con `missing-provenance`, sin file/entity global ni nuevas conexiones. Un Link de una fuente no se resuelve a cualquier Link con el mismo id de otra: se comprueba el vector y los calificadores. Reach con ID faltante mantiene `status:"missing"`; un `reach` autorreferente registrado no se expande recursivamente.

Si dos consultas diferentes se vuelven indistinguibles tras redacción de sus claves, no se unen sus SourceIds. Antes de procesar, el coordinador ya tiene consultas únicas ordenadas; asigna a las fuentes afectadas un discriminador ordinal local de esa secuencia y deriva su ID solo de ese ordinal y datos públicos. No publica hashes de argumentos privados. El guard desactiva verification en ese conjunto y la equivalencia transversal de esas identidades; los duplicados exactos de la misma consulta ya se eliminaron antes. La invariancia exigida sigue aplicándose a las permutaciones del mismo conjunto ordenado de consultas, no a comparar conjuntos distintos de secretos redactados.

Las rutas absolutas permitidas como argumentos workspace solo se devuelven si sobreviven a la redacción existente. Las raíces públicas y frescura se agrupan como delivery; nunca entran en identidad de entidad. No se interpreta repositorio disponible como confianza ni se usa un gap trust de decisions para aplicarla. Toda repetición revalida autoridad actual mediante los puertos originales.

## 9. Propiedad de código y migración

### 9.1 Archivos y reglas con un solo propietario

| Archivo propuesto/existente | Responsabilidad y API |
|---|---|
| Nuevo `src/mcp/query-schema.ts` | Extraer esquemas de entrada actuales y recipes; exportar `SemanticArguments`, `SemanticQuery`, esquemas completos y semánticos por familia. No altera defaults/refinamientos |
| Nuevo `src/mcp/query-runner.ts` | `executeQuery`, catálogo/puertos/filtrado/redacción/sidecars, guard de identidad redactada y preparation de recovery. Único despacho semántico para herramientas originales y composición |
| Existente `src/mcp/server.ts` | Registro, controles originales select/page, assembly de receipts/facts y faults. Añadir registro compose mediante coordinador; conservar exports actuales de output schemas |
| Nuevo `src/mcp/composition-contract.ts` | Tipos cerrados de EvidenceSet, tablas, Part, relaciones, conexiones, issues, requests/receipts/full; sin I/O |
| Nuevo `src/mcp/composition-normalize.ts` | `normalizeSource(source: ExecutedSource): EvidenceSet`; siete adaptadores exhaustivos, remapping índices y clasificación de origen de evidencia; sin inferir relaciones |
| Nuevo `src/mcp/compose-evidence.ts` | `mergeEvidence`, `materializeEvidence`, `validateCompositionReferences`, generación única de claves/IDs/guards y reglas de §§5–6; sin I/O ni ejecución de queries |
| Nuevo `src/mcp/composition-schema.ts` | `COMPOSE_INPUT`, `COMPOSE_OUTPUT`; esquemas runtime completos de la unión y tablas, refinamientos wire/integridad estructural, límites de request |
| Nuevo `src/mcp/compose-request.ts` | `runComposition(input: ComposeInput, ctx: QueryExecutionContext): Promise<Result<CompositionResult, ComposeFault>>`; preflight, dedup/orden de consultas, deadline/cancel, acumulación, verification y descriptors/requests. `CompositionResult` es la unión independiente del modo que el renderer recibe, no `CallToolResult` |
| Nuevo `src/mcp/render-composition.ts` | `renderComposition(result: CompositionResult, mode: ResponseMode): string`; proyección compacta y guía de full, sin joins ni inferencia |
| Existentes `recovery.ts`, `compact-schema.ts`, `presentation.ts`, `presentation-guidance.ts` | Reusar preparación de recovery; agregar guía de composición sin fingir exhaustividad; distinguir familia analítica de operación de presentación nueva |
| Existentes `src/composition/compose.ts`, `mcp.ts` | Normalmente sin cambio de puertos ni cachés. Cambiar solo si una extracción necesita pasar dependencias ya existentes; no inyectar VCS/graph/raw source a MCP |

No se mueve el motor de normalización al dominio: es una proyección de múltiples hechos públicos del transporte, consume puertos/tipos de varias familias y no debe cambiar las consultas de dominio. Tampoco se añade una nueva Query port universal. Los auxiliares puros permanecen en `src/mcp` con pruebas; MCP ya puede depender de ports/domain según las reglas de capas.

`ToolFamily` continúa enumerando las siete familias analíticas. Añadir `McpOperation = ToolFamily | "compose"` solo donde descubrimiento/guías lo necesiten; `ResponseMode` se reutiliza sin convertir compose en una familia con `Fact<T>` ni añadirlo a los Record exhaustivos del dominio por accidente.

### 9.2 Versiones y compatibilidad

- Nuevos discriminantes `composition` / `composition-receipt`, `compositionSchema:1`, IDs s1/r1/v1/f1/a1/e1/p1/n1/l1 y `mcp-c1`. No reutilizar `projectionSchema:1`, `mcp-r1` ni `mcp-p1` para otro propósito.
- `Fact.schema` permanece en el valor actual; no hay migración de fixed layers ni de fuentes almacenadas. Los consumidores originales reciben exactamente sus contratos anteriores.
- Soportar explícitamente los contratos de dominio presentes al implementar; una versión de schema desconocida o un campo obligatorio de variante no representable produce fallo interno de adaptación, no un `unknown` inventado. Las pruebas de conservación obligan a revisar nuevos campos opcionales.
- La guía compacta nueva debe publicar discriminantes, tipos de IDs, tablas/atestaciones, estados, queries cerradas, límites, estrategias pinned/fresh y exclusión de select/page. Su texto declara la aproximación. El validador Standard Schema completo gobierna siempre.
- La extracción de inputs no debe degradar los esquemas de herramientas originales ni aumentar innecesariamente su descubrimiento. No se promete paridad exhaustiva entre guía compacta y runtime: se prueba la estructura publicada y el rechazo runtime de combinaciones inválidas antes de ejecutar.
- README, RFC-0005 y docs de compacción describirán ocho operaciones MCP y siete familias, la opción de componer, su coste de replay/fresh-read y sus límites. ADR-0022 se cita como estrategia conservada; una nota explícita explica la operación adicional, sin reescribir historia como si ya hubiera estado aprobada.

## 10. Validación y significado medible de «optimizar»

### 10.1 Métricas sobre preguntas y snapshots equivalentes

Comparar el baseline de consultas originales en sus modos pertinentes con compose summary/details/full para **la misma evidencia de entrada**. En el baseline se incluyen ambos canales que el cliente puede exponer; se registran por separado y juntos. Medir inicialización/discovery, requests, responses, repeticiones/replay necesarios, wall time y pico de memoria. No confundir bytes UTF-8 con tokens ni tiempo de caché con ahorro de formato.

| Dimensión | Medida / criterio |
|---|---|
| Repetición estructural | Número de anchors/evidence/relaciones repetidos y objetos únicos; fixture con L1 repetido debe tener 1 relación y todos sus supports, y Evidence idéntico 1 objeto |
| Tamaño/coste | Bytes completos y por canal, overhead de recipes/provenance y coste total de investigación; tokens solo si se dispone del tokenizer del consumidor exacto, identificado en informe |
| Conservación/grounding | Todos los campos/relaciones/unknowns/cortes relevantes del conjunto fuente permanecen representables; 0 conexiones fabricadas en los casos adversos |
| Legibilidad operativa | El consumidor identifica sujetos, coordenadas, relación/basis, owners y limitaciones de cada hallazgo sin un join de arrays externos para entender details |
| Synthesis | Claims apoyados, citas resolubles, recall de los hechos requeridos, incertidumbre localizada, ausencia de falsa causalidad y opciones de decisions fieles |
| Robustez al orden | Identidad/forma canónica iguales al permutar un conjunto fijo; respuesta LLM puede cambiar de prosa, debe conservar claims y grounding requeridos |

No se fija un porcentaje arbitrario de reducción. El fixture de **solapamiento deliberado** debe reducir bytes de details frente a concatenar los mismos details originales conservando todos los hechos requeridos; esto es una aceptación local verificable. Las preguntas sin solapamiento pueden crecer por provenance/refs; el informe debe mostrarlo y la guía permitirá usar herramientas individuales. No se permite optimizar una cifra ocultando structuredContent, suprimiendo limits o comparando cobertura menor.

### 10.2 Matriz mínima de pruebas

- Cada uno de los siete adaptadores: known, unknown y partial donde su contrato los permite; nested entrypoint findings, UI component/basePath unknown, módulos base/head, opcionales importers, decisiones con evidence vacía y con basis/recommended distintos.
- Identidad positiva y negativa: mismo repo/snapshot, repo diferente, SHA diferente, SHA vs live, mismo head/stateId distinto, vector parcialmente coincidente, scope/targets/changed/budget diferentes, trust/producer/engine/typeRoot/membresía/gateways diferentes y redacción que hace colisionar strings.
- Unión: permutations de pares y triples con solapamiento real y todos los parentizados para tres sets; idempotencia con duplicates de consultas y de evidencia; aliases que se vuelven ambiguos al añadir una tercera fuente.
- Transferencias dependientes reales: entrypoints→outline→callers usando cada salida anterior; impact→callers; importers→outline; link destination→outline/callers con owner/snapshot **del link**; incluir owner no disponible. Separar este orden de adquisición de permutar evidencia ya obtenida.
- Integración real MCP: ocho operaciones, siete familias en una composición, todos los modos, runtime validation, errores y cancelación. Sesiones nuevas y calientes con cache/index/trust/scratch aislados; `offline:true` donde aplique; ningún remoto real ni trust del usuario.
- Intercalar llamadas originales no relacionadas y selección/page entre primera composición y repetición, sin utilizar estado retenido. Cambiar solo live/config/producer/membresía en casos controlados y comprobar fallo o partición explícita.
- Pruebas de formato verifican contenido semántico, referencias y conteos; no snapshots completos de prosa ni aserciones dependientes de un heading exacto. La prueba de estabilidad puede comparar canonical JSON de datos deterministas, no redacción LLM.

### 10.3 Evaluación del agente consumidor

T7 definirá un corpus cerrado con expected claims, claims prohibidos, Evidence/Relation/Part IDs válidos, unknowns y criterios de legibilidad. Incluir al menos estos seis casos: handler+outline, cambio+dependencia duplicada, imports frente a símbolos, workspace link con corte/destino no servido, decisions con opciones conflictivas, snapshots/live incompatibles. Un caso adicional contiene las siete familias con soporte solapado real.

El mismo consumidor/modelo/configuración recibe baseline y composición en orden contrabalanceado; tres permutaciones de las fuentes y dos ejecuciones por condición detectan variación básica sin llamarse prueba estadística de generalización. Registrar modelo y versión disponibles, instrucciones, datos/pins, orden, respuestas crudas, coste expuesto y adjudicación. No requerir prosa idéntica. Una cita válida debe resolver al soporte que realmente demuestra su claim; compartir ubicación no basta para aprobar causalidad.

La evaluación distingue `pass`, `fail`, `not_evaluated`. Cualquier conexión fabricada, rotura inferida solo por reach, desconocido presentado como vacío, cruce de snapshots o opción de decisions inventada es fail. Las diferencias de legibilidad/recall y tamaño se informan por caso; no se sustituyen por un único score favorable. Si no hay acceso autorizado a un consumidor LLM, la herramienta puede estar verificada estructuralmente pero la utilidad de síntesis queda `not_evaluated`; no se anuncia como probada.
