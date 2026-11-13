# ADR-0062: Java simple names and receivers resolve under the repository-compiles assumption

- Status: Accepted, 2026-11-13, owner
- Decision source: Owner, 2026-11-13: "Implementa los 3. Es de extrema importancia que se resuelvan bien la relaciones entre frontend -backend y backend -backend", applying the recommendation that an unresolved generated supertype must not invalidate own, private and local receivers
- Amended by: [ADR-0067](0067-record-and-lombok-members-and-mybatis-statements-are-settled-from-the-snapshot.md) (a record or plain-Lombok member the class adds is a settled receiver method), [ADR-0068](0068-lombok-access-levels-superbuilder-and-inherited-members-are-settled.md) (a Lombok member a class generates for its own field is settled when only outside superclasses open the hierarchy), [ADR-0070](0070-a-spring-data-repository-call-is-a-proxy-supplied-member-and-a-vocabulary-name-an-on-demand-import-leaves-unsettled-is-read-from-its-package.md) decision 1 (a closed-vocabulary name an on-demand import leaves unsettled; Spring Data proxy members)
- Related: ADR-0013, ADR-0029, ADR-0051

## Context

A Spring backend chain (a controller, an application service, a REST client, a repository) was cut at its first step on
real backends, so no backend-to-backend request or data effect was placed. Three readings of the sources were stricter
than the language requires:

1. A simple name that exactly one on-demand import of the repository declares stayed unsettled whenever the file also
   imported a package outside the repository (`import org.springframework.web.bind.annotation.*;`).
2. Every interface a type extends and the repository does not declare made member-type inheritance unsettled, including
   Spring Data repository interfaces, so no parameter type of a query method (`String`) settled and no repository call
   bound its signature.
3. A controller implementing an interface generated from an OpenAPI document (absent from git) made every call receiver
   in the class unproven, including a private method of the class and a typed local.

## Decision

1. Under the assumption that the repository compiles, a name that one on-demand import of the repository declares is that
   declaration: a package outside the repository cannot declare it too, since a reference both offer is a compile error.
   Two repository packages declaring it stay unsettled, and so does a name no repository package declares.
2. A closed vocabulary of Spring Data repository interfaces (`Repository`, `CrudRepository`, `ListCrudRepository`,
   `PagingAndSortingRepository`, `ListPagingAndSortingRepository`, `JpaRepository`), written by its qualified name and
   not claimed by a package of the repository, declares no member type; with `java.io.Serializable` and the memberless
   platform interfaces it is skipped when member-type inheritance is read. Evidence (ADR-0013): a Spring Data pet-clinic
   microservice set and a production backend. The list grows only with evidence.
3. When a build file declares a source generator of OpenAPI interfaces (the signal the route extractor reads), an
   interface that the sources do not declare and no platform package can supply declares no member type, and its members
   are the API's operations. Names resolved in the implementing class are not unsettled by it, and a call whose
   declarations all belong to classes of the hierarchy (a private or public method of the class, a typed local, a field,
   a parameter) is selected as without the interface. A method that only the interface could declare stays unproven, as
   does a declaration owned by another interface, an absent class, an absent platform type, and any absent interface when
   no generator is declared.
4. The build signal of decision 3 is part of the identity of the Java project a read holds: every reader of the Java
   pack's name-binding family (origins, receiver methods, implemented declarations, dispatch targets, declared types,
   root bindings and root origins) builds or holds the project with the same `ProjectBuild`, so one read parses one
   project. Readers outside that family (relations, call sites, data effects, routes, imports, payload shapes) build
   without it until a unit that moves their answers passes the corpus gate.

## Consequences

- A backend chain that crossed a framework wildcard, a Spring Data repository or a generated API interface is placed
  instead of cut. A library interface outside the platform packages is indistinguishable from a generated one when a
  generator is declared (hypothesis: accepted, as for generated delegates, because the repository compiles).
- Overload resolution still reads the stated signatures; only the cut at the hierarchy is removed.
- The origins reader receives the build files of its pack as context (`contextFiles`), part of the held project's
  identity and of the derived facts' layout; no schema or contract changes.
