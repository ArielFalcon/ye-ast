# Composición transversal MCP: implementación y verificación

Implementada e integrada en el checkout mediante `ye_ast_compose`. Las siete familias originales conservan sus contratos. La nueva operación ejecuta consultas tipadas mediante el despacho común, normaliza hechos públicos y compone entidades, relaciones y soportes de forma determinista, sin retener resultados finales entre llamadas.

## Comportamiento y causas resueltas

- **Identificación:** adaptadores exhaustivos sobre contratos tipados; nunca se analizan secciones de texto, nombres aproximados o sufijos de versión para relacionar hechos. Repositorio y snapshot completo forman parte de la identidad. Live conserva head y stateId.
- **Composición:** unión de observaciones antes de resolver identidades, con procedencia de cada soporte. No hay un pipeline por combinación. Ambigüedad, incompatibilidad y ausencia de evidencia quedan explícitas. Corroboración exacta y derivación semántica tienen propósitos de compatibilidad diferentes; los productores originales se conservan.
- **Metadatos y dominio:** los payloads no pueden sobrescribir id/supports del registro; una comprobación de tipos protege todas las variantes. RecordedCollectionState separa campo ausente, colección vacía y cantidad de observaciones en impacto e importers. No se interpreta presencia como resultado positivo.
- **Entrega al agente:** el texto lleva hallazgos, fuentes y límites; el recibo lleva únicamente versión/modo, verificación y consultas seguras completas para repetir. Full conserva grafo, cobertura, costes, soportes y sidecars. Se elimina duplicación de responsabilidades entre canales, sin handles ni un almacén oculto.
- **Validación:** identificadores digest con namespace tienen una regla común, separada del único propietario de IDs de Git. Se comprueban referencias del grafo y de issues. Los fallos no se convierten en hechos vacíos ni se entrega un lote de éxitos parciales cuando falla una fuente.

## Evidencia observada

- `npm run check`: **2.367 pruebas pasan**, cero fallos, skips o TODO; incluye typecheck y arquitectura. Node **24.22.2**, versión de `.nvmrc`. Log de la última ejecución: `/tmp/ye-ast-final-check-3.log`.
- `node --import tsx --test scripts/evaluate-mcp-composition.test.ts`: **23 pruebas pasan**, incluyendo referencias inexistentes, soporte pertinente con contexto adicional y IDs de afirmación repetidos sin sobrescritura. `npm run typecheck`, `npm run arch:check` y `git diff --check` pasan tras esos cambios.
- `npm run build`: termina con código 0.
- Pruebas puras: las **5.040 permutaciones** de las siete familias producen la misma composición, también con duplicados. Se prueban asociatividad, ambigüedad nueva y ambos parentizados.
- Pruebas MCP reales: ocho operaciones, las siete familias juntas, transporte stdio, sesiones frías/calientes, tres órdenes, transferencias de coordenadas y destino extranjero de Link.to, selecciones intercaladas, replay, cambios de trust, live frente a SHA, fallos, deadline y supervivencia tras cancelación. Todo usa repositorios y trust stores temporales.
- Preparación de ocho casos por MCP real en `runs/2026-11-05-semantic-final/`; orden de consultas original/inverso/intercalado estable sobre entradas fijadas. Los artefactos sustituyen rutas privadas del entorno.

## Tamaño de los casos con solapamiento

Bytes UTF-8 totales de details: **texto más structuredContent**, misma cobertura y consultas. No son tokens y no incluyen un supuesto ahorro de latencia.

| Caso | Herramientas separadas | Composición |
|---|---:|---:|
| handler-outline | 1,647 | 1,518 |
| change-duplicate-dependence | 8,918 | 4,467 |
| seven-families | 13,033 | 8,232 |

Las tres aceptaciones estrictas están activas, sin excepciones por caso en producción ni TODO. Se conservan estados, límites, opciones, snapshots y consultas de repetición. Los datos completos están en `runs/2026-11-05-semantic-final/measurements.json`.

## Consumo LLM: alcance y resultado

Los consumidores fueron **Claude Opus 5.5, medium**, con un prompt por contexto fresco y sin acceso a la respuesta esperada, código ni respuestas de otros consumidores. El integrador revisó afirmaciones y citas, y el evaluador validó su resolución.

- Piloto diagnóstico sobre `delivery-final`: seis respuestas, original/composición en tres casos, orden original y una réplica. **Cinco pasan y una falla** por una cita inexistente del consumidor baseline (`q1:/value/cuts/0`). No se reparó. El piloto también mostró la ambigüedad de presencia/cardinalidad que motivó la corrección general del contrato.
- Seguimiento sobre el contrato final `semantic-final`: dos respuestas compuestas (dependencia duplicada y siete familias), **dos pasan**. Ambas afirman explícitamente cero changed entrypoints, distinguen el campo no proporcionado y mantienen partial/unknown, importación frente a llamada, alcance frente a rotura y opciones de trust reales. Los IDs repetidos entre claims/uncertainties se adjudican mediante posiciones JSON Pointer, sin alterar la respuesta cruda.
- Los restantes **58/64** del run diagnóstico y **62/64** del run final permanecen `not_evaluated`. El resultado global de cada corpus no es una prueba de aprobación general. No se ejecutó una comparación LLM completa en todos los órdenes, réplicas o modelos; tampoco se demostró superioridad estadística ni se evaluó la legibilidad de todos los modos con consumidores.

Respuestas crudas, adjudicaciones y scores: `runs/<run>/consumer-pilot/`. Los prompts de consumo usan **full** para permitir citas de IDs estructurados. La reducción de summary/details se verifica por mediciones y conservación; no se confunde con una evaluación LLM de esos modos.

## Límites de entrega

Full es una representación auditable exhaustiva y puede ser mayor que concatenar las fuentes originales. La composición tiene coste fijo de verificación y repetición y no garantiza reducción cuando no hay solapamiento. El catálogo también crece al añadir la operación. La composición reejecuta análisis, no garantiza menor latencia y no captura todo el workspace en un instante atómico. Ninguna relación demuestra por sí misma una rotura ni una cadena no registrada.

No se hicieron commits, push ni publicación. El trabajo queda integrado en el workspace. Los artefactos anteriores se conservan como historial diagnóstico, sin atribuir sus medidas al contrato final.
