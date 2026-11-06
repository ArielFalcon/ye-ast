/* Spanish module details. Extracted from the original explainer. */
window.MODULE_DETAILS_ES = {
    cli: {
      role: "Convierte argv en una llamada de query y da forma a stdout y stderr. El CLI es un adapter de entrada: conoce argumentos y códigos de salida, nunca git ni codegraph.",
      may: "core/ports, core/domain",
      never: "core/adaptadores, los casos de uso de core/application",
      facts: [
        "Códigos de salida: 0 ok, 1 fault tipado, 2 uso, 70 interno, 130 interrumpido.",
        "Cada cadena que sale del proceso pasa por redaction.",
        "El uso y el parseo viven en un archivo; composition inyecta las query families.",
      ],
    },
    mcp: {
      role: "Un servidor MCP stdio vinculado a un repositorio. Expone tools de solo lectura y devuelve el fact junto con la guía que un agente necesita para leerlo: qué significan complete, partial y unknown, y qué es un cut.",
      may: "core/ports, core/domain",
      never: "core/adaptadores, cualquier escritura",
      facts: [
        "McpDeps extiende QueryExecutionDeps, que solo contiene query families de lectura (entrypoints, impact, outline, workspace, workspace impact, decisions) más redaction y digest, así que una escritura es imposible por tipo.",
        "Ocho tools: ye_ast_entrypoints, ye_ast_impact, ye_ast_callers, ye_ast_importers, ye_ast_outline, ye_ast_workspace, ye_ast_decisions y ye_ast_compose.",
        "Las instrucciones del servidor enseñan al agente a leer una respuesta: complete es relativo al scope declarado, partial lista sus cuts y unknown nunca significa que no hay impacto.",
        "ye_ast_compose combina de 1 a 16 consultas de las siete familias en un solo conjunto de evidencia con una identidad de verificación; existe solo sobre MCP.",
      ],
    },
    protocol: {
      role: "El protocolo de query: JSON-RPC 2.0, un mensaje por línea sobre stdio. Un host puede ejecutar ye-ast como proceso y mantener las query families detrás.",
      may: "core/ports, core/domain",
      never: "core/adaptadores, otro entrypoint",
      facts: [
        "stdout solo lleva líneas de protocolo; las medidas y los diagnósticos van a stderr.",
        "Las siete operaciones por repositorio: entrypoints.map, impact.ofChange, impact.callers, impact.importers, outline.files, workspace.outwardNames, decisions.decisions.",
        "trust.declare es la única llamada administrativa del protocolo; declara el trust mode fuera del repositorio.",
      ],
    },
    later: {
      role: "Hooks y el daemon son adaptadores de entrada posteriores. Llamarán a las mismas query families; no cambian el core.",
      may: "core/ports, core/domain",
      never: "core/adaptadores, las decisiones del core",
      facts: [
        "El orden de entrega pone primero la librería, map, init, serve y el MCP stdio; hooks y un daemon después.",
        "El daemon alojará el ciclo de vida, el servidor de socket, la programación del watcher y el escritor único.",
      ],
    },
    composition: {
      role: "La raíz: construye cada adapter, elige query families in-process o detrás del protocolo y cablea los puntos de entrada. Es el único lugar que conoce ambos lados.",
      may: "todo",
      never: "nada: es la raíz de composición",
      facts: [
        "Una construcción del grafo, un trust record, una caché de índices, un módulo de redaction.",
        "El MCP nunca sabe si habla con el core in-process o, a través del protocolo, con el daemon.",
        "Todas las familias de consulta usan la misma versión del producer (ADR-0024).",
      ],
    },
    "app-impact": {
      role: "Orquesta el pipeline de cambio a fact: resolver, exportar, diff, extraer, indexar, sembrar, recorrer, unir y cortar. Decide qué leer; los adaptadores deciden cómo.",
      may: "core/domain, core/ports, otros subdominios de application",
      never: "core/adaptadores",
      facts: [
        "Un solo cuerpo para un commit y otro para un árbol live; solo cambia la lectura del head.",
        "El recorrido lee solo el índice del head; el merge base se extrae para los puntos de entrada del cambio, no se indexa.",
        "Cada bound y cada punto ciego se convierte en un cut antes de construir el fact.",
      ],
    },
    "app-entrypoints": {
      role: "El caso de uso map: resuelve una revisión, exporta un snapshot dentro del scope, ejecuta los extractores de puntos de entrada y envuelve los findings en un fact.",
      may: "core/domain, core/ports",
      never: "core/adaptadores",
      facts: [
        "Cada ítem es un Finding: estado, valor o razón, y evidencia.",
        "La colección es el fact; el map anida un section fact para sus puntos de entrada.",
        "Un map live lee el mirror pero ningún store, así que no lleva index origin.",
      ],
    },
    "app-live": {
      role: "Refresca el mirror de un working tree trusted, mantiene el lock, sincroniza las rutas cambiadas, confirma el estado y reporta staleness sin cambiar la respuesta.",
      may: "core/domain, core/ports",
      never: "core/adaptadores",
      facts: [
        "La primera query live construye el mirror completo; las siguientes sincronizan solo las rutas cambiadas.",
        "Un lock mantenido durante la respuesta serializa las queries live sobre un mismo mirror.",
        "Una respuesta stale lo dice por stderr; el fact no cambia.",
      ],
    },
    "app-topology": {
      role: "Compone facts por repositorio en una respuesta de workspace: nombres hacia afuera, call sites, gateways y los enlaces entre repositorios.",
      may: "core/domain, core/ports, otros subdominios de application",
      never: "core/adaptadores",
      facts: [
        "El impacto entre repositorios es una composición, no un segundo recorrido.",
        "No hace ninguna petición de red: un nombre que nada sirve es el siguiente clon que hay que hacer.",
        "Cada repositorio se lee bajo su propia declaración de trust.",
      ],
    },
    "app-install": {
      role: "Declara el trust, añade las carpetas de ye-ast al exclude local, persiste el manifiesto del workspace y escribe la fixed layer.",
      may: "core/domain, core/ports",
      never: "core/adaptadores",
      facts: [
        "El trust record se escribe fuera del repositorio.",
        "El exclude local contiene .ye-ast/ y .ye-ast-graph/.",
        "La fixed layer aplica solo los patrones de redaction; los facts almacenados no se redactan.",
      ],
    },
    "app-outline": {
      role: "El caso de uso outline: por cada archivo pedido, las declaraciones con sus spans de líneas y los archivos que importa, leídos del índice del head.",
      may: "core/domain, core/ports, otros subdominios de application",
      never: "core/adaptadores",
      facts: [
        "Cada declaración lleva su primera y su última línea, así que quien llama lee exactamente ese rango en vez del archivo entero.",
        "Un archivo pedido sin nodo en el índice se reporta como unheld: lo que declara se desconoce, y eso no es lo mismo que nada.",
        "Lee el mismo snapshot exportado e índice que las demás familias, y marca con un cut los archivos sin extractor o no exportados.",
      ],
    },
    "app-decisions": {
      role: "El caso de uso decisions: lee un workspace y lista los huecos de configuración que deja al usuario, cada uno con opciones que el workspace puede verificar.",
      may: "core/domain, core/ports, otros subdominios de application",
      never: "core/adaptadores",
      facts: [
        "No escribe nada: los huecos son membership, repository, library, gateway, revision, remote y trust, solo sobre configuración.",
        "Su entrada es la lectura del workspace: nombres hacia afuera, candidatos y nombres sin servir.",
        "Una membership ya respondida no se vuelve a preguntar; una recomendación sale de una regla, nunca de un modelo.",
      ],
    },
    "app-snapshot": {
      role: "El lector de snapshots compartido: exporta un commit, lee los archivos exportados, extrae puntos de entrada y construye la fact base de la que parte cada familia.",
      may: "core/domain, core/ports",
      never: "core/adaptadores",
      facts: [
        "El export escribe solo los archivos que el caller selecciona; el scope filtra qué se escribe y qué cubre el fact.",
        "El fingerprint de contenido es el digest de los archivos dentro del scope, no del repositorio completo.",
        "El trust se lee del record; un record ausente o inutilizable significa untrusted.",
      ],
    },
    "domain-impact": {
      role: "Las reglas puras de impact: la política de aristas, la taxonomía de cortes, el join de puntos de entrada, los puntos de entrada cambiados y el orden del fact.",
      may: "solo core/domain",
      never: "ports, adaptadores, built-ins de Node",
      facts: [
        "La política de aristas es dato; el recorrido la lee, nunca codifica fijo un tipo de arista.",
        "Un cut nombra dónde se detuvo el cálculo, no solo que se detuvo.",
        "El orden es parte del contrato: profundidad, archivo, línea, símbolo.",
      ],
    },
    "domain-change": {
      role: "Lee un diff unificado sin contexto, selecciona semillas a partir de las líneas tocadas y da forma al blast radius.",
      may: "solo core/domain",
      never: "ports, adaptadores, built-ins de Node",
      facts: [
        "El lector de diff consume una línea a la vez; un diff grande nunca se mantiene entero.",
        "Una semilla lleva su base: lines, top-level, resource o requested.",
        "Un nombre eliminado sobrevive como posible cut, nunca como nodo.",
      ],
    },
    "domain-entrypoints": {
      role: "Las formas de un entrypoint: una ruta HTTP, una ruta UI, un listener de mensajes, un job programado y el manejador que lo sirve.",
      may: "solo core/domain",
      never: "ports, adaptadores, built-ins de Node",
      facts: [
        "Una ruta se identifica por método, path, versión y manejador; el base path es un finding aparte.",
        "Una ruta UI nombra el componente que muestra, o unknown cuando las fuentes no nombran uno.",
        "Un guard es una declaración, unida por archivo y nombre.",
      ],
    },
    "domain-map": {
      role: "El fact del mapa de puntos de entrada: reglas de rutas dentro del scope, fingerprint de contenido, cortes del export y el section fact anidado.",
      may: "solo core/domain",
      never: "ports, adaptadores, built-ins de Node",
      facts: [
        "El map cubre Java, TypeScript, plantillas Angular, configuración Spring, OpenAPI y archivos de build.",
        "Una parada por budget es un cut caller-budget, nunca un truncamiento silencioso.",
        "El scope selecciona el contenido sobre el que trata la respuesta; la configuración que lo interpreta siempre se lee. La completitud es relativa al scope.",
      ],
    },
    "domain-outline": {
      role: "El vocabulario de un outline: una declaración (kind, nombre y span de líneas), la forma de un archivo (qué declara e importa) y los archivos que un índice no tiene.",
      may: "solo core/domain",
      never: "ports, adapters, built-ins de Node",
      facts: [
        "Los imports son archivos relativos al repositorio: un paquete fuera del repositorio no es una arista del grafo.",
        "Los archivos unheld se nombran, nunca se reportan como vacíos.",
      ],
    },
    "domain-decisions": {
      role: "Reglas puras que convierten los facts de un workspace en decisiones: qué huecos existen, qué opciones puede verificar cada uno y si una regla recomienda alguna.",
      may: "solo core/domain",
      never: "ports, adapters, built-ins de Node",
      facts: [
        "Los kinds son una lista cerrada: membership, repository, library, gateway, revision, remote y trust.",
        "Una opción lleva la base que la hace válida y los lugares que la afirman.",
        "Una decisión puede admitir texto libre, y ser obligatoria cuando su ausencia debilita una respuesta.",
      ],
    },
    "domain-shared": {
      role: "El vocabulario que comparten todos los subdominios: el fact, el cut, el scope, el result, el JSON canónico y el único join entre grafo y fact.",
      may: "solo core/domain",
      never: "ports, adaptadores, built-ins de Node",
      facts: [
        "Un fact es complete, partial con cortes, o unknown con una razón. No existe un cuarto estado.",
        "El join es archivo, línea dentro del span y el mismo simple name.",
        "La identidad de un fact es schema + inputs + producer.",
      ],
    },
    ports: {
      role: "Contratos que el core ofrece o necesita. Un puerto por archivo; el core declara lo que necesita y el adapter lo implementa.",
      may: "core/domain, core/ports",
      never: "core/adaptadores, core/application",
      facts: [
        "CodeGraph, Vcs, SourceReader, IndexCache, SnapshotAdmin, FixedLayerAdmin, WorkspaceQueries…",
        "GraphNodeId es un handle, nunca un fact: nunca llega a una salida.",
        "Un puerto lo nombra quien lo consume, así que el core nunca importa una tecnología.",
      ],
    },
    "adapter-codegraph": {
      role: "Ejecuta codegraph en un proceso hijo sobre un snapshot exportado o un mirror, comprueba las versiones del store y expone un reader de solo lectura.",
      may: "core/domain, core/ports, librerías",
      never: "core/application, otro adapter",
      facts: [
        "El SQL crudo contra el store vive solo aquí; el resto del código ve un reader.",
        "DO_NOT_TRACK=1 siempre; el shim de CLI de codegraph nunca se llama.",
        "Un índice se identifica por el contenido staged; un store no soportado se rechaza, no se repara.",
      ],
    },
    "adapter-git": {
      role: "Exporta un commit con plumbing, lee un diff con opciones fijadas, resuelve revisiones y merge bases, y refresca remotes declarados bajo trusted.",
      may: "core/domain, core/ports, librerías",
      never: "core/application, otro adapter",
      facts: [
        "ls-tree lista; cat-file transmite cada blob. Un blob nunca se carga entero.",
        "diff-tree fija cada opción que cambia los hunks, incluidos --text y --unified=0.",
        "Una ejecución aislada de git vacía la configuración del usuario y del sistema.",
      ],
    },
    "adapter-fs": {
      role: "El lector confinado, el mirror live, el store de la fixed layer, el trust record, el path matcher y el directorio scratch.",
      may: "core/domain, core/ports, librerías",
      never: "core/application, otro adapter",
      facts: [
        "Cada ruta del repositorio pasa por el lector confinado.",
        "El mirror copia archivos, nunca crea hard links.",
        "Un mirror o un directorio de caché debe ser privado de la cuenta.",
      ],
    },
    "adapter-typescript": {
      role: "La API del compilador de TypeScript: rutas Angular, declaraciones, metadata, uso de plantillas, cargas dinámicas y call sites HTTP.",
      may: "core/domain, core/ports, librerías",
      never: "core/application, otro adapter",
      facts: [
        "Cada uso de la API del compilador vive bajo core/adapters/typescript.",
        "TypeScript se queda en 6.0.3, la última línea con la API del compilador que necesitan los extractores.",
        "El extractor de rutas Angular lee fuentes; nada se construye ni se ejecuta.",
      ],
    },
    "adapter-spring": {
      role: "Lee rutas Spring, listeners, call sites, base paths de configuración y contratos OpenAPI desde fuentes Java.",
      may: "core/domain, core/ports, librerías, árboles de sintaxis de tree-sitter (excepción congelada)",
      never: "core/application, otro adapter (salvo la lectura congelada de tree-sitter)",
      facts: [
        "Es la única excepción adapter-a-adapter: lee los árboles de sintaxis de tree-sitter.",
        "El base path de la ruta es un Finding por documento de configuración y perfil.",
        "Los contratos declarados se unen al código que los implementa.",
      ],
    },
    "adapter-treesitter": {
      role: "Parsea Java a árboles de sintaxis para el adapter de Spring. Decide sintaxis, no rutas.",
      may: "core/domain, core/ports, librerías",
      never: "core/application, otro adapter",
      facts: [
        "web-tree-sitter y tree-sitter-java son engines fijados.",
        "Su versión es parte de los engines del fact, así que un upgrade cambia la identidad del fact.",
      ],
    },
    "adapter-angular": {
      role: "Lee el uso de plantillas Angular a través de @angular/compiler: qué renderiza, bindea o proyecta una plantilla.",
      may: "core/domain, core/ports, librerías",
      never: "core/application, otro adapter",
      facts: [
        "Convierte un uso de plantilla en una relación que el recorrido puede seguir.",
        "Una relación que no puede colocar se reporta como unknown y se convierte en un cut unresolved-link.",
      ],
    },
    "adapter-openapi": {
      role: "Lee contratos HTTP declarados y los une al código que los sirve.",
      may: "core/domain, core/ports, librerías",
      never: "core/application, otro adapter",
      facts: [
        "Una ruta de contrato es un fact, no una conjetura a partir de un string en el código.",
        "El join usa la misma disciplina de simple name que el join del grafo.",
      ],
    },
    "adapter-redaction": {
      role: "Aplica los patrones de redaction a cada cadena que sale del proceso, y los secretos by-value solo en el proceso que ya los tiene.",
      may: "core/domain, core/ports, librerías",
      never: "core/application, otro adapter",
      facts: [
        "El CLI redacta stdout y stderr; el MCP redacta sus respuestas.",
        "Los facts almacenados no se redactan; la fixed layer aplica solo los patrones.",
      ],
    },
    "adapter-more": {
      role: "Los adaptadores de tecnología restantes: digests SHA-256 y los nombres hacia afuera que declara un repositorio (URLs, coordenadas, registries).",
      may: "core/domain, core/ports, librerías",
      never: "core/application, otro adapter",
      facts: [
        "Un digest es un puerto, así que un hash alternativo es un adapter, no un cambio del core.",
        "Los nombres hacia afuera se leen de configuración, archivos de build y remotes; no se hace ninguna petición de red.",
      ],
    },
  };
