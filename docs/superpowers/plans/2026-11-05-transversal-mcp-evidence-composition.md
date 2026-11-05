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

El checkout compartido avanzó durante el análisis: de `b17e4ca37e82de1a0c27303f98d9914a6d8faca7` a `fe153d5110b65bac1ecca280949c1bc905f069e5`, y durante la revisión a `98b9cc5e9a81010b632aa34f2424122f06080a58`. Había además modificaciones de análisis/resolución de llamadas de otro trabajo. Se inspeccionó el delta posterior de server/compact-schema: reducción editorial de discovery, definiciones alcanzables y separación de analysis summary, conservando la estrategia de schemas runtime. El match del snippet anterior es evidencia puntual de frescura, no un hash del checkout final. Las líneas de este plan son ayudas de navegación; los símbolos y contratos son la referencia estable. Antes de T1 hay que comprobar nuevamente HEAD y el diff, sin revertir trabajo ajeno.

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

Las claves internas de deduplicación de queries pueden contener argumentos originales, pero nunca salen del proceso. `queryKey` en faults es `q1:<ordinal>` de la secuencia única ordenada y puede acompañarse de los índices originales de entrada; no es el hash de argumentos potencialmente secretos. Si dos invocaciones distintas terminan en el mismo SourceId autorizado, se conserva una sola fuente y se elige su RepeatRequest por menor canonical JSON de receta pública. No hay «primero gana» para datos semánticos ni recetas elegidas según el orden de entrada.

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

Las salidas privadas del core se filtran antes de construir `SourcePayload`; el tipo workspace público elimina `repositories`, y `PublicRead` elimina `repositorySources`. El guard de redacción tiene `{changedIdentityPointers:readonly string[], changedArguments:boolean, changedSnapshot:boolean}`: solo pointers/cambios, sin valores privados; los pointers refieren a posiciones públicas, nunca a claves secretas originales. Si la redacción de claves impide ese mapping, se marca el owner entero afectado. `QueryExecutionDeps` se define en el runner con los seis puertos actuales más redaction/digest; `McpDeps` lo extiende y añade version/bindings. `QueryExecutionContext = {deps:QueryExecutionDeps,catalog:ReturnType<typeof repositoryCatalog>,signal?:AbortSignal}`. Así el runner no importa server y no crea un ciclo de tipos. `QueryFault` es la unión de los faults actuales de esos puertos, `RepositoryTargetFault` e `internal-fault`. `ExecutedSource = SourcePayload & { query:SemanticQuery; recovery?:Recovery; identityGuard:RedactionIdentityGuard; live?:LiveStaleNotice }`. El runner captura el callback onStale local en ese último campo; `workspaceLive`, roots y refresh permanecen en PublicRead. No se pierde la noticia local al extraer `answer`.

Se conservan todos los reads **expuestos** por esos contratos. Un digest de inputs no se decodifica como provenance adicional. En particular, DecisionValue publica el vector pero no las secciones/inputs de cada repositorio: conocer su SHA no revela su trust ni su cobertura. No se atribuye el trust del trigger a evidencia extranjera. Esa evidencia puede compartir una coordenada física verificada, pero una conexión semántica que requiera el contexto extranjero ausente queda bloqueada y se informa context-mismatch/unavailable. No se introduce una consulta extra implícita para completar ese contexto.

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
  id: EvidenceId; origin: EvidenceOrigin; repo: string;
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
      reason: "ambiguous" | "redacted" | "conflicting-coordinate" | "missing-provenance" };
```

Los strings de `pointer` son JSON Pointers de salida generados por el adaptador (RFC 6901, escapado `~0`/`~1`). Localizan el soporte en el hecho público original, por ejemplo `/value/sections/shop/value/impact/symbols/2`. No son un selector ejecutable suministrado por el cliente. Índices y pointers siempre se interpretan junto al `SourceId`; no son IDs globales de entidades.

Las tablas son:

| Tabla | Campos obligatorios / significado |
|---|---|
| `snapshots` | `{id, value: SnapshotRef, identity:"exact"|"redacted"}`; una representación por snapshot exacto. Un valor de identidad alterado por redacción se marca redacted, se mantiene local a su source y no participa en joins |
| `sources` | `{id, family, branch?, rootRead, snapshotVector, requestIndex}`; `branch` solo impact/callers; vector actual completo y ordenado por repo |
| `reads` | `{id, source, owner: CutOwner, schema, producer, inputs: FactInputs, snapshot, evidence: EvidenceId[], analysis}`; `analysis` es unión complete / partial con `cuts: Cut[]` no vacíos / unknown con reason. Añadir `readKind` en owners `read` usando `RepoImpact.reads[].kind` |
| `files` | `{id, repo, origin:EvidenceOrigin, path, supports}`; origin snapshot identifica coordenada física; origin query-context conserva un path cuyo snapshot falta, sin autorizar joins. Ninguna forma afirma existencia o indexación por el mero hecho de nombrarlo |
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
| `seed` | `{anchor: AnchorId, basis: SeedBasis, comparison?: ComparisonRef}`; un target requested no se llama cambio. `ComparisonData = {repo:string, mergeBase:string, head: SnapshotId}` solo cuando el impacto registra merge base; `ComparisonRef` discrimina available/unavailable como se fija en §8 |
| `symbol-reach` | `{anchor: AnchorId, kindName: ImpactedSymbol["kind"], depth, confidence, fanIn, via?: ViaData}`; `ViaData = {target: SymbolNameRef, lines?: readonly number[], basis: DependenceBasis}`. Las líneas pertenecen al símbolo alcanzado, no al destino |
| `entrypoint-reach` | `{kindName: ReachedEntrypoint["kind"], name?: string, handler: AnchorId, depth:number, confidence:number, seeds: OriginReference[]}`; convertir los índices usando la tabla de semillas del mismo owner, conservando el índice original |
| `entrypoint-change` | `{change: ChangedEntrypoint["change"], kindName:ChangedEntrypoint["kind"], name:string, handler: AnchorId, comparison: ComparisonRef}`; removed usa merge base; added/altered, head. Altered no aporta la coordenada anterior |
| `module-origin` | `{comparison: ComparisonRef, file: string, change: ModuleOrigin["change"]}`; describe un diff, sin inventar existencia en head para deleted |
| `module-reach` | `{file: FileId, side: ReachedModule["snapshot"], depth:number, origins: OriginReference[], via?: ReachedModule["via"]}`; base resuelve merge base del owner, head su snapshot. Los índices de origins nunca se buscan en seeds |
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

`OriginReference = {status:"present",index:number,part:PartId}|{status:"missing",index:number}`. Las relaciones origin solo se construyen para present; una referencia inválida conserva el número que el hecho registró y emite missing-origin-reference. No se reindexa a cero, no se elimina del conteo de referencias registradas y no provoca una referencia wire colgante.

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

Para un `Evidence` local, el owner leído suministra repo/snapshot. Para `RepositoryEvidence`, resolver su `repo` en el vector de esa fuente; no usar el snapshot del trigger. `EvidenceRecord.repo` conserva ese propietario aunque el origen sea query-context; `value` contiene los campos de Evidence sin duplicar repo. Si falta o contradice el vector, conservar `origin:{kind:"query-context",read}` y emitir `missing-provenance`; no inventar un SHA.

Una opción de decisions con `basis:"origin"` está respaldada por la configuración externa que `buildDecisions` leyó, aunque señale `.git/config:1`. Su evidencia se marca `query-context`, nunca `snapshot`. Las decisiones de trust/membresía/revisión también conservan su contexto de lectura; sus options sin evidence no se rellenan. El resto de evidence code/config de repositorio solo usa `snapshot` cuando el vector lo identifica. Esta clasificación viene del tipo/kind/basis del productor, no de regex del path.

La deduplicación de `Evidence` exige igualdad de origin, repo y del objeto completo; una coordenada de commit y una evidencia de contexto externo no son el mismo soporte. `shares-evidence` solo expresa coincidencia del soporte, nunca causalidad entre los hallazgos que lo citan.

## 5. Parte B: unión, identidad y compatibilidad

### 5.1 Identidad y límites de deduplicación

| Objeto | Clave canónica y guards |
|---|---|
| Snapshot | Todos los campos de `SnapshotRef` en canonical JSON. No acortar SHAs ni stateId para comparar |
| Archivo | Origin snapshot + path relativo exacto; sin snapshot demostrado, query-context + repo + path es solo una referencia local sin join transversal. Sin case-folding, basename, realpath de archivos analizados ni resolución de symlinks añadida |
| Anchor declarativo | FileId + symbol literal + line + presencia/valor de endLine. El nombre simple solo se usa dentro de `joinsFact`, no como identidad global |
| Declaración outline | FileId + name + line + endLine + kind. Si una misma fuente conserva varias apariciones indistinguibles, registrar ambigüedad: el ID interno fue proyectado fuera y no puede recuperarse por adivinación |
| Entidad declarativa sin outline | Anchor exacto, o el span exacto (FileId, inicio y fin) cuando dos grafías lo nombran y una es el segmento final de la otra. Nunca fusionar dos nombres calificados distintos ni anchors sin fin |
| Entidad con outline | Declaración outline única y anchors que pasan `joinsFact` y los guards de esta sección. Las grafías originales permanecen en anchors; se presenta una entidad con aliases respaldados |
| Entrypoint | Snapshot y campos de identidad de su unión discriminada: HTTP method/path/version/handler; UI path/outlet/component; listener protocol/destination/handler; job trigger/handler. `basePath`/guards son observaciones conservadas, no strings borrados. Un reached entrypoint con información menor se conecta solo a un candidato único |
| Evidence | Origin exacto + repo + `canonicalJson(Evidence)`; union de supports. Dos citas del mismo sitio no son dos confirmaciones independientes |
| Relación | Kind, endpoints canónicos y basis/calificadores semánticos. Cada atestación conserva su contexto requerido; contextos incompatibles no se funden en una afirmación conjunta. La ubicación y confidence del testigo no se maximizan |
| Decision | Contexto de lectura + `Decision.id` + contenido de gap/opciones; conflictos de opciones quedan como variantes de contexto, sin unión de recomendaciones |
| Parte | Discriminante + payload tipado con refs y contexto semántico aplicable; supports se unen como conjunto. El orden de colecciones con semántica propia se conserva |

Los IDs son `prefix + Digest.of(canonicalJson(["mcp-composition-v1", kind, key]))`. `SourceId` usa familia/branch, contexto semántico normalizado y el hecho público redactado completo antes de normalizar; incluye schema, producer, inputs, value/status/reason y provenance. Para las tres familias con recovery se reutiliza la preparación del contexto existente, sin cambiar `mcp-r1`. Las otras cuatro normalizan repo seleccionado, snapshot/vector y scope/config efectivos; usan files/targets de declaredConfig cuando existen, no otro normalizador. La selección revision/HEAD se sustituye por el snapshot actual para identidad; las elecciones de membresía/source y política offline se conservan con su contexto efectivo. Se excluyen roots absolutos y sidecars de frescura, no membresía, trust o provenance. Los paths explícitos de membresía se representan para identidad mediante los IDs y la declaración efectiva del contexto, sin publicar un hash del path ni borrar su efecto de selección.

`ReadId` incluye SourceId y owner; no se inventa la equivalencia de dos lecturas por compartir snapshot. `PartId` puede compartir representación entre fuentes cuando payload y contexto lo permiten; sus supports retienen todas las apariciones públicas. Excepción necesaria: una parte `workspace-link` usa `SourceId + owner + pointer` para su ID antes de resolver reach. Después se completan sus referencias mediante un índice de Link.id del mismo source; esto permite self/cyclic reach sin intentar calcular un hash recursivo de PartIds. Las relaciones workspace-match deduplican sus valores independientes de esos reach/observaciones. Los arrays de referencias de `outline-file`, origins, evidence findings y reach mantienen el orden y multiplicidad originales. Deduplicar el objeto referenciado no borra la diferencia entre una aparición repetida en una fuente y el mismo soporte aportado por dos fuentes.

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

1. Construir candidatos outline por archivo exacto y snapshot de identidad exacta. Una File con origin query-context o un snapshot redacted no produce candidato transversal. Retener duplicidad dentro de una fuente como ambigüedad potencial.
2. Aplicar `joinsFact` al anchor y al candidato (`name`, `startLine=line`, `endLine`). Si el handler incluye una anotación anterior al inicio que reporta outline, se permite la comprobación inversa: la línea outline debe estar dentro del span explícito del handler, con el mismo archivo y nombre simple exacto comprobados por `joinsFact`. No se usa solo solapamiento ni solo nombre. Exigir un único candidato y compatibilidad; si varios spans anidados lo aceptan, no elegir el más pequeño implícitamente.
3. Exigir el mismo final conocido de declaración; si discrepa, conservar valores y emitir `conflicting-coordinate`, sin binding único. En los tipos cuyo contrato dice que omitir endLine representa una línea, su final efectivo para este guard es line, manteniendo el campo omitido en wire. Distintos inicios por anotación son compatibles solo con la comprobación de span anterior y el mismo final; se conservan ambos anchors originales y se usa la declaración outline como identidad canónica, sin reescribir la observación del otro productor.
4. Unir anchors iguales y aliases demostrados con esa declaración. Sin outline, igualdad exacta de anchors, o de span exacto con un solo nombre calificado. Un campo redactado bloquea el join transversal aunque dos strings redactados coincidan.
5. Resolver `ViaData.target` solo contra declaraciones/seeds/símbolos del **mismo read propietario** que identifican un destino único por file y symbol literal. Si ese read no lo resuelve, puede anotarse un candidato outline único compatible, pero la relación se marca `endpoint-resolved-from-outline` y conserva ambos soportes. Nunca usar solo el último segmento para elegir entre varios destinos.

Si el modelo público no permite separar dos declaraciones idénticas en línea/nombre/span, el resultado es `ambiguous`, no una afirmación de identidad perfecta. Exponer GraphNodeId de manera transversal requeriría otro cambio de contrato y no es necesario para esta versión. La limitación queda sometida a prueba en T3.

### 5.4 Unión algebraica y orden

`normalizeSource(source: ExecutedSource, digest: Digest): EvidenceSet` produce observaciones inmutables con sus contextos. `mergeEvidence(left: EvidenceSet, right: EvidenceSet): EvidenceSet` hace unión por claves canónicas de esos datos; no renderiza, resuelve aliases ni elimina conflictos. `materializeEvidence(set: EvidenceSet, digest: Digest): MaterializedComposition` calcula bindings, relaciones, conexiones e issues a partir del conjunto entero; `MaterializedComposition = {graph:CompositionGraph,issues:readonly CompositionIssue[]}`.

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
| `shares-evidence` | Todas las partes (dos o más) que citan el mismo EvidenceId de origin exacto, en una sola relación con el conjunto de sus reads | No establece causalidad, equivalencia de hallazgos ni independencia estadística de soportes |

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
  | { kind: "shares-evidence"; parts:readonly PartId[]; evidence:EvidenceId }; // dos o más, ordenadas
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
- `shared-support`: dos o más hallazgos comparten evidencia exacta (una conexión por ubicación); útil para relacionar workspace/decisions sin interpretar strings de subject/option como identidades de código.

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

`CoverageSummary` tiene `{reads:{complete:number,partial:number,unknown:number}, unknowns:{source:SourceId,owner:CutOwner,reason:UnknownReason}[], limits:{source:SourceId,owner:CutOwner,kind:Cut["kind"],limit?:number,cuts:number,places:number}[], issues:CompositionIssue[]}`. Los conteos son de **lecturas registradas**, incluyen owners anidados y no se presentan como análisis independientes ni huecos disjuntos. Los findings/component desconocidos se conservan en partes y tienen conteos separados definidos a continuación; no cambian artificialmente el status de su colección.

`CompositionCounts` contiene `{sources,reads,files,anchors,entities,evidence,parts,relations,connections,unknownFindings,unknownComponents}`; se cuentan objetos únicos de las tablas correspondientes. `unknownFindings` cuenta Finding.status unknown de entrypoints, basePath y target de call site; no vuelve a contar reads unknown. `unknownComponents` cuenta component unknown dentro de UI routes conocidas, que no es un Finding desconocido. `CompositionDelivery` agrupa por SourceId las raíces/freshness/resolution/live/workspaceLive públicas ya redactadas. No forma parte de la identidad ni de una prueba de atomicidad/frescura verificada. Summary/details muestran sus avisos materiales en texto; full conserva todos los sidecars públicos presentes, sin serializarlos otra vez en el texto.

`CompositionGraph` incluye las tablas de 4.2; `issues` se transmite una sola vez en `coverage.issues`, y el tipo de grafo interno puede referir esa misma colección sin duplicarla en wire. La entrada de cada read y source es autosuficiente para resolver todos los IDs que usan las partes/relaciones/conexiones de full. Un verificador de integridad comprueba cada referencia y cada owner; missing `reach` explícito es un estado permitido, no una referencia colgante accidental.

`CompositionIssue` lleva siempre `{sources:readonly SourceId[],reads:readonly ReadId[]}` más exactamente una de las siguientes ramas; no se añade una bolsa libre de detalles privados:

```ts
type IssueDetail =
  | {kind:"snapshot-difference";repo:string;snapshots:readonly SnapshotId[]}
  | {kind:"context-mismatch";field:"trust"|"producer"|"schema"|"engine"|"typeRoot"|"workspace";reason:"different"|"unavailable"}
  | {kind:"ambiguous-declaration";anchor:AnchorId;candidates:readonly PartId[]}
  | {kind:"conflicting-coordinate";anchors:readonly AnchorId[]}
  | {kind:"unresolved-endpoint";part:PartId;target:SymbolNameRef}
  | {kind:"missing-provenance";repo:string;part?:PartId;side?:"base"|"head"}
  | {kind:"missing-origin-reference";part:PartId;table:"seeds"|"module-origins";index:number}
  | {kind:"missing-link-reference";part:PartId;linkId:string;position:number}
  | {kind:"redacted-identity";owner:CutOwner;pointer?:string};
type CompositionIssue = {
  sources:readonly SourceId[];reads:readonly ReadId[];
} & IssueDetail;
```

Las arrays que representan sets de IDs de una issue/connection se ordenan antes de calcular keys. `ConnectionId` usa rule y refs de parts/relations/entities; supports no afectan su identidad y se unen como conjunto. Una issue no apunta a un candidato suprimido de full; si falta la coordenada, contiene solo los identificadores y el owner realmente conocidos.

`shared-support`/`shares-evidence` pueden declarar igualdad física de una evidencia sin igualar la interpretación de sus reads. Se etiquetan como coincidencia de ubicación/soporte y preservan context-mismatch cuando procede; las conexiones que atribuyen dependencias, origen de cambio o alcance siguen requiriendo los guards semánticos completos.

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

Para que la forma tipada siga siendo válida en ese caso, sus coordenadas usan FileIds con `origin:query-context` y AnchorIds locales a ese read; esos archivos son referencias locales, no identidades físicas globales. Si una parte necesita `ComparisonData` pero no se registró mergeBase, no fabrica un comparison: retiene una variante `comparison:{status:"unavailable",reason:"missing-provenance",read:ReadId}`. La forma conocida es `comparison:{status:"available",value:ComparisonData}` en seeds cuando aplica, entrypoint-change y module-origin; las reglas change-dependent/base requieren la variante available. `ComparisonRef` es el alias de esa unión. Un módulo base o un removed handler sin base demostrada usa ubicación query-context y missing-provenance, nunca ubicación head. Esto conserva el dato relativo sin atribuirlo al head.

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
| Nuevo `src/mcp/composition-normalize.ts` | `normalizeSource(source: ExecutedSource, digest: Digest): EvidenceSet`; siete adaptadores exhaustivos, remapping índices y clasificación de origen de evidencia; sin inferir relaciones |
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

## 11. Plan de ejecución ordenado

Todos los comandos y resultados de esta sección son **futuros/esperados**, no evidencia de esta sesión de diseño. Antes de ejecutar: leer este documento completo, HEAD/status actuales y las instrucciones vigentes. Trabajar sobre los cambios integrados del checkout, sin restaurar versiones antiguas de server/render ni tests de otros agentes. T1 no autoriza por sí misma ninguna modificación del motor de análisis.

Secuencia: **T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8**. T2/T3 mantienen privados los contratos hasta que T4/T5 puedan publicarlos completos. Las tareas pueden revisarse por sus entregables; no se mezclan autores simultáneos de `server.ts`. El responsable de integración es el único propietario de ese archivo durante cada paso. No se requiere hacer commits para comprobar una tarea; Git/publicación sigue sujeto a la autorización de la sesión ejecutora.

### T1. Un único despacho tipado compartido con las herramientas existentes

**Propiedad:** crear `src/mcp/query-schema.ts`, `src/mcp/query-runner.ts`, `src/mcp/query-runner.test.ts`. Modificar `src/mcp/server.ts`, `src/mcp/recovery.ts` solo para extraer/reusar la preparación actual, y los imports necesarios de `src/mcp/server.test.ts`. No extraer todos los output schemas ni cambiar sus exports.

**Consume:** `McpDeps`, `repositoryCatalog`, siete contratos actuales de input, puertos y las tres funciones Recovery actuales.

**Produce:** `SemanticArguments<F>`, `SemanticQuery`, esquemas semánticos/completos; `QueryExecutionDeps`, `QueryExecutionContext`, `ExecutedSource`, `QueryFault`; `executeQuery(query, ctx)` de §4.1. Los helpers internos de recovery siguen generando los mismos mcp-r1 y recetas. `answer` conserva selección, cursores, modos y canal de fallo.

- [ ] Escribir `query-runner.test.ts`: un spy de cada puerto comprueba forwards exactos en entrypoints, impact/callers local y workspace, importers, outline, workspace y decisions. Comprobar el `repo/path/repoId` seleccionado, targets/ranges, base/head/live, changed, scope, budget, offline/replay y signal. Incluir repo `constructor` y mismo archivo en dos roots.
- [ ] Añadir pruebas «sin despacho»: repo desconocido y combinaciones inválidas actuales (`revision+live`, replay sin workspace, select/page desparejados en originales). Las variantes semánticas rechazan mode/select/page/expect en su propio objeto.
- [ ] Añadir tests de frontera pública: eliminar `repositorySources` y workspace.repositories, conservar root snapshots/reads y sidecars públicos, idéntica redacción/recovery a las herramientas actuales; el guard detecta coordinates/argumentos redactados sin contener sus valores originales.
- [ ] Ejecutar `node --import tsx --test src/mcp/query-runner.test.ts`. **Esperado antes de implementar:** fallo por exports inexistentes, no por error de fixture.
- [ ] Implementar la extracción y adaptar las siete registrations a ese runner. Los callbacks antiguos no mantienen un segundo switch de despacho. `QueryExecutionDeps` vive fuera de server para evitar import circular. Mantener nombres/exports de `ENTRYPOINTS_OUTPUT`…`DECISIONS_OUTPUT`.
- [ ] Ejecutar `node --import tsx --test src/mcp/query-runner.test.ts src/mcp/server.test.ts src/mcp/repository-targeting.test.ts src/mcp/evidence-schema.test.ts src/mcp/compact-schema.test.ts` y `npm run typecheck` / `npm run arch:check`. **Esperado:** pasan; no cambios en modo/recovery/source de consultas originales ni nuevas dependencias de MCP a application/adapters.

**Entregable revisable:** un despacho común, comportamiento público original conservado y controles de redacción observables. No se anuncia compose todavía.

### T2. Normalizar las siete familias sin perder significado

**Propiedad:** crear `src/mcp/composition-contract.ts`, `src/mcp/composition-normalize.ts`, `src/mcp/composition-normalize.test.ts` y helper de pruebas `src/mcp/composition-fixtures.ts`. Crear el núcleo de claves puras en `src/mcp/compose-evidence.ts` que consumen los adaptadores; T3 continuará ese mismo archivo secuencialmente. No modificar core.

**Consume:** `ExecutedSource`, `Digest`, tipos de dominio/ports enumerados en §4.

**Produce:** todos los aliases cerrados de §§4–7, `EvidenceSet`, `normalizeSource(source,digest)`. El fixture exporta `sourceFixture(family, overrides)` especializado mediante overloads por familia, construido con tipos concretos. No añadir un helper `any` que salte los invariantes de los hechos.

- [ ] Escribir tests `normalizes every public family without presentation parsing`, parametrizados sobre las siete familias y ambas ramas de impact/callers. Assertions: todos los supports resuelven owner/pointer; no hay `value` para unknown; todos los arrays de evidencia originales se recuperan siguiendo sus refs, con orden y duplicados; producer/inputs/reads/cuts son exactos.
- [ ] Escribir casos de conservación significativos: HTTP basePath unknown; UI component unknown con guards/outlet; dos aliases del mismo handler; módulos base/head con seedIndex/originIndex distintos de cero; importers con `users` solapados, dynamic/type/reexport opcionales ausentes y presentes vacíos; outline.unheld; `CallSite.ancestors/stated`; links con self-reach y reach missing.
- [ ] Escribir `decision preserves all option semantics and context evidence`: distintos basis/recommended, options vacías frente a freeText, required, outwardKinds y evidencia origin `.git/config`. Esta última tiene origin query-context; evidencia de repo ajeno usa el snapshot de ese repo. Falta de snapshot genera missing-provenance y no un file/entity inventado.
- [ ] Ejecutar `node --import tsx --test src/mcp/composition-normalize.test.ts`. **Esperado inicial:** fallos por contratos/función faltantes.
- [ ] Implementar adaptadores exhaustivos, keys/refs y catálogo de fuentes/reads. Mantener cada aparición mediante supports/referencias ordenadas aunque se comparta su objeto. `module-origin` describe comparación, no existencia de archivo deleted en head. Index fuera de rango se conserva como issue con parte/contexto original, nunca apunta al origen cero.
- [ ] Añadir un test de conservación que en fixtures completos compara una proyección semántica reconstruida desde las tablas con el hecho público original; la proyección solo excluye duplicación de objetos/orden de claves y sidecars separados. Enumerar expresamente campos opcionales, no un test que replique el mismo switch del normalizador.
- [ ] Ejecutar `node --import tsx --test src/mcp/composition-normalize.test.ts` y `npm run typecheck`. **Esperado:** siete familias cubiertas, todos los campos/estados/asociaciones comprobados y ninguna lectura de texto/source añadida.

**Entregable:** partes tipadas completas con conservación demostrada; cero relaciones inferidas por los adaptadores.

### T3. Unión canónica, guards, relaciones y conexiones acotadas

**Propiedad:** completar `src/mcp/compose-evidence.ts`; crear `src/mcp/compose-evidence.test.ts` y `src/mcp/composition-properties.test.ts`; ajustar únicamente los tipos necesarios de `composition-contract.ts` en consonancia con este documento.

**Consume:** `EvidenceSet`, `Digest`, `joinsFact`, `compareText`, `canonicalJson` y reglas §§5–6.

**Produce:** `mergeEvidence(left,right):EvidenceSet`, `materializeEvidence(set,digest):MaterializedComposition`, `validateCompositionReferences(graph):Result<void,CompositionInvariantFault>`. `CompositionInvariantFault = {kind:"invalid-composition-reference",table:string,id:string,field:string}`; los valores son identificadores públicos. Las issues semánticas no son este fallo interno.

- [ ] Escribir `merges exact duplicate relation and unions provenance`: impact y callers sobre C→S producen una `symbol-dependence` con supports de ambos, un S, un C y una evidence idéntica; depth/confidence/fanIn/budget permanecen en las partes/reads de cada fuente.
- [ ] Escribir `handler joins unique outline through joinsFact`: nombre calificado del handler y nombre simple outline, archivo/snapshot exactos y span coherente; resultado una declaración. Añadir handler cuyo inicio incluye una anotación y outline empieza una línea después, con final idéntico: binding único y ambos anchors conservados. Casos negativos: homónimo en otro repo/snapshot, overloads, dos apariciones indistinguibles en una fuente, dos candidatos anidados válidos, distinto final efectivo (incluido endLine omitido), prefix/case diferente. No escoger «el primero».
- [ ] Escribir `unresolved via does not invent endpoint`: destino nombrado sin línea y varias declaraciones posibles mantiene `ViaData` y unresolved-endpoint; un destino único del mismo read u outline compatible obtiene su soporte completo. `basis:reference` no produce calls, `basis:call` no se etiqueta como llamada exclusiva frente a instanciación.
- [ ] Escribir tests base/head y module-only; Link.id repetido con snapshots distintos; profiles/basis distintos; named candidate no convertido en Link; categorías user/importer/unresolved distintas; evidencia compartida entre decisions/workspace solo produce shared-support cuando el origin es exacto.
- [ ] Escribir guards con snapshots/live/trust/producer/schema/engine/typeRoot/membresía/gateways diferentes, y scope/budget/targets distintos. Los positivos conservan todas las lecturas; los negativos no producen conexiones entre afirmaciones incompatibles. Incluir A(X=1), B(sin X), C(X=2): B no habilita una conexión A+C.
- [ ] Escribir propiedades sin librería nueva: generar permutaciones completas de tres sets pequeños con solapamiento real y de sus duplicados; probar ambos parentizados, commutatividad e idempotencia con `assert.deepEqual`. Añadir la tercera fuente que vuelve ambiguo el join; la materialización final es igual en todos los órdenes.
- [ ] Ejecutar `node --import tsx --test src/mcp/compose-evidence.test.ts src/mcp/composition-properties.test.ts`. **Esperado inicial:** funciones/reglas faltantes o assertion semántica fallida.
- [ ] Implementar unión de observaciones y materialización separadas. IDs/tablas/supports ordenados por claves; atestaciones conservan contextKey propio. No cierres transitivos, max confidence, suma de counts solapados, union-find irreversible ni parseo de Cut.at/via.
- [ ] Ejecutar los dos tests anteriores junto con `src/mcp/composition-normalize.test.ts`, typecheck y architecture. **Esperado:** igualdad canónica de sets compatibles, variantes incompatibles visibles y referencias completas.
- [ ] Probar sensibilidad en copia local temporal del cambio o mutación restaurada: quitar repo/stateId de la key, elegir primer candidato o convertir importer a call debe romper los tests correspondientes. Registrar el fallo observado y restaurar; no dejar mutaciones ni ejecutar esta técnica sobre trabajo ajeno.

**Entregable:** un solo algoritmo de acumulación y cinco reglas de conexión cerradas; no una matriz de pipelines por familia.

### T4. Invocación stateless, límites, verification y cancelación

**Propiedad:** crear `src/mcp/compose-request.ts`, `src/mcp/compose-request.test.ts` y `src/mcp/composition-schema.ts` con inputs y tipos output de modo independiente. Modificar `src/mcp/server.ts` para registrar compose solo cuando T5 complete su salida/guía. `server.test.ts` recibe tests públicos de la nueva operación; no cambiar puertos/core de decisions.

**Consume:** T1 executeQuery, T2 normalizeSource, T3 merge/materialize/integridad; recetas y faults originales.

**Produce:** `ComposeInput`, `ComposeQuery`, `COMPOSE_INPUT`, `runComposition(input,ctx):Promise<Result<CompositionResult,ComposeFault>>`, `CompositionResult = {graph,coverage,counts,verification,requests,delivery?}` con los tipos de §7. `ComposeFault` es la unión cerrada de §3.4; no se llama a otro MCP server dentro del servidor.

- [ ] Escribir preflight tests: 0/1/16/17 queries, bytes exactamente en/bajo/sobre 1.048.576 usando UTF-8 multibyte; nested mode/select/page; nombre desconocido/compose recursivo; expect mcp-r1 en outline; deadline inválido; dos expectations incompatibles. Spies prueban **cero despachos** en todos los casos inválidos. El test de bytes calcula el input completo, no asume un carácter = byte.
- [ ] Escribir `duplicate queries execute once and preserve assertions`: consultas idénticas con y sin expect ejecutan una vez y verifican el expect; assertions incompatibles fallan antes. Requests permutadas producen sources/graph/verification iguales para resultados inmutables.
- [ ] Escribir `uses public existing ports on every new call`: dos composiciones con los mismos argumentos ejecutan nuevamente los spies del runner, aunque el core pueda usar sus caches. Una sesión recién creada no necesita calentamiento ni handles previos.
- [ ] Escribir tests de faults/unknown/deadline/cancel: unknown se conserva sin partes ficticias; un fallo real de la tercera fuente entrega isError sin graph parcial; cancellation durante query bloqueada se propaga y no ejecuta la siguiente; timer/listener se limpia al terminar/fallar; tiempo agotado antes de entrega impide éxito. Core partial con deadline se entrega no afirmado con verification unavailable; expect falla.
- [ ] Escribir verification/repeat tests: mcp-r1 de las tres familias permanece igual y `requests` pinned incluye su assertion; las cuatro restantes son fresh con schema original estricto y sin replay inventado. Cambiar decisions.options por contexto externo cambia SourceId/CompositionIdentity; repetir con expect falla, sin retener el original. Una identity redacted collision produce fuentes separadas y verification unavailable sin valores/hashes secretos.
- [ ] Ejecutar `node --import tsx --test src/mcp/compose-request.test.ts`. **Esperado inicial:** falta de coordinador/validación; los tests de errores no pasan simplemente porque toda consulta falle.
- [ ] Implementar preflight, orden/dedup, ejecución secuencial, ceder al event loop, acumulación y limpieza. Preasignar ordinal de consultas únicas para identidades redactadas; ordenar/depurar requests por source al producir la salida. Calcular identidad con source IDs únicos, no con índices de input ni timestamps. Comprobar sources expect y composición expect antes de emitir contenido.
- [ ] Ejecutar `node --import tsx --test src/mcp/compose-request.test.ts src/mcp/query-runner.test.ts` y typecheck/architecture. **Esperado:** todos los caminos verificados; ninguna API de retention, trust write, decisions replay o source reader añadida.

**Entregable:** invocación utilizable que obtiene sus propios resultados autorizados; el mismo input completo permite recalcular sin estado final oculto.

### T5. Contrato wire, modos compactos y navegación a fuentes

**Propiedad:** completar `src/mcp/composition-schema.ts`; crear `src/mcp/render-composition.ts`, `src/mcp/render-composition.test.ts`, `src/mcp/composition-schema.test.ts`. Modificar `src/mcp/server.ts`, `compact-schema.ts`, `compact-schema.test.ts`, `presentation.ts` y `presentation-guidance.ts` solo en su nueva superficie compose. Las siete familias y sus renderizadores mantienen comportamiento.

**Consume:** `CompositionResult`, tablas/refs e issues materializadas; `ResponseMode`, presentation sharing/contexto existentes y las requests de T4.

**Produce:** `COMPOSE_OUTPUT`, `renderComposition(result,mode):string`, formas ComposeReceipt/ComposeFull y una guía compacta de compose. `compactOutput` distingue `McpOperation` de `ToolFamily` y usa una guía especializada para compose sin contaminar los Records de familias analíticas.

- [ ] Escribir schema tests con Ajv SDK y el Standard Schema original: full válido conserva todas las tablas; receipt no aparenta un Fact; rechazar read unknown sin reason, partial sin cuts, evidencia de snapshot sin origin, parte/conexión sin refs/soporte, option sin recommended y snapshots live incompletos. Las integridades entre IDs se verifican además mediante `validateCompositionReferences`, sin inventar keywords Draft-7.
- [ ] Escribir renderer tests por hechos/IDs: handler+outline se presenta una vez con aliases y evidencia; L1 duplicado tiene una relación y ambos supports; importers y reference quedan distintos; snapshots/live incompatibles se declaran; unknown/partial/cortes/decisions options son legibles. Details declara todos los IDs de sujetos que cita, y el full text no repite sus tablas.
- [ ] Escribir test de contenido omitido: cada categoría de soporte omitida en summary/details tiene conteo registrado y navegación válida. La ruta original select/page solo se sugiere cuando requests lleva recovery mcp-r1 aplicable; outline/source text y decisions replay no se sugieren. Summary y details pueden coincidir si no hay evidencia adicional útil.
- [ ] Escribir fixture de solapamiento deliberado: `blockBytes(composeDetails) < blockBytes(concatenatedOriginalDetails)` y todos los hechos/unknowns requeridos siguen presentes por assertions de significado. No aplicar el umbral a casos sin solapamiento ni a size total de distinta cobertura.
- [ ] Ejecutar `node --import tsx --test src/mcp/composition-schema.test.ts src/mcp/render-composition.test.ts`. **Esperado inicial:** output/renderer faltantes.
- [ ] Implementar schema runtime completo y los tres modos. Full assembly expone `graph.sources` una sola vez; receipt expone descriptors/requests/coverage sin referencias que aparenten una tabla disponible. Reusar igualdad exacta y `preferShorterText`; no aplicar truncado/top-N ni mezclar análisis/cobertura con modo.
- [ ] Publicar compose con readOnlyHint/openWorldHint coherentes, input estricto y guía aproximada declarada. Probar que una combinación que pasa la guía pero viola runtime no ejecuta queries. Registrar bytes del catálogo antes/después; los budgets históricos no se inflan sin documentar el incremento concreto de esta operación.
- [ ] Ejecutar `node --import tsx --test src/mcp/render-composition.test.ts src/mcp/composition-schema.test.ts src/mcp/server.test.ts src/mcp/compact-schema.test.ts src/mcp/presentation-guidance.test.ts` y typecheck/architecture. **Esperado:** contratos originales válidos y nueva operación coherente en ambos canales.

**Entregable:** resultado autosuficiente en details y exhaustivo en full; identidad y procedencia se entregan una sola vez en sus tablas/canales correspondientes.

### T6. Integración real MCP y pruebas de adquisición/orden en frío y caliente

**Propiedad:** crear `src/composition/mcp-evidence-composition.e2e.test.ts`. Reutilizar helpers existentes de sesión/stdio y patrones de fixtures de `mcp.e2e.test.ts` y los dos audits, sin convertir sus límites históricos en afirmaciones universales ni modificar sus resultados anteriores.

**Consume:** nueva herramienta registrada y las siete originales; Git y composed queries reales en repositorios temporales.

**Produce:** pruebas de comportamiento sobre el transporte MCP y un fixture autocontenido con dos repositorios, dos SHAs base/head, Spring entrypoints, TS consumer/imports/calls, nombre externo no servido, decisiones verificables y trust stores aislados.

- [ ] Escribir un test que arranca stdio y pide todas las siete familias dentro de compose, más cada consulta original full. Comparar hechos relevantes normalizados contra sus fuentes exactas; no comparar solo conteos o buscar `GET` en un string. Comprobar semántica de options/basis/recommended/freeText/required de decisions, no únicamente igualdad entre dos lecturas.
- [ ] Ejecutar `node --import tsx --test src/composition/mcp-evidence-composition.e2e.test.ts`. **Esperado inicial contra baseline sin compose:** tool desconocida; si ya está implementada, introducir primero la assertion nueva que falle por la laguna concreta, sin fabricar un fallo de harness.
- [ ] Añadir adquisiciones completas entrypoints→outline→callers, impact→callers e importers→outline tomando los argumentos de cada respuesta. Añadir **desde Link.to**, no desde entrypoints, la transferencia a outline y callers extranjeros usando snapshot del repo destino. El catálogo incluye roots distintos con el mismo path relativo; un destino ausente produce la limitación/fallo declarado.
- [ ] Para el conjunto independiente ya fijado, probar las 5.040 permutaciones de siete fuentes **en la función pura** con evidencia real capturada una vez, no 5.040 procesos/indexaciones. Para transporte, ejecutar tres órdenes representativos (original, inverso, intercalado por repo) en sesiones frías y calientes, y ambos parentizados de un triple con soporte compartido.
- [ ] Congelar SHAs completos, repo IDs, membresía/gateways, scope, budget/targets/changed y offline. Para cada sesión fría crear nuevos directorios index/cache/scratch; para caliente repetir en la misma instancia. Si cambia `inputs.origin`, comprobar y registrar la diferencia de provenance y verificar el grafo semántico compatible por separado; no borrarla de la identity ni llamarla contradicción factual.
- [ ] Intercalar selección/page originales y una consulta ajena antes de repetir compose; pinned recipes/expect deben seguir verificándose sin handles. Con trusted live aislado, cambiar un archivo entre capturas: se obtiene snapshot-difference o falla expect, nunca unificación por head. Bajar trust o cambiar membresía invalida replay conforme a los puertos originales.
- [ ] Añadir prueba pública de cancelación y salida tras error de consulta; verificar que el proceso responde a otra llamada después y que no permanecen recursos temporales/locks de la operación abortada.
- [ ] Ejecutar `node --import tsx --test src/composition/mcp-evidence-composition.e2e.test.ts src/composition/mcp.e2e.test.ts src/composition/mcp-local-composition.audit.test.ts src/composition/mcp-workspace-composition.audit.test.ts`. **Esperado:** pasan los casos nuevos y regresiones; resultados acotados al fixture. No reutilizar los «13 passed» históricos como salida de este comando.

**Entregable:** evidencia de invocación real y de transferencias dependientes, separada de la invariancia de acumulación y de las variaciones reales de contexto.

### T7. Medir coste completo y síntesis respaldada del consumidor

**Propiedad:** crear `scripts/evaluate-mcp-composition.ts`, `scripts/evaluate-mcp-composition.test.ts`, `docs/evaluations/mcp-composition/README.md`, `docs/evaluations/mcp-composition/cases.json` y un directorio de resultados por run bajo `docs/evaluations/mcp-composition/runs/<run-id>/`. Reutilizar el fixture real de T6 mediante un helper de fixture de pruebas con propiedad explícita compartida secuencial; no copiar lógica de composición en el evaluador. No añadir un cliente/model SDK ni nuevas dependencias.

**Consume:** fuentes/composición actuales sobre SHAs equivalentes y rúbrica §10. El run-id lo elige el evaluador como nombre de artefacto; nunca entra en identities de evidencia.

**Produce:** corpus con `requiredClaims`, `forbiddenClaims`, coordenadas/IDs válidos, incertidumbres requeridas; mediciones JSON y prompts/respuestas/adjudicaciones inspectables. El script tiene dos modos concretos: `--prepare <out-dir>` genera inputs/prompts/métricas reproducibles; `--score <run-dir> --responses <responses.jsonl> --judgments <judgments.json>` valida integridad, citas y rúbrica. No llama automáticamente a servicios ni finge una evaluación LLM al generar prompts.

- [ ] Escribir tests del evaluador con respuestas controladas: cita inexistente, soporte que solo demuestra import pero claim dice call, reach que se declara breakage, unknown vacío, cruce live/snapshot y option recommended inventada deben fallar. Variantes de prosa con los mismos claims respaldados pasan; responses ausentes quedan not_evaluated. La adjudicación humana/LLM de significado no se sustituye por regex de prosa.
- [ ] Ejecutar `node --import tsx --test scripts/evaluate-mcp-composition.test.ts`. **Esperado inicial:** evaluador ausente.
- [ ] Implementar preparación con entradas y salidas completas, bytes por canal/discovery/request/response y costes del recorrido entero; wall time y memoria se etiquetan con caché/entorno. Definir el formato de `responses.jsonl` como `{caseId,condition,order,replicate,model,answer,claims:[{id,text,citations:[]}],uncertainties:[]}` y judgments por esos mismos IDs con verdict/motivo/soportes. Los IDs de claims pertenecen al corpus, no a regex sobre texto libre.
- [ ] Ejecutar `node --import tsx scripts/evaluate-mcp-composition.ts --prepare /tmp/ye-ast-composition-eval`. **Esperado:** artefactos con las siete familias, baseline/candidato equivalentes y métricas verificables; síntesis marcada not_evaluated hasta tener respuestas reales. Copiar a results los artefactos de evaluación autorizados, redactando cualquier dato de entorno privado.
- [ ] Evaluar con un consumidor autorizado usando exactamente prompts/condiciones §10.3, guardar respuestas crudas y adjudicar claims/citas/incertidumbre. No escoger un proveedor o credencial por inferencia del plan. Si la sesión no dispone de consumidor autorizado, dejar esta casilla pendiente y registrar esa limitación concreta.
- [ ] Ejecutar `node --import tsx scripts/evaluate-mcp-composition.ts --score /tmp/ye-ast-composition-eval --responses /tmp/ye-ast-composition-eval/responses.jsonl --judgments /tmp/ye-ast-composition-eval/judgments.json`. **Esperado con datos completos:** informe por caso/condición, fallos materiales visibles y ninguna afirmación de prosa idéntica u optimalidad general. El score no puede declarar pass de síntesis con archivos vacíos o faltantes.
- [ ] Comparar tamaño y grounding sobre solapamiento, no solapamiento, parcial y conjunto de siete familias. Ajustar solo presentación que no cambie evidencia si hay regresión; cualquier nueva semántica requiere volver a las tareas propietarias y a sus tests. No modificar la rúbrica para aprobar una conexión fabricada.

**Entregable:** evidencia separada de compresión estructural, coste total y utilidad del agente; los resultados no evaluados permanecen como tales.

### T8. Documentación de uso, migración y gate integrado

**Propiedad:** modificar `README.md`, `docs/architecture/rfc/0005-transports.md`, `docs/mcp-schema-compaction.md` y este plan únicamente para marcar ejecución/evidencia. Añadir una nota de ampliación junto a ADR-0022 si el responsable de arquitectura lo exige en implementación; no reescribir su decisión histórica ni crear un prerequisito oculto. No tocar las ramas de documentación concurrentes sin integrar primero su contenido.

**Consume:** comportamiento final y resultados observados de T1–T7.

**Produce:** documentación que un consumidor puede seguir con una sesión MCP nueva, comando y contrato de compose, siete familias/ocho operaciones, defaults/límites, ejemplos, pinned frente a fresh y recuperación original real.

- [ ] Documentar la adquisición de coordenadas antes de componer, ejemplos de §7, coste de repetir consultas, absence de source text y frontera de decisiones/trust. Nombrar las cuatro familias fresh sin sugerir select/page o replay de decisions.
- [ ] Registrar incrementos de tamaño de catálogo y resultados de T7 con fuente/modelo/fecha/coverage, sin atribuir al diseño pruebas históricas del lead o de otros auditores. Si síntesis sigue not_evaluated, decirlo en el informe de entrega y no marcar esa aceptación como completada.
- [ ] Ejecutar `npm run typecheck`, `npm run arch:check` y los comandos focalizados de T1–T7. **Esperado:** todos pasan; cualquier fallo baseline se identifica con evidencia y no se oculta como omitido.
- [ ] Ejecutar `npm run check` como gate final de implementación, una vez integrados todos los cambios, y `git diff --check`. **Esperado:** sin errores, tests pertinentes pasan. No ejecutar esta suite solo por editar el plan ni repetirla si no hay cambios/fallos nuevos.
- [ ] Revisar diff y API final: ningún puerto de escritura nuevo, caché de resultados, parsing de presentación, dependencia nueva, schema Fact modificado o lógica por pareja. Verificar que todos los pointers/refs de un full resuelven o están tipados explícitamente missing.
- [ ] Revisar cobertura de requisitos con la tabla siguiente y reportar exactamente lo ejecutado/no evaluado. No declarar composición óptima, cobertura universal ni aprobación de cambios de código a partir de la evaluación.

**Entregable:** cambio listo para revisión e integración conforme a la autorización de la sesión. Publicación/commit no se deducen de este plan.

## 12. Cobertura de requisitos → tareas y pruebas

| Requisito del encargo | Contrato | Tareas / prueba decisiva |
|---|---|---|
| A: identificar las partes de siete familias por tipos | §4, inventario §2 | T1 dispatcher; T2 conservación por familia, unknown y opcionales |
| B: unir/presentar con soporte y sin repetición | §§5–7 | T3 duplicate relation/support y aliases; T5 details autosuficiente |
| No concatenación ni pipelines por pareja | §§3,6,9 | T3 reglas finitas; T4 unión de queries cerrada; T8 revisión diff |
| Identidad repo/snapshot/live exacta | §§5.1–5.3 | T3 SHA/live/stateId negativos; T6 mutación live/owner extranjero |
| Imports ≠ calls; reach ≠ breakage; origins ≠ cadena | §§4.4,6 | T2 categorías; T3 relaciones negativas; T7 claims prohibidos |
| Provenance, cuts, scopes/budgets y desconocidos fieles | §§4.2,5.2,7 | T2 reconstrucción; T3 contextos; T5 textos y counts por owner |
| Orden, asociatividad, idempotencia con evidencia fija | §5.4 | T3 permutaciones/parentizados/ambigüedad nueva; T6 7! puro y órdenes reales acotados |
| Orden de adquisición distinto del merge | §§3.1,5.4,10.2 | T6 triple dependiente completo y transferencia Link.to |
| Entrypoints+outline, impact+callers, importers separado | §§6,7.3 | T3 tres ejemplos semánticos; T6 hechos reales |
| Sin snippet inventado | §§2,4.4 | T2 solo OutlineValue; T5 guía; T8 búsqueda/revisión de superficie |
| Invocación concreta y autoridad sin estado final | §3 | T4 llamada repetida ejecuta puertos; T6 sesión fría/stdio |
| Límites, validación, faults y cancelación | §§3.2–3.4 | T4 tamaños/multibyte/queries/expect/deadline/cancel; T6 proceso recuperable |
| Modes/full/select/page/replay compatibles | §§7.1–7.4,9.2 | T1 regresión originales; T4 pinned/fresh; T5 schemas; T6 intercalación |
| Trust/redacción/frescura/membresía | §§5.2,8 | T2 query-context; T3 compatibilidad no transitiva; T4 colisión redactada; T6 declaración actual |
| Guía compacta aproximada, runtime autoritativo | §§2,9.2 | T1/T5 schemas reales y combos que guía acepta/runtime rechaza |
| Optimización medible sin promesa universal | §10 | T5 overlap local; T7 coste completo, no overlap y limitaciones |
| Síntesis LLM con grounding/citas/incertidumbre | §10.3 | T7 respuestas reales y adjudicación; no_evaluated si faltan |
| Plan autosuficiente y propietarios exactos | §§9,11 | T1–T8 interfaces/checks; auto-revisión §14 |

## 13. Riesgos y decisiones que quedan cerradas

| Riesgo o coste | Respuesta de este plan |
|---|---|
| Coordenadas públicas insuficientes para identidad perfecta | Guards conservadores y ambigüedad explícita; no añadir GraphNodeId transversal ni lecturas implícitas. Si fixtures reales muestran pérdida de utilidad, será una ampliación de contrato separada, no un fallback heurístico |
| Volver a analizar puede costar más que concatenar datos ya disponibles | Se mide coste completo; operación opt-in, herramientas individuales conservadas. No se cambia ADR-0020/0021 ni se retienen resultados para ocultar ese coste |
| Cuerpos grandes, hasta 16 consultas, sin límite de salida | Una fuente original a la vez, normal form acumulada y agrupación exacta; medir memoria/tamaño. No vender esta versión como paginador general ni reducir scope silenciosamente |
| Decisions depende de datos externos y no admite replay | Se compone su lectura actual, se conserva contexto y se verifica por digest al repetir; estrategia fresh explícita. Añadir su replay cambiaría opciones/resolución y se ha descartado para esta versión |
| Input móvil o mutación entre operaciones | Snapshots/particiones visibles, expect falla, no atomicidad de batch. Consumidor puede fijar SHAs y usar recipes disponibles |
| El shared checkout cambia mientras se implementa | Integración por símbolos y tests de puertos, baseline/source manifest por ejecución. Ningún diff ajeno se revierte por asumir los hashes de este documento |
| Transformación tipada descarta un campo nuevo del dominio | Fixtures de conservación con opcionales significativos, exhaustividad de unions y revisión de adapters al cambiar schema/producer |
| El LLM interpreta mal relaciones o incertidumbre | Evaluación de claims/citas prohibidos y no solo bytes; formato determinista y términos acotados; reportar síntesis no evaluada cuando corresponda |

No quedan decisiones de API o de arquitectura necesarias marcadas TBD: se eligen nueva operación acotada, coordinación servidor/consumidor, unión sin store, siete adaptadores, reglas finitas, salida normalizada, estrategias pinned/fresh y ausencia de paginación de composición. Lo pendiente es **evidencia de implementación y evaluación**, no una preferencia rutinaria del usuario. El acceso futuro a un consumidor LLM es un recurso de evaluación: su ausencia no bloquea construir los contratos, pero sí afirmar utilidad de síntesis validada.

## 14. Auto-revisión y evidencia de este encargo de planificación

- Se revisó cobertura de los requisitos contra T1–T8, preservando explícitamente las dos partes A/B y la integración pública.
- Se revisaron identidades distintas: SourceId y mcp-r1 no se intercambian; mcp-c1 verifica el conjunto; declaration anchor no es call site; module origins y symbol seeds usan tablas diferentes.
- Se revisó asociatividad: se unen observaciones antes de resolver aliases; incompatibilidad no se propaga transitivamente mediante una tercera fuente.
- Se revisó el wire: receipt y full tienen discriminantes nuevos; source tables/requests no requieren estado oculto; los originales mantienen sus outputs; unknown no tiene value inventado.
- Se revisó la proporcionalidad: ninguna dependencia nueva, pipeline language, almacén, source reader, replay decisions o puerto universal. Los nuevos módulos tienen responsabilidades concretas del transporte.

Durante este encargo solo se crea/edita este documento. La verificación real del plan consiste en lecturas de fuente/contratos, comprobación de frescura de `createMcpServer`, revisión de tipos/ownership y `git diff --check` sobre el documento. Las suites T1–T8 son instrucciones futuras; no se han ejecutado para afirmar que la funcionalidad propuesta ya existe o pasa pruebas.

Verificación documental observada el 2026-11-05:

- `git diff --check -- docs/superpowers/plans/2026-11-05-transversal-mcp-evidence-composition.md`: exit 0, sin avisos. También pasó la comprobación `git diff --no-index --check /dev/null <documento>` cuando se verificó como archivo nuevo.
- Un script Python de lectura comprobó ocho links locales existentes, fences Markdown equilibrados, T1–T8 en orden, 60 pasos pendientes, ausencia de marcadores de conflicto y presencia de las firmas/tipos normativos revisados. No es un typecheck de implementación.
- `git status --short` al cerrar la revisión mostraba únicamente este documento modificado respecto del HEAD compartido; este diseñador no ejecutó commit, push, instalación ni cambios de producción/tests.
- No se ejecutaron `npm test`, `npm run check`, typecheck de código ni evaluación LLM. Engram seguía sin herramientas disponibles; no se ha guardado memoria ni un resumen de sesión mediante ese servicio.

## 15. Adenda 2026-11-05: corrección de la presentación compacta (receipt y texto)

Esta adenda registra una decisión de presentación tomada tras medir el criterio de §10.1. No cambia §§4–7.1 del grafo, la normalización, la identidad, `CompositionResult` ni `ComposeFull`. Full sigue siendo la fuente exhaustiva y autorizada.

**Síntoma.** En la ejecución `2026-11-05-prepare-1`, details (texto + structured) superaba al baseline en dos de los tres casos de solapamiento deliberado: handler-outline 4762 frente a 1647 bytes, y seven-families 17259 frente a 13033 bytes.

**Causa raíz.** El receipt y el texto compacto mezclaban metadatos de auditoría con la entrega al consumidor:

- el receipt copiaba descriptors con ids de 64 hex, vectores, rootRead y los arrays exhaustivos de coverage, que solo sirven para navegar un grafo que summary/details no entregan;
- el texto repetía manuales invariantes (Terms, instrucciones de verificación y navegación, definiciones de reglas en cada línea) y el contexto de procedencia completo de cada grupo de reads;
- además, listaba la misma observación en dos secciones, porque la cobertura de una parte dependía del orden de renderizado y no de su tipo.

**Decisión: un hecho, un canal, una vez.**

1. **ComposeReceipt.** Contiene `kind`, `compositionSchema`, `mode`, `verification`, `requests` completos y `sources[]` en orden de `requestIndex`, cada uno como `{family, branch?, requestIndex, analysis}`. `coverage` se reduce a `{reads, unknowns, limits, issues}`, donde los tres últimos son conteos. Se eliminan `counts`, los ids de fuente, `rootRead`, `snapshotVector` y los arrays de coverage, que siguen íntegros en full con las mismas queries.
2. **Texto compacto.**
   - Se suprimen los manuales invariantes.
   - Las advertencias de cada tipo de relación o regla de conexión se dicen una vez, en el primer objeto de ese tipo; las reglas que solo nombran a sus miembros no llevan texto.
   - Trust y scope declarado se imprimen una vez; producer, schema y typeRoot solo cuando difieren, agrupados por valor exacto. Engines y el origen del índice quedan en full; una incompatibilidad sigue apareciendo como issue.
   - La estrategia de cada request queda en el receipt; el texto solo declara la indisponibilidad.
   - Summary conserva las coordenadas que el summary original de cada fuente muestra: las declaraciones de un archivo outline, la evidencia de un hallazgo unknown de entrypoints, el handler de un entrypoint alcanzado y los lugares de corte de importers.
   - Un archivo outline y sus declaraciones forman un único bloque de sujeto, reclamado por tipo antes de renderizar.
   - Lecturas con el mismo análisis o la misma lista de evidencia se agrupan por igualdad exacta.
   - Las roots se imprimen una por repositorio cuando todas las fuentes coinciden.
   - Full solo da conteos y punteros por tabla.
3. **Lo que no cambia.** Cada corte, unknown, issue, opción de decisión, snapshot y coordenada de evidencia se sigue imprimiendo. No hay top-N, ni inferencia nueva, ni parsing de prosa, ni reglas por caso o familia.

**Resultado medido** en una ejecución nueva del evaluador sobre el código actual (details, texto/structured):

| Caso | Baseline | Compuesto |
|---|---|---|
| handler-outline | 1136/511 = 1647 | 931/926 = 1857 |
| change-duplicate-dependence | 7463/1455 = 8918 | 3170/1684 = 4854 |
| seven-families | 10688/2345 = 13033 | 5471/3514 = 8985 |

**Brecha restante: arquitectónica, no de presentación.** En handler-outline, `verification` más los `requests` completos ya ocupan 673 bytes (artefacto redactado), frente a 511 del canal structured completo del baseline. Las líneas exactamente duplicadas del baseline suman solo 208 bytes. Por tanto, aun con un receipt mínimo, el contrato de repetición por respuesta (receta fresh de outline e identidad mcp-c1) supera la redundancia recuperable de dos respuestas pequeñas.

El ajuste mínimo de API que lo acercaría sería quitar `sources` y `coverage` del receipt, puesto que el texto ya los declara. Su efecto medido es 1540 frente a 1519 bytes redactados: sigue sin cumplirse. Decidirlo corresponde al lead. Full sigue siendo 2,4–4,3 veces mayor que el full original y no se presenta como optimizado.


## 16. Integración final: una sola ubicación por responsabilidad

Esta sección prevalece sobre la forma anterior de receipt de §§7/15. La raíz de la sobrecarga era la mezcla de la representación auditable con la entrega al agente: se repetían en dos canales las fuentes, estados, cobertura y navegación. El contrato definitivo de summary/details es `{kind:"composition-receipt",compositionSchema:1,mode,verification,requests}`. El texto conserva fuentes, snapshots, todos los hallazgos y límites materiales. Full conserva sin pérdida el grafo, provenance, coverage, counts y delivery. S# corresponde a requests[#-1]. No se reenvían hechos ni se almacenan resultados: las recetas seguras permanecen completas.

La navegación disponible se enseña una vez en instructions y está tipada en requests.strategy. Se eliminan de cada respuesta las instrucciones redundantes y la frase vacía «Omitted: no observation»; summary conserva los conteos de omisiones reales. Esta regla depende de las responsabilidades de cada canal, nunca de nombres de casos o combinaciones. Las tres aceptaciones de solapamiento quedan activas sin TODO y verifican ambos canales más la conservación de hechos/límites. El fallo de handler-outline no necesitaba handles: todavía había duplicación en el contrato de entrega. Full permanece exhaustivo y puede ser mayor que las fuentes originales; no se anuncia como formato de mínima longitud.

La identidad de observación y la procedencia se mantienen separadas del propósito de una conexión. Corroborar la misma importación positiva o el mismo soporte exacto no deriva una nueva dependencia: conserva productores originales distintos y exige igualdad de nombre del productor, schema, trust, engines comunes y snapshots. Las conexiones que derivan significado conservan igualdad estricta de versión; todas las familias de un build usan la misma versión ([ADR-0024](../../architecture/adr/0024-one-producer-version-for-every-family.md)). El constructor de Part tiene además un guard de tipos que prohíbe id/supports en cualquier payload futuro, evitando toda la clase de colisiones entre datos de dominio y metadatos.

Verificación integrada y medidas finales: consultar el informe de entrega y docs/evaluations/mcp-composition/runs/2026-11-05-delivery-final; no atribuir al código final las medidas de los prototipos anteriores.


## 17. Separar presencia de colección y cantidad de observaciones

La prueba de consumidor diagnosticó que el literal changedEntrypoints=present podía interpretarse como cambios existentes aunque el array original fuera vacío. La causa era mezclar forma de serialización con contenido del dominio. La solución común es RecordedCollectionState = {state:absent}|{state:present,count:number}, aplicado tanto al contexto de impacto como a las categorías de importers. Count es longitud de observaciones registradas, preservando duplicados; no es cardinalidad de dependencias únicas. El renderer muestra cero o «not provided», nunca infiere cardinalidad a partir de presencia. La reconstrucción conserva absent, vacío y no vacío. Los fixtures de regresión de presentación usan ahora el run semantic-final, que tiene el contrato actual; los runs anteriores y sus consumidores se conservan como evidencia diagnóstica.

El evaluador usa posiciones JSON Pointer cuando el consumidor repite IDs entre claims/uncertainties, en vez de sobrescribir afirmaciones. Toda cita debe resolver; una proposición necesita soporte del tipo pertinente y puede añadir contexto válido. La relevancia semántica sigue requiriendo adjudicación, y no se reparan respuestas ni referencias inexistentes. El piloto se acota y se informa por run; no sustituye el corpus de 64 respuestas ni demuestra generalización.
