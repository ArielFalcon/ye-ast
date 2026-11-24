import type { ImpactValue } from "../../../core/domain/impact/impact-fact.ts";
import type { Fact, FactBase } from "../../../core/domain/shared/fact.ts";
import type { WorkspaceImpactValue } from "../../../core/ports/workspace-impact-queries.port.ts";
const BASE: FactBase = {
  "schema": "0.24.0",
  "snapshot": {"repo": "a", "kind": "sha", "sha": "abc"},
  "producer": {"name": "test", "version": "1"},
  "inputs": {
    "trust": "untrusted",
    "scope": "s",
    "declaredScope": {"languages": [], "frameworks": [], "include": [], "exclude": []},
    "content": "c",
    "config": "c",
    "declaredConfig": {},
    "engines": {}
  },
  "evidence": []
};

export const IMPACT_FIXTURES: readonly ({name: string} & ({workspace: false; fact: Fact<ImpactValue>} | {workspace: true; fact: Fact<WorkspaceImpactValue>}))[] = [
  {
    "name": "fixture-0",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [],
        "entrypoints": [
          {
            "kind": "http-route",
            "name": "GET /x",
            "handler": {"path": "route.ts", "line": 9, "symbol": "handler"},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          }
        ],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-3",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [
          {
            "file": "consumer.ts",
            "line": 3,
            "symbol": "use3",
            "kind": "function",
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/domain/shared/long-dependency-path.ts", "symbol": "Dependency.resolve", "lines": [17, 29], "basis": "reference"}
          },
          {
            "file": "consumer.ts",
            "line": 5,
            "symbol": "use5",
            "kind": "function",
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/domain/shared/long-dependency-path.ts", "symbol": "Dependency.resolve", "lines": [17, 29], "basis": "reference"}
          },
          {
            "file": "consumer.ts",
            "line": 9,
            "symbol": "use9",
            "kind": "function",
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/domain/shared/long-dependency-path.ts", "symbol": "Dependency.resolve", "lines": [17, 29], "basis": "reference"}
          }
        ],
        "entrypoints": [],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-4",
    "workspace": true,
    "fact": {
      ...BASE,
      "status": "partial",
      "cuts": [{"kind": "section", "at": ["a", "b"], "reason": "section-partial", "reach": {"kind": "anything"}}],
      "value": {
        "workspace": {"repos": ["a", "b"], "gateways": [], "unmatchedGateways": [], "unserved": [], "source": "request"},
        "repositorySnapshots": [],
        "trigger": {"repo": "a"},
        "sections": {
          "a": {
            "schema": "0.24.0",
            "snapshot": {"repo": "a", "kind": "sha", "sha": "abc"},
            "producer": {"name": "test", "version": "1"},
            "inputs": {
              "trust": "untrusted",
              "scope": "s",
              "declaredScope": {"languages": [], "frameworks": [], "include": [], "exclude": []},
              "content": "c",
              "config": "c",
              "declaredConfig": {},
              "engines": {}
            },
            "evidence": [],
            "status": "partial",
            "cuts": [
              {"kind": "depth", "at": ["same-relative-path.ts::use0"], "limit": 1, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use1"], "limit": 1, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use2"], "limit": 1, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use3"], "limit": 1, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use4"], "limit": 1, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use5"], "limit": 1, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use6"], "limit": 1, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use7"], "limit": 1, "reason": "depth", "reach": {"kind": "anything"}}
            ],
            "value": {
              "reads": [],
              "callSites": [],
              "unmatched": [],
              "external": [],
              "unresolved": [],
              "impact": {
                "seeds": [],
                "symbols": [
                  {
                    "file": "same-relative-path.ts",
                    "line": 1,
                    "symbol": "use0",
                    "kind": "function",
                    "depth": 0,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 2,
                    "symbol": "use1",
                    "kind": "function",
                    "depth": 0,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 3,
                    "symbol": "use2",
                    "kind": "function",
                    "depth": 0,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 4,
                    "symbol": "use3",
                    "kind": "function",
                    "depth": 0,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 5,
                    "symbol": "use4",
                    "kind": "function",
                    "depth": 0,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 6,
                    "symbol": "use5",
                    "kind": "function",
                    "depth": 0,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 7,
                    "symbol": "use6",
                    "kind": "function",
                    "depth": 0,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 8,
                    "symbol": "use7",
                    "kind": "function",
                    "depth": 0,
                    "confidence": 1,
                    "fanIn": 0
                  }
                ],
                "entrypoints": [],
                "cost": {"expansionsUsed": 0}
              }
            }
          },
          "b": {
            "schema": "0.24.0",
            "snapshot": {"repo": "a", "kind": "sha", "sha": "abc"},
            "producer": {"name": "test", "version": "1"},
            "inputs": {
              "trust": "untrusted",
              "scope": "s",
              "declaredScope": {"languages": [], "frameworks": [], "include": [], "exclude": []},
              "content": "c",
              "config": "c",
              "declaredConfig": {},
              "engines": {}
            },
            "evidence": [],
            "status": "partial",
            "cuts": [
              {"kind": "depth", "at": ["same-relative-path.ts::use0"], "limit": 5, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use1"], "limit": 5, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use2"], "limit": 5, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use3"], "limit": 5, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use4"], "limit": 5, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use5"], "limit": 5, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use6"], "limit": 5, "reason": "depth", "reach": {"kind": "anything"}},
              {"kind": "depth", "at": ["same-relative-path.ts::use7"], "limit": 5, "reason": "depth", "reach": {"kind": "anything"}}
            ],
            "value": {
              "reads": [],
              "callSites": [],
              "unmatched": [],
              "external": [],
              "unresolved": [],
              "impact": {
                "seeds": [],
                "symbols": [
                  {
                    "file": "same-relative-path.ts",
                    "line": 1,
                    "symbol": "use0",
                    "kind": "function",
                    "depth": 4,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 2,
                    "symbol": "use1",
                    "kind": "function",
                    "depth": 4,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 3,
                    "symbol": "use2",
                    "kind": "function",
                    "depth": 4,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 4,
                    "symbol": "use3",
                    "kind": "function",
                    "depth": 4,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 5,
                    "symbol": "use4",
                    "kind": "function",
                    "depth": 4,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 6,
                    "symbol": "use5",
                    "kind": "function",
                    "depth": 4,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 7,
                    "symbol": "use6",
                    "kind": "function",
                    "depth": 4,
                    "confidence": 1,
                    "fanIn": 0
                  },
                  {
                    "file": "same-relative-path.ts",
                    "line": 8,
                    "symbol": "use7",
                    "kind": "function",
                    "depth": 4,
                    "confidence": 1,
                    "fanIn": 0
                  }
                ],
                "entrypoints": [],
                "cost": {"expansionsUsed": 0}
              }
            }
          }
        },
        "links": []
      }
    }
  },
  {
    "name": "fixture-7",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [
          {
            "file": "consumer.ts",
            "symbol": "direct",
            "kind": "function",
            "line": 12,
            "endLine": 18,
            "depth": 1,
            "confidence": 0.7,
            "fanIn": 2,
            "via": {"file": "first.ts", "symbol": "first", "lines": [15], "basis": "reference"}
          },
          {"file": "other.ts", "symbol": "deeper", "kind": "function", "line": 22, "depth": 2, "confidence": 1, "fanIn": 0},
          {"file": "other.ts", "symbol": "anotherDeeperConsumer", "kind": "function", "line": 32, "depth": 2, "confidence": 1, "fanIn": 0},
          {"file": "other.ts", "symbol": "thirdDeeperConsumer", "kind": "function", "line": 42, "depth": 2, "confidence": 1, "fanIn": 0},
          {
            "file": "route.ts",
            "symbol": "handler",
            "kind": "function",
            "line": 9,
            "depth": 3,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "consumer.ts", "symbol": "direct", "lines": [11], "basis": "call"}
          }
        ],
        "entrypoints": [
          {
            "kind": "http-route",
            "name": "GET /x",
            "handler": {"path": "route.ts", "line": 9, "symbol": "handler"},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          }
        ],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-8",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [{"file": "src/owners/owner.service.ts", "line": 40, "endLine": 47, "symbol": "OwnerService.searchOwners", "basis": "requested"}],
        "symbols": [
          {
            "file": "src/owners/owner.service.ts",
            "symbol": "OwnerService",
            "kind": "class",
            "line": 12,
            "endLine": 60,
            "depth": 0,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/owners/owner.service.ts", "symbol": "OwnerService.searchOwners", "lines": [], "basis": "contains"}
          },
          {
            "file": "src/owners/owner-list.component.ts",
            "symbol": "OwnerListComponent",
            "kind": "class",
            "line": 9,
            "endLine": 90,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/owners/owner-list.component.ts", "symbol": "OwnerListComponent.findOwners", "lines": [], "basis": "contains"}
          },
          {
            "file": "src/owners/owner-list.component.ts",
            "symbol": "OwnerListComponent.findOwners",
            "kind": "method",
            "line": 44,
            "endLine": 47,
            "depth": 1,
            "confidence": 1,
            "fanIn": 1,
            "via": {"file": "src/owners/owner.service.ts", "symbol": "OwnerService.searchOwners", "lines": [48], "basis": "call"}
          },
          {
            "file": "src/visits/visit.service.ts",
            "symbol": "VisitService.book",
            "kind": "method",
            "line": 30,
            "endLine": 36,
            "depth": 2,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/owners/owner-list.component.ts", "symbol": "OwnerListComponent.findOwners", "lines": [51], "basis": "call"}
          }
        ],
        "entrypoints": [],
        "cost": {"expansionsUsed": 3}
      }
    }
  },
  {
    "name": "fixture-9",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {
            "file": "src/service/ClinicServiceImpl.java",
            "line": 77,
            "endLine": 81,
            "symbol": "ClinicServiceImpl.deletePet",
            "basis": "requested"
          }
        ],
        "symbols": [
          {
            "file": "src/service/ClinicService.java",
            "symbol": "ClinicService",
            "kind": "interface",
            "line": 38,
            "endLine": 74,
            "depth": 0,
            "confidence": 0.9,
            "fanIn": 0,
            "via": {"file": "src/service/ClinicService.java", "symbol": "ClinicService.deletePet", "lines": [], "basis": "contains"}
          },
          {
            "file": "src/service/ClinicService.java",
            "symbol": "ClinicService.deletePet",
            "kind": "method",
            "line": 44,
            "depth": 0,
            "confidence": 0.9,
            "fanIn": 1,
            "via": {"file": "src/service/ClinicServiceImpl.java", "symbol": "ClinicServiceImpl.deletePet", "lines": [], "basis": "dispatch"}
          },
          {
            "file": "src/rest/PetRestController.java",
            "symbol": "PetRestController",
            "kind": "class",
            "line": 38,
            "endLine": 98,
            "depth": 1,
            "confidence": 0.9,
            "fanIn": 0,
            "via": {"file": "src/rest/PetRestController.java", "symbol": "PetRestController.deletePet", "lines": [], "basis": "contains"}
          },
          {
            "file": "src/rest/PetRestController.java",
            "symbol": "PetRestController.deletePet",
            "kind": "method",
            "line": 88,
            "endLine": 96,
            "depth": 1,
            "confidence": 0.9,
            "fanIn": 0,
            "via": {"file": "src/service/ClinicService.java", "symbol": "ClinicService.deletePet", "lines": [94], "basis": "call"}
          },
          {
            "file": "src/rest/PetRestControllerV2.java",
            "symbol": "PetRestControllerV2.remove",
            "kind": "method",
            "line": 20,
            "endLine": 26,
            "depth": 2,
            "confidence": 0.9,
            "fanIn": 0,
            "via": {"file": "src/rest/PetRestController.java", "symbol": "PetRestController.deletePet", "lines": [24], "basis": "call"}
          }
        ],
        "entrypoints": [],
        "cost": {"expansionsUsed": 3}
      }
    }
  },
  {
    "name": "fixture-11",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "src/owners/owner.service.ts", "line": 40, "endLine": 47, "symbol": "OwnerService.searchOwners", "basis": "lines"},
          {"file": "src/visits/visit.service.ts", "line": 12, "endLine": 18, "symbol": "VisitService.book", "basis": "lines"},
          {"file": "src/vets/vet.service.ts", "line": 24, "endLine": 30, "symbol": "VetService.list", "basis": "lines"},
          {"file": "src/pets/pet.service.ts", "line": 8, "endLine": 14, "symbol": "PetService.find", "basis": "lines"}
        ],
        "symbols": [
          {
            "file": "src/owners/owner.service.ts",
            "symbol": "OwnerService",
            "kind": "class",
            "line": 12,
            "endLine": 60,
            "depth": 0,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/owners/owner.service.ts", "symbol": "OwnerService.searchOwners", "lines": [], "basis": "contains"}
          },
          {
            "file": "src/owners/owner-list.component.ts",
            "symbol": "OwnerListComponent.findOwners",
            "kind": "method",
            "line": 44,
            "endLine": 47,
            "depth": 1,
            "confidence": 1,
            "fanIn": 1,
            "via": {"file": "src/owners/owner.service.ts", "symbol": "OwnerService.searchOwners", "lines": [48], "basis": "call"}
          },
          {
            "file": "src/menu/menu.component.ts",
            "symbol": "MenuComponent.showVisits",
            "kind": "method",
            "line": 20,
            "endLine": 26,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/visits/visit.service.ts", "symbol": "VisitService.book", "lines": [22], "basis": "call"}
          }
        ],
        "entrypoints": [],
        "cost": {"expansionsUsed": 2}
      }
    }
  },
  {
    "name": "fixture-16",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          },
          {"file": "unused-a.ts", "symbol": "unusedA", "line": 3, "basis": "lines"},
          {"file": "unused-b.ts", "symbol": "unusedB", "line": 4, "basis": "lines"}
        ],
        "symbols": [],
        "entrypoints": [
          {
            "kind": "http-route",
            "name": "GET /x",
            "handler": {"path": "route.ts", "line": 9, "symbol": "handler"},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /y",
            "handler": {"path": "route.ts", "line": 9, "symbol": "handler"},
            "depth": 1,
            "confidence": 1,
            "seeds": [1]
          }
        ],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-17",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [
          {
            "file": "caller.ts",
            "symbol": "use",
            "kind": "function",
            "line": 12,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "first.ts", "symbol": "first", "lines": [15], "basis": "reference"}
          }
        ],
        "entrypoints": [
          {
            "kind": "http-route",
            "name": "GET /x",
            "handler": {"path": "route.ts", "line": 9, "symbol": "handler"},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          }
        ],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-19",
    "workspace": false,
    "fact": {...BASE, "evidence": [{"path": "src/legacy.cob", "line": 3}], "status": "unknown", "reason": "no-extractor"}
  },
  {"name": "fixture-20", "workspace": false, "fact": {...BASE, "status": "unknown", "reason": "deadline"}},
  {
    "name": "fixture-21",
    "workspace": false,
    "fact": {...BASE, "status": "complete", "value": {"seeds": [], "symbols": [], "entrypoints": [], "cost": {"expansionsUsed": 0}}}
  },
  {
    "name": "fixture-22",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [],
        "symbols": [],
        "entrypoints": [],
        "modules": {
          "origins": [
            {"file": "src/long-module-origin-0.ts", "change": "modified"},
            {"file": "src/long-module-origin-1.ts", "change": "modified"},
            {"file": "src/long-module-origin-2.ts", "change": "modified"},
            {"file": "src/long-module-origin-3.ts", "change": "modified"},
            {"file": "src/long-module-origin-4.ts", "change": "modified"},
            {"file": "src/long-module-origin-5.ts", "change": "modified"},
            {"file": "src/long-module-origin-6.ts", "change": "modified"},
            {"file": "src/long-module-origin-7.ts", "change": "modified"},
            {"file": "src/long-module-origin-8.ts", "change": "modified"},
            {"file": "src/long-module-origin-9.ts", "change": "modified"},
            {"file": "src/long-module-origin-10.ts", "change": "modified"},
            {"file": "src/long-module-origin-11.ts", "change": "modified"},
            {"file": "src/long-module-origin-12.ts", "change": "modified"},
            {"file": "src/long-module-origin-13.ts", "change": "modified"},
            {"file": "src/long-module-origin-14.ts", "change": "modified"},
            {"file": "src/long-module-origin-15.ts", "change": "modified"}
          ],
          "modules": [
            {
              "file": "src/consumer.ts",
              "snapshot": "head",
              "depth": 1,
              "origins": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
              "via": {"file": "src/long-module-origin-0.ts", "line": 7, "specifier": "pkg", "kind": "import", "typeOnly": false}
            },
            {"file": "src/deeper.ts", "snapshot": "head", "depth": 2, "origins": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]}
          ],
          "cost": {"expansionsUsed": 2}
        },
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-23",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [],
        "symbols": [],
        "entrypoints": [],
        "cost": {"expansionsUsed": 0},
        "modules": {
          "origins": [{"file": "src/origin.ts", "change": "modified"}],
          "modules": [
            {
              "file": "src/consumer.ts",
              "snapshot": "head",
              "depth": 1,
              "origins": [0],
              "via": {"file": "src/bridge.ts", "line": 7, "specifier": "./origin", "kind": "import", "typeOnly": false}
            }
          ],
          "cost": {"expansionsUsed": 1}
        }
      }
    }
  },
  {
    "name": "fixture-26",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [],
        "entrypoints": [
          {
            "kind": "http-route",
            "name": "GET /x",
            "handler": {"path": "route.ts", "line": 9, "symbol": "handler"},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          }
        ],
        "cost": {"expansionsUsed": 0},
        "mergeBase": "base-a",
        "modules": {
          "origins": [],
          "modules": [
            {"file": "src/base-0.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-1.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-2.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-3.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-4.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-5.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-6.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-7.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-8.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-9.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-10.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-11.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-12.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-13.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-14.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-15.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-16.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-17.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-18.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-19.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-20.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-21.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-22.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-23.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-24.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-25.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-26.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-27.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-28.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-29.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-30.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-31.ts", "snapshot": "base", "depth": 0, "origins": []},
            {"file": "src/base-32.ts", "snapshot": "base", "depth": 0, "origins": []}
          ],
          "cost": {"expansionsUsed": 0}
        }
      }
    }
  },
  {
    "name": "fixture-29",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "source.ts", "symbol": "seed0", "line": 1, "basis": "top-level"},
          {"file": "source.ts", "symbol": "seed1", "line": 2, "basis": "top-level"},
          {"file": "source.ts", "symbol": "seed2", "line": 3, "basis": "top-level"},
          {"file": "source.ts", "symbol": "seed3", "line": 4, "basis": "top-level"},
          {"file": "source.ts", "symbol": "seed4", "line": 5, "basis": "lines"},
          {"file": "source.ts", "symbol": "seed5", "line": 6, "basis": "lines"},
          {"file": "source.ts", "symbol": "seed6", "line": 7, "basis": "lines"},
          {"file": "source.ts", "symbol": "seed7", "line": 8, "basis": "lines"}
        ],
        "symbols": [
          {
            "file": "consumer.ts",
            "symbol": "use0",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "source.ts", "symbol": "seed0", "lines": [1], "basis": "reference"}
          },
          {
            "file": "consumer.ts",
            "symbol": "use1",
            "kind": "function",
            "line": 2,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "source.ts", "symbol": "seed1", "lines": [2], "basis": "reference"}
          },
          {
            "file": "consumer.ts",
            "symbol": "use2",
            "kind": "function",
            "line": 3,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "source.ts", "symbol": "seed2", "lines": [3], "basis": "reference"}
          },
          {
            "file": "consumer.ts",
            "symbol": "use3",
            "kind": "function",
            "line": 4,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "source.ts", "symbol": "seed3", "lines": [4], "basis": "reference"}
          },
          {
            "file": "consumer.ts",
            "symbol": "use4",
            "kind": "function",
            "line": 5,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "source.ts", "symbol": "seed4", "lines": [5], "basis": "reference"}
          },
          {
            "file": "consumer.ts",
            "symbol": "use5",
            "kind": "function",
            "line": 6,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "source.ts", "symbol": "seed5", "lines": [6], "basis": "reference"}
          },
          {
            "file": "consumer.ts",
            "symbol": "use6",
            "kind": "function",
            "line": 7,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "source.ts", "symbol": "seed6", "lines": [7], "basis": "reference"}
          },
          {
            "file": "consumer.ts",
            "symbol": "use7",
            "kind": "function",
            "line": 8,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "source.ts", "symbol": "seed7", "lines": [8], "basis": "reference"}
          }
        ],
        "entrypoints": [],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-36",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [],
        "entrypoints": [
          {
            "kind": "http-route",
            "name": "GET /route-0",
            "handler": {"path": "src/route-0.ts", "symbol": "handler0", "line": 1},
            "depth": 1,
            "confidence": 1,
            "seeds": [0]
          },
          {
            "kind": "http-route",
            "name": "GET /route-1",
            "handler": {"path": "src/route-1.ts", "symbol": "handler1", "line": 2},
            "depth": 1,
            "confidence": 1,
            "seeds": [0]
          },
          {
            "kind": "http-route",
            "name": "GET /route-2",
            "handler": {"path": "src/route-2.ts", "symbol": "handler2", "line": 3},
            "depth": 1,
            "confidence": 1,
            "seeds": [0]
          },
          {
            "kind": "http-route",
            "name": "GET /route-3",
            "handler": {"path": "src/route-3.ts", "symbol": "handler3", "line": 4},
            "depth": 1,
            "confidence": 1,
            "seeds": [0]
          },
          {
            "kind": "http-route",
            "name": "GET /route-4",
            "handler": {"path": "src/route-4.ts", "symbol": "handler4", "line": 5},
            "depth": 1,
            "confidence": 1,
            "seeds": [0]
          },
          {
            "kind": "http-route",
            "name": "GET /route-5",
            "handler": {"path": "src/route-5.ts", "symbol": "handler5", "line": 6},
            "depth": 1,
            "confidence": 1,
            "seeds": [0]
          },
          {
            "kind": "http-route",
            "name": "GET /route-6",
            "handler": {"path": "src/route-6.ts", "symbol": "handler6", "line": 7},
            "depth": 1,
            "confidence": 1,
            "seeds": [0]
          },
          {
            "kind": "http-route",
            "name": "GET /route-7",
            "handler": {"path": "src/route-7.ts", "symbol": "handler7", "line": 8},
            "depth": 1,
            "confidence": 1,
            "seeds": [0]
          }
        ],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-38",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [],
        "entrypoints": [
          {
            "kind": "http-route",
            "name": "GET /x",
            "handler": {"path": "route.ts", "line": 9, "symbol": "handler"},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          }
        ],
        "cost": {"expansionsUsed": 0},
        "modules": {
          "origins": [{"file": "origin.ts", "change": "modified"}],
          "modules": [{"file": "consumer.ts", "snapshot": "head", "depth": 1, "origins": [0]}],
          "cost": {"expansionsUsed": 1}
        }
      }
    }
  },
  {
    "name": "fixture-40",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "partial",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [],
        "entrypoints": [
          {
            "kind": "http-route",
            "name": "GET /x",
            "handler": {"path": "route.ts", "line": 9, "symbol": "handler"},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          }
        ],
        "cost": {"expansionsUsed": 0}
      },
      "cuts": [{"kind": "depth", "at": ["src/file.ts"], "limit": 1, "reason": "depth", "reach": {"kind": "anything"}}]
    }
  },
  {
    "name": "fixture-41",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [],
        "entrypoints": [
          {
            "kind": "http-route",
            "name": "GET /0",
            "handler": {"path": "route 0:file.ts", "symbol": "handler", "line": 9, "endLine": 14},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /1",
            "handler": {"path": "route 1:file.ts", "symbol": "handler", "line": 9, "endLine": 14},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /2",
            "handler": {"path": "route 2:file.ts", "symbol": "handler", "line": 9, "endLine": 14},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /3",
            "handler": {"path": "route 3:file.ts", "symbol": "handler", "line": 9, "endLine": 14},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /4",
            "handler": {"path": "route 4:file.ts", "symbol": "handler", "line": 9, "endLine": 14},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /5",
            "handler": {"path": "route 5:file.ts", "symbol": "handler", "line": 9, "endLine": 14},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /6",
            "handler": {"path": "route 6:file.ts", "symbol": "handler", "line": 9, "endLine": 14},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /7",
            "handler": {"path": "route 7:file.ts", "symbol": "handler", "line": 9, "endLine": 14},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          }
        ],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-42",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [],
        "entrypoints": [
          {
            "kind": "http-route",
            "name": "GET /0",
            "handler": {"path": "route-0.ts", "symbol": "handler", "line": 9},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /1",
            "handler": {"path": "route-1.ts", "symbol": "handler", "line": 9},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /2",
            "handler": {"path": "route-2.ts", "symbol": "handler", "line": 9},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /3",
            "handler": {"path": "route-3.ts", "symbol": "handler", "line": 9},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /4",
            "handler": {"path": "route-4.ts", "symbol": "handler", "line": 9},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /5",
            "handler": {"path": "route-5.ts", "symbol": "handler", "line": 9},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /6",
            "handler": {"path": "route-6.ts", "symbol": "handler", "line": 9},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          },
          {
            "kind": "http-route",
            "name": "GET /7",
            "handler": {"path": "route-7.ts", "symbol": "default export", "line": 9},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          }
        ],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-45",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [
          {
            "file": "caller.ts",
            "symbol": "use",
            "kind": "method",
            "line": 12,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {
              "file": "store.ts",
              "symbol": "write",
              "lines": [15],
              "basis": "call",
              "substitutes": [{"file": "other.ts", "symbol": "Other", "line": 1, "at": {"file": "providers.ts", "line": 3}}]
            }
          },
          {
            "file": "caller.ts",
            "symbol": "plain",
            "kind": "method",
            "line": 30,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "store.ts", "symbol": "read", "lines": [31], "basis": "call"}
          }
        ],
        "entrypoints": [
          {
            "kind": "http-route",
            "name": "GET /x",
            "handler": {"path": "route.ts", "line": 9, "symbol": "handler"},
            "depth": 1,
            "confidence": 1,
            "seeds": [0, 1]
          }
        ],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-46",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "mergeBase": "def",
        "seeds": [
          {"file": "src/app/order/order.api.ts", "symbol": "checkout", "line": 3, "basis": "lines"},
          {"file": "src/app/home/home.page.ts", "symbol": "load", "line": 5, "basis": "lines"},
          {"file": "src/server.ts", "symbol": "serve", "line": 1, "basis": "lines"}
        ],
        "symbols": [
          {
            "file": "src/app/order/consumers/a-consumer-with-a-long-name.ts",
            "symbol": "aConsumer",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/order.api.ts", "symbol": "checkout", "basis": "call"}
          },
          {
            "file": "src/app/order/consumers/b-consumer-with-a-long-name.ts",
            "symbol": "bConsumer",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/order.api.ts", "symbol": "checkout", "basis": "call"}
          },
          {
            "file": "src/app/order/consumers/c-consumer-with-a-long-name.ts",
            "symbol": "cConsumer",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/order.api.ts", "symbol": "checkout", "basis": "call"}
          },
          {
            "file": "src/app/order/consumers/d-consumer-with-a-long-name.ts",
            "symbol": "dConsumer",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/order.api.ts", "symbol": "checkout", "basis": "call"}
          },
          {
            "file": "src/app/order/consumers/e-consumer-with-a-long-name.ts",
            "symbol": "eConsumer",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/order.api.ts", "symbol": "checkout", "basis": "call"}
          },
          {
            "file": "src/app/order/consumers/f-consumer-with-a-long-name.ts",
            "symbol": "fConsumer",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/order.api.ts", "symbol": "checkout", "basis": "call"}
          },
          {
            "file": "src/app/shell/shell-component-with-a-long-name.ts",
            "symbol": "shell",
            "kind": "function",
            "line": 1,
            "depth": 2,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/consumers/a-consumer-with-a-long-name.ts", "symbol": "aConsumer", "basis": "call"}
          },
          {
            "file": "src/app/home/home-widget-with-a-long-name.ts",
            "symbol": "widget",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/home/home.page.ts", "symbol": "load", "basis": "call"}
          },
          {
            "file": "src/app/orphan-with-a-long-name.ts",
            "symbol": "orphan",
            "kind": "function",
            "line": 1,
            "depth": 2,
            "confidence": 1,
            "fanIn": 0
          }
        ],
        "entrypoints": [
          {
            "kind": "http-route",
            "name": "GET /x",
            "handler": {"path": "route.ts", "line": 9, "symbol": "handler"},
            "depth": 2,
            "confidence": 1,
            "seeds": [0]
          }
        ],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-48",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "mergeBase": "def",
        "seeds": [
          {"file": "src/app/order/order.api.ts", "symbol": "checkout", "line": 3, "basis": "lines"},
          {"file": "src/app/home/home.page.ts", "symbol": "load", "line": 5, "basis": "lines"}
        ],
        "symbols": [
          {
            "file": "src/app/order/consumers/a-consumer-with-a-long-name.ts",
            "symbol": "consumer0",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/order.api.ts", "symbol": "checkout", "basis": "call"}
          },
          {
            "file": "src/app/order/consumers/b-consumer-with-a-long-name.ts",
            "symbol": "consumer1",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/order.api.ts", "symbol": "checkout", "basis": "call"}
          },
          {
            "file": "src/app/order/consumers/c-consumer-with-a-long-name.ts",
            "symbol": "consumer2",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/order.api.ts", "symbol": "checkout", "basis": "call"}
          },
          {
            "file": "src/app/order/consumers/d-consumer-with-a-long-name.ts",
            "symbol": "consumer3",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/order.api.ts", "symbol": "checkout", "basis": "call"}
          },
          {
            "file": "src/app/order/consumers/e-consumer-with-a-long-name.ts",
            "symbol": "consumer4",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/order.api.ts", "symbol": "checkout", "basis": "call"}
          },
          {
            "file": "src/app/order/consumers/f-consumer-with-a-long-name.ts",
            "symbol": "consumer5",
            "kind": "function",
            "line": 1,
            "depth": 1,
            "confidence": 1,
            "fanIn": 0,
            "via": {"file": "src/app/order/order.api.ts", "symbol": "checkout", "basis": "call"}
          }
        ],
        "entrypoints": [],
        "modules": {
          "origins": [{"file": "src/app/order/order.api.ts", "change": "modified"}, {"file": "src/app/home/home.page.ts", "change": "modified"}],
          "modules": [
            {"file": "src/app/order/consumers/a-consumer-with-a-long-name.ts", "snapshot": "head", "depth": 1, "origins": [0]},
            {"file": "src/app/order/consumers/b-consumer-with-a-long-name.ts", "snapshot": "head", "depth": 1, "origins": [0]},
            {"file": "src/app/order/consumers/c-consumer-with-a-long-name.ts", "snapshot": "head", "depth": 1, "origins": [0]},
            {"file": "src/app/order/consumers/d-consumer-with-a-long-name.ts", "snapshot": "head", "depth": 1, "origins": [0]},
            {"file": "src/app/order/consumers/e-consumer-with-a-long-name.ts", "snapshot": "head", "depth": 1, "origins": [0]},
            {"file": "src/app/order/consumers/f-consumer-with-a-long-name.ts", "snapshot": "head", "depth": 1, "origins": [0]}
          ],
          "cost": {"expansionsUsed": 6}
        },
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-49",
    "workspace": false,
    "fact": {
      ...BASE,
      "inputs": {
        "trust": "untrusted",
        "scope": "s",
        "declaredScope": {"languages": [], "frameworks": [], "include": [], "exclude": []},
        "content": "c",
        "config": "c",
        "declaredConfig": {"walk": {"depth": 2, "hubFanIn": 40, "expansions": 9}},
        "engines": {}
      },
      "status": "partial",
      "cuts": [
        {"kind": "depth", "at": ["a.ts::a"], "limit": 2, "reason": "depth", "reach": {"kind": "anything"}},
        {"kind": "hub", "at": ["b.ts::b"], "limit": 40, "reason": "hub", "reach": {"kind": "anything"}},
        {"kind": "caller-budget", "at": ["c.ts::c"], "limit": 9, "reason": "caller-budget", "reach": {"kind": "anything"}}
      ],
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [],
        "entrypoints": [],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-57",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [],
        "symbols": [],
        "entrypoints": [],
        "cost": {"expansionsUsed": 0},
        "settled": [
          {
            "basis": "hunk",
            "file": "src/A.java",
            "base": {"start": 4, "end": 4},
            "head": {"start": 4, "end": 4},
            "reason": "no-token-change"
          },
          {"basis": "hunk", "file": "src/B.ts", "head": {"start": 7, "end": 7}, "reason": "import-order"},
          {"basis": "hunk", "file": "src/C.java", "base": {"start": 9, "end": 9}, "reason": "no-token-change"}
        ]
      }
    }
  },
  {
    "name": "fixture-58",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [],
        "symbols": [],
        "entrypoints": [],
        "cost": {"expansionsUsed": 0},
        "testDependents": "excluded",
        "changedPaths": [
          {"path": "docs/guide.md", "disposition": "not-read"},
          {"path": "src/A.java", "disposition": "walked"},
          {"path": "src/Gone.java", "disposition": "walked", "deleted": true, "removed": ["Gone"]},
          {"path": "src/form.js", "disposition": "outside-scope"},
          {"path": "src/form.test.ts", "disposition": "test"}
        ]
      }
    }
  },
  {
    "name": "fixture-59",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [],
        "symbols": [],
        "entrypoints": [],
        "cost": {"expansionsUsed": 0},
        "settled": [{"basis": "range", "file": "src/A.java", "start": 2, "end": 2, "reason": "no-token", "candidates": ["A"]}]
      }
    }
  },
  {
    "name": "fixture-60",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [],
        "entrypoints": [
          {
            "kind": "ui-route",
            "name": "/orders",
            "handler": {"path": "src/orders.page.ts", "symbol": "OrdersPage", "line": 5},
            "depth": 1,
            "confidence": 1,
            "seeds": [0],
            "declaredAt": {"path": "src/routes.ts", "line": 12}
          }
        ],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-63",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [
          {"file": "src/dep-0.ts", "symbol": "dep0", "kind": "function", "line": 1, "depth": 1, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-1.ts", "symbol": "dep1", "kind": "function", "line": 2, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-2.ts", "symbol": "dep2", "kind": "function", "line": 3, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-3.ts", "symbol": "dep3", "kind": "function", "line": 4, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-4.ts", "symbol": "dep4", "kind": "function", "line": 5, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-5.ts", "symbol": "dep5", "kind": "function", "line": 6, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-6.ts", "symbol": "dep6", "kind": "function", "line": 7, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-7.ts", "symbol": "dep7", "kind": "function", "line": 8, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-8.ts", "symbol": "dep8", "kind": "function", "line": 9, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-9.ts", "symbol": "dep9", "kind": "function", "line": 10, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-10.ts", "symbol": "dep10", "kind": "function", "line": 11, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-11.ts", "symbol": "dep11", "kind": "function", "line": 12, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-12.ts", "symbol": "dep12", "kind": "function", "line": 13, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-13.ts", "symbol": "dep13", "kind": "function", "line": 14, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-14.ts", "symbol": "dep14", "kind": "function", "line": 15, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-15.ts", "symbol": "dep15", "kind": "function", "line": 16, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-16.ts", "symbol": "dep16", "kind": "function", "line": 17, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-17.ts", "symbol": "dep17", "kind": "function", "line": 18, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-18.ts", "symbol": "dep18", "kind": "function", "line": 19, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-19.ts", "symbol": "dep19", "kind": "function", "line": 20, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-20.ts", "symbol": "dep20", "kind": "function", "line": 21, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-21.ts", "symbol": "dep21", "kind": "function", "line": 22, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-22.ts", "symbol": "dep22", "kind": "function", "line": 23, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-23.ts", "symbol": "dep23", "kind": "function", "line": 24, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-24.ts", "symbol": "dep24", "kind": "function", "line": 25, "depth": 3, "confidence": 1, "fanIn": 0},
          {"file": "src/dep-25.ts", "symbol": "dep25", "kind": "function", "line": 26, "depth": 3, "confidence": 1, "fanIn": 0}
        ],
        "entrypoints": [],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-68",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "src/seed-0.ts", "symbol": "s0", "line": 1, "basis": "lines"},
          {"file": "src/seed-1.ts", "symbol": "s1", "line": 1, "basis": "lines"},
          {"file": "src/seed-2.ts", "symbol": "s2", "line": 1, "basis": "lines"},
          {"file": "src/seed-3.ts", "symbol": "s3", "line": 1, "basis": "lines"},
          {"file": "src/seed-4.ts", "symbol": "s4", "line": 1, "basis": "lines"},
          {"file": "src/seed-5.ts", "symbol": "s5", "line": 1, "basis": "lines"},
          {"file": "src/seed-6.ts", "symbol": "s6", "line": 1, "basis": "lines"},
          {"file": "src/seed-7.ts", "symbol": "s7", "line": 1, "basis": "lines"},
          {"file": "src/seed-8.ts", "symbol": "s8", "line": 1, "basis": "lines"},
          {"file": "src/seed-9.ts", "symbol": "s9", "line": 1, "basis": "lines"},
          {"file": "src/seed-10.ts", "symbol": "s10", "line": 1, "basis": "lines"},
          {"file": "src/seed-11.ts", "symbol": "s11", "line": 1, "basis": "lines"},
          {"file": "src/seed-12.ts", "symbol": "s12", "line": 1, "basis": "lines"},
          {"file": "src/seed-13.ts", "symbol": "s13", "line": 1, "basis": "lines"},
          {"file": "src/seed-14.ts", "symbol": "s14", "line": 1, "basis": "lines"},
          {"file": "src/seed-15.ts", "symbol": "s15", "line": 1, "basis": "lines"},
          {"file": "src/seed-16.ts", "symbol": "s16", "line": 1, "basis": "lines"},
          {"file": "src/seed-17.ts", "symbol": "s17", "line": 1, "basis": "lines"},
          {"file": "src/seed-18.ts", "symbol": "s18", "line": 1, "basis": "lines"},
          {"file": "src/seed-19.ts", "symbol": "s19", "line": 1, "basis": "lines"},
          {"file": "src/seed-20.ts", "symbol": "s20", "line": 1, "basis": "lines"},
          {"file": "src/seed-21.ts", "symbol": "s21", "line": 1, "basis": "lines"},
          {"file": "src/seed-22.ts", "symbol": "s22", "line": 1, "basis": "lines"},
          {"file": "src/seed-23.ts", "symbol": "s23", "line": 1, "basis": "lines"},
          {"file": "src/seed-24.ts", "symbol": "s24", "line": 1, "basis": "lines"},
          {"file": "src/seed-25.ts", "symbol": "s25", "line": 1, "basis": "lines"}
        ],
        "symbols": [],
        "entrypoints": [],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "fixture-69",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [
          {"file": "first.ts", "line": 2, "symbol": "first", "basis": "lines"},
          {
            "file": "second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts",
            "line": 8,
            "symbol": "second",
            "basis": "lines"
          }
        ],
        "symbols": [],
        "entrypoints": [
          {
            "kind": "unknown",
            "handler": {"path": "Owners.java", "line": 58, "symbol": "Owners"},
            "depth": 0,
            "confidence": 1,
            "seeds": [0],
            "observations": [
              {
                "status": "unknown",
                "reason": "no-extractor",
                "evidence": [{"path": "Owners.java", "line": 61}],
                "subject": {"candidate": "http-route", "symbol": "Owners", "raisedBy": "OwnersApi"}
              },
              {
                "status": "unknown",
                "reason": "no-extractor",
                "evidence": [{"path": "Owners.java", "line": 61}],
                "subject": {"candidate": "http-route", "symbol": "Owners", "raisedBy": "V2Api"}
              },
              {
                "status": "unknown",
                "reason": "no-extractor",
                "evidence": [{"path": "Owners.java", "line": 61}],
                "subject": {"candidate": "http-route", "symbol": "Owners.show", "raisedBy": "OwnersApi"}
              },
              {
                "status": "unknown",
                "reason": "no-extractor",
                "evidence": [{"path": "Owners.java", "line": 61}],
                "subject": {"candidate": "http-route", "symbol": "Owners", "raisedBy": "V2Api"}
              },
              {
                "status": "unknown",
                "reason": "no-extractor",
                "evidence": [{"path": "Owners.java", "line": 61}],
                "subject": {"candidate": "http-route", "symbol": "Owners.show", "raisedBy": "V2Api"}
              }
            ]
          }
        ],
        "cost": {"expansionsUsed": 0}
      }
    }
  },
  {
    "name": "changed-operation-and-range",
    "workspace": false,
    "fact": {
      ...BASE,
      "status": "complete",
      "value": {
        "seeds": [{"file": "service.ts", "line": 3, "endLine": 8, "symbol": "Service.run", "basis": "requested"}],
        "symbols": [],
        "entrypoints": [],
        "cost": {"expansionsUsed": 0},
        "changedEntrypoints": [
          {
            "kind": "http-route",
            "name": "PUT /items",
            "handler": {"path": "route.ts", "line": 11, "endLine": 20, "symbol": "Routes.put"},
            "change": "altered"
          }
        ],
        "changedContracts": [
          {
            "change": "altered",
            "method": "PUT",
            "path": "/items",
            "operationId": "putItems",
            "document": "api.yaml",
            "line": 37,
            "parts": ["request", "response"]
          }
        ],
        "settled": [{"basis": "range", "file": "empty.ts", "start": 2, "end": 5, "reason": "no-token", "candidates": ["Empty"]}],
        "changedPaths": [{"path": "removed.ts", "disposition": "walked", "deleted": true, "removed": ["Gone"]}]
      }
    }
  }
];
