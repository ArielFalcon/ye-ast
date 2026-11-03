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
      role: "Un servidor MCP stdio atado a un repositorio. Expone tools de solo lectura y devuelve el fact junto con la guía de cortes que un agente necesita para actuar.",
      may: "core/ports, core/domain",
      never: "core/adaptadores, cualquier escritura",
      facts: [
        "McpDeps solo contiene query families de lectura, así que una escritura es imposible por tipo.",
        "Tools: ye_ast_puntos de entrada, ye_ast_impact, ye_ast_callers, ye_ast_importers, ye_ast_workspace.",
        "CUT_GUIDANCE es exhaustivo sobre Cut[\"kind\"]; un cut nuevo no compila hasta que se le dice al agente cómo actuar.",
      ],
    },
    protocol: {
      role: "El protocolo de query: JSON-RPC 2.0, un mensaje por línea sobre stdio. Un host puede ejecutar ye-ast como proceso y mantener las query families detrás.",
      may: "core/ports, core/domain",
      never: "core/adaptadores, otro entrypoint",
      facts: [
        "stdout solo lleva líneas de protocolo; las medidas y los diagnósticos van a stderr.",
        "Las cuatro operaciones por repositorio: puntos de entrada.map, impact.ofChange, impact.callers, impact.importers.",
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
        "El digest de la política de aristas es parte de la versión del producer, así que un cambio de política invalida facts.",
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
        "Un guarda es una declaración, unida por archivo y nombre.",
      ],
    },
    "domain-map": {
      role: "El fact del mapa de puntos de entrada: reglas de rutas dentro del scope, fingerprint de contenido, cortes del export y el section fact anidado.",
      may: "solo core/domain",
      never: "ports, adaptadores, built-ins de Node",
      facts: [
        "El map cubre Java, TypeScript, plantillas Angular, configuración Spring, OpenAPI y archivos de build.",
        "Una parada por budget es un cut caller-budget, nunca un truncamiento silencioso.",
        "Una ruta fuera del scope declarado no se lee; la completitud es relativa a ese scope.",
      ],
    },
    "domain-shared": {
      role: "El vocabulario que comparten todos los subdominios: el fact, el cut, el scope, el result, el JSON canónico y el único join entre grafo y fact.",
      may: "solo core/domain",
      never: "ports, adaptadores, built-ins de Node",
      facts: [
        "Un fact es complete, partial con cortes, o unknown con una razón. No hay un cuarto estado.",
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
        "Un índice se keyed por contenido staged; un store no soportado se rechaza, no se repara.",
      ],
    },
    "adapter-git": {
      role: "Exporta un commit con plumbing, lee un diff con opciones fijadas, resuelve revisiones y merge bases, y refresca remotes declarados bajo trusted.",
      may: "core/domain, core/ports, librerías",
      never: "core/application, otro adapter",
      facts: [
        "ls-tree lista; cat-file streamea cada blob. Un blob nunca se mantiene entero.",
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
        "El mirror copia archivos, nunca los hard-linkea.",
        "Un mirror o un directorio de caché debe ser privado de la cuenta.",
      ],
    },
    "adapter-typescript": {
      role: "La API del compilador de TypeScript: rutas Angular, declaraciones, metadata, uso de plantillas, cargas dinámicas y call sites HTTP.",
      may: "core/domain, core/ports, librerías",
      never: "core/application, otro adapter",
      facts: [
        "Cada uso de la API del compilador vive bajo core/adaptadores/typescript.",
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
