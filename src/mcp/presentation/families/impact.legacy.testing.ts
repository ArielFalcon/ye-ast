import type { Frozen } from "../migration.testing.ts";
export const IMPACT_LEGACY: Readonly<Record<string, Frozen>> = {
  "fixture-0": {
    "summary": [
      "entry http-route GET /x",
      "route GET /x"
    ],
    "details": [
      "entry http-route GET /x",
      "place first.ts:2",
      "route GET /x"
    ],
    "bytes": {
      "summary": 703,
      "details": 713
    }
  },
  "fixture-3": {
    "summary": [
      "place consumer.ts:3",
      "place consumer.ts:5",
      "place consumer.ts:9",
      "via src"
    ],
    "details": [
      "place consumer.ts:3",
      "place consumer.ts:5",
      "place consumer.ts:9",
      "via src"
    ],
    "bytes": {
      "summary": 424,
      "details": 390
    }
  },
  "fixture-4": {
    "summary": [
      "place same-relative-path.ts:1",
      "place same-relative-path.ts:2",
      "place same-relative-path.ts:3",
      "place same-relative-path.ts:4",
      "place same-relative-path.ts:5",
      "place same-relative-path.ts:6",
      "place same-relative-path.ts:7",
      "place same-relative-path.ts:8"
    ],
    "details": [
      "anchor same-relative-path.ts::use0",
      "anchor same-relative-path.ts::use1",
      "anchor same-relative-path.ts::use2",
      "anchor same-relative-path.ts::use3",
      "anchor same-relative-path.ts::use4",
      "anchor same-relative-path.ts::use5",
      "anchor same-relative-path.ts::use6",
      "anchor same-relative-path.ts::use7",
      "place same-relative-path.ts:1",
      "place same-relative-path.ts:2",
      "place same-relative-path.ts:3",
      "place same-relative-path.ts:4",
      "place same-relative-path.ts:5",
      "place same-relative-path.ts:6",
      "place same-relative-path.ts:7",
      "place same-relative-path.ts:8"
    ],
    "bytes": {
      "summary": 2316,
      "details": 2923
    }
  },
  "fixture-7": {
    "summary": [
      "confidence 0.7",
      "entry http-route GET /x",
      "place consumer.ts:12-18",
      "place other.ts:22",
      "place other.ts:32",
      "place other.ts:42",
      "place route.ts:9",
      "route GET /x",
      "via consumer.ts",
      "via first.ts"
    ],
    "details": [
      "confidence 0.7",
      "entry http-route GET /x",
      "place consumer.ts:12-18",
      "place first.ts:2",
      "place route.ts:9",
      "route GET /x",
      "via consumer.ts",
      "via first.ts"
    ],
    "bytes": {
      "summary": 1015,
      "details": 1018
    }
  },
  "fixture-8": {
    "summary": [
      "place src/owners/owner-list.component.ts:44-47",
      "place src/owners/owner-list.component.ts:9-90",
      "place src/owners/owner.service.ts:12-60",
      "place src/visits/visit.service.ts:30-36",
      "via OwnerListComponent.findOwners",
      "via OwnerService.searchOwners",
      "via src"
    ],
    "details": [
      "place src/owners/owner-list.component.ts:44-47",
      "place src/owners/owner-list.component.ts:9-90",
      "via OwnerListComponent.findOwners",
      "via src"
    ],
    "bytes": {
      "summary": 883,
      "details": 725
    }
  },
  "fixture-9": {
    "summary": [
      "confidence 0.9",
      "place src/rest/PetRestController.java:38-98",
      "place src/rest/PetRestController.java:88-96",
      "place src/rest/PetRestControllerV2.java:20-26",
      "place src/service/ClinicService.java:38-74",
      "place src/service/ClinicService.java:44",
      "via ClinicService.deletePet",
      "via PetRestController.deletePet",
      "via src"
    ],
    "details": [
      "confidence 0.9",
      "place src/rest/PetRestController.java:38-98",
      "place src/rest/PetRestController.java:88-96",
      "place src/service/ClinicService.java:38-74",
      "place src/service/ClinicService.java:44",
      "via ClinicService.deletePet",
      "via PetRestController.deletePet",
      "via src"
    ],
    "bytes": {
      "summary": 1111,
      "details": 1039
    }
  },
  "fixture-11": {
    "summary": [
      "place src/menu/menu.component.ts:20-26",
      "place src/owners/owner-list.component.ts:44-47",
      "place src/owners/owner.service.ts:12-60",
      "via OwnerService.searchOwners",
      "via src"
    ],
    "details": [
      "place src/menu/menu.component.ts:20-26",
      "place src/owners/owner-list.component.ts:44-47",
      "via src"
    ],
    "bytes": {
      "summary": 959,
      "details": 925
    }
  },
  "fixture-16": {
    "summary": [
      "entry http-route GET /x",
      "entry http-route GET /y",
      "route GET /x",
      "route GET /y"
    ],
    "details": [
      "entry http-route GET /x",
      "entry http-route GET /y",
      "place first.ts:2",
      "place second-origin-with-a-long-navigable-path-for-the-summary-comparison.ts:8",
      "route GET /x",
      "route GET /y"
    ],
    "bytes": {
      "summary": 944,
      "details": 1053
    }
  },
  "fixture-17": {
    "summary": [
      "entry http-route GET /x",
      "place caller.ts:12",
      "route GET /x",
      "via first.ts"
    ],
    "details": [
      "entry http-route GET /x",
      "place caller.ts:12",
      "place first.ts:2",
      "route GET /x",
      "via first.ts"
    ],
    "bytes": {
      "summary": 761,
      "details": 800
    }
  },
  "fixture-19": {
    "summary": [
      "entry unknown (no-extractor)",
      "place src/legacy.cob:3"
    ],
    "details": [
      "entry unknown (no-extractor)",
      "place src/legacy.cob:3"
    ],
    "bytes": {
      "summary": 167,
      "details": 167
    }
  },
  "fixture-20": {
    "summary": [
      "entry unknown (deadline)"
    ],
    "details": [
      "entry unknown (deadline)"
    ],
    "bytes": {
      "summary": 234,
      "details": 234
    }
  },
  "fixture-21": {
    "summary": [],
    "details": [],
    "bytes": {
      "summary": 116,
      "details": 116
    }
  },
  "fixture-22": {
    "summary": [
      "via import"
    ],
    "details": [
      "via import"
    ],
    "bytes": {
      "summary": 805,
      "details": 852
    }
  },
  "fixture-23": {
    "summary": [
      "via import"
    ],
    "details": [
      "via import"
    ],
    "bytes": {
      "summary": 664,
      "details": 666
    }
  },
  "fixture-26": {
    "summary": [
      "entry http-route GET /x",
      "route GET /x"
    ],
    "details": [
      "entry http-route GET /x",
      "place first.ts:2",
      "route GET /x"
    ],
    "bytes": {
      "summary": 2454,
      "details": 2464
    }
  },
  "fixture-29": {
    "summary": [
      "place consumer.ts:1",
      "place consumer.ts:2",
      "place consumer.ts:3",
      "place consumer.ts:4",
      "place consumer.ts:5",
      "place consumer.ts:6",
      "place consumer.ts:7",
      "place consumer.ts:8",
      "place source.ts:1",
      "place source.ts:2",
      "place source.ts:3",
      "place source.ts:4",
      "place source.ts:5",
      "place source.ts:6",
      "place source.ts:7",
      "place source.ts:8",
      "via source.ts"
    ],
    "details": [
      "place consumer.ts:1",
      "place consumer.ts:2",
      "place consumer.ts:3",
      "place consumer.ts:4",
      "place consumer.ts:5",
      "place consumer.ts:6",
      "place consumer.ts:7",
      "place consumer.ts:8",
      "place source.ts:1",
      "place source.ts:2",
      "place source.ts:3",
      "place source.ts:4",
      "place source.ts:5",
      "place source.ts:6",
      "place source.ts:7",
      "place source.ts:8",
      "via source.ts"
    ],
    "bytes": {
      "summary": 818,
      "details": 818
    }
  },
  "fixture-36": {
    "summary": [
      "entry http-route GET /route-0",
      "entry http-route GET /route-1",
      "entry http-route GET /route-2",
      "entry http-route GET /route-3",
      "entry http-route GET /route-4",
      "entry http-route GET /route-5",
      "entry http-route GET /route-6",
      "entry http-route GET /route-7",
      "place src/route-0.ts:1",
      "place src/route-1.ts:2",
      "place src/route-2.ts:3",
      "place src/route-3.ts:4",
      "place src/route-4.ts:5",
      "place src/route-5.ts:6",
      "place src/route-6.ts:7",
      "place src/route-7.ts:8",
      "route GET /route-0",
      "route GET /route-1",
      "route GET /route-2",
      "route GET /route-3",
      "route GET /route-4",
      "route GET /route-5",
      "route GET /route-6",
      "route GET /route-7",
      "symbol handler0",
      "symbol handler1",
      "symbol handler2",
      "symbol handler3",
      "symbol handler4",
      "symbol handler5",
      "symbol handler6",
      "symbol handler7"
    ],
    "details": [
      "entry http-route GET /route-0",
      "entry http-route GET /route-1",
      "entry http-route GET /route-2",
      "entry http-route GET /route-3",
      "entry http-route GET /route-4",
      "entry http-route GET /route-5",
      "entry http-route GET /route-6",
      "entry http-route GET /route-7",
      "place first.ts:2",
      "place src/route-0.ts:1",
      "place src/route-1.ts:2",
      "place src/route-2.ts:3",
      "place src/route-3.ts:4",
      "place src/route-4.ts:5",
      "place src/route-5.ts:6",
      "place src/route-6.ts:7",
      "place src/route-7.ts:8",
      "route GET /route-0",
      "route GET /route-1",
      "route GET /route-2",
      "route GET /route-3",
      "route GET /route-4",
      "route GET /route-5",
      "route GET /route-6",
      "route GET /route-7",
      "symbol handler0",
      "symbol handler1",
      "symbol handler2",
      "symbol handler3",
      "symbol handler4",
      "symbol handler5",
      "symbol handler6",
      "symbol handler7"
    ],
    "bytes": {
      "summary": 1235,
      "details": 1156
    }
  },
  "fixture-38": {
    "summary": [
      "entry http-route GET /x",
      "route GET /x"
    ],
    "details": [
      "entry http-route GET /x",
      "place first.ts:2",
      "route GET /x"
    ],
    "bytes": {
      "summary": 1009,
      "details": 1017
    }
  },
  "fixture-40": {
    "summary": [
      "entry http-route GET /x",
      "route GET /x"
    ],
    "details": [
      "entry http-route GET /x",
      "place first.ts:2",
      "route GET /x"
    ],
    "bytes": {
      "summary": 958,
      "details": 869
    }
  },
  "fixture-41": {
    "summary": [
      "entry http-route GET /0",
      "entry http-route GET /1",
      "entry http-route GET /2",
      "entry http-route GET /3",
      "entry http-route GET /4",
      "entry http-route GET /5",
      "entry http-route GET /6",
      "entry http-route GET /7",
      "place route 0:file.ts:9-14",
      "place route 1:file.ts:9-14",
      "place route 2:file.ts:9-14",
      "place route 3:file.ts:9-14",
      "place route 4:file.ts:9-14",
      "place route 5:file.ts:9-14",
      "place route 6:file.ts:9-14",
      "place route 7:file.ts:9-14",
      "route GET /0",
      "route GET /1",
      "route GET /2",
      "route GET /3",
      "route GET /4",
      "route GET /5",
      "route GET /6",
      "route GET /7",
      "symbol handler"
    ],
    "details": [
      "entry http-route GET /0",
      "entry http-route GET /1",
      "entry http-route GET /2",
      "entry http-route GET /3",
      "entry http-route GET /4",
      "entry http-route GET /5",
      "entry http-route GET /6",
      "entry http-route GET /7",
      "place first.ts:2",
      "place route 0:file.ts:9-14",
      "place route 1:file.ts:9-14",
      "place route 2:file.ts:9-14",
      "place route 3:file.ts:9-14",
      "place route 4:file.ts:9-14",
      "place route 5:file.ts:9-14",
      "place route 6:file.ts:9-14",
      "place route 7:file.ts:9-14",
      "route GET /0",
      "route GET /1",
      "route GET /2",
      "route GET /3",
      "route GET /4",
      "route GET /5",
      "route GET /6",
      "route GET /7",
      "symbol handler"
    ],
    "bytes": {
      "summary": 1404,
      "details": 1431
    }
  },
  "fixture-42": {
    "summary": [
      "entry http-route GET /0",
      "entry http-route GET /1",
      "entry http-route GET /2",
      "entry http-route GET /3",
      "entry http-route GET /4",
      "entry http-route GET /5",
      "entry http-route GET /6",
      "entry http-route GET /7",
      "route GET /0",
      "route GET /1",
      "route GET /2",
      "route GET /3",
      "route GET /4",
      "route GET /5",
      "route GET /6",
      "route GET /7"
    ],
    "details": [
      "entry http-route GET /0",
      "entry http-route GET /1",
      "entry http-route GET /2",
      "entry http-route GET /3",
      "entry http-route GET /4",
      "entry http-route GET /5",
      "entry http-route GET /6",
      "entry http-route GET /7",
      "place first.ts:2",
      "route GET /0",
      "route GET /1",
      "route GET /2",
      "route GET /3",
      "route GET /4",
      "route GET /5",
      "route GET /6",
      "route GET /7"
    ],
    "bytes": {
      "summary": 1917,
      "details": 1944
    }
  },
  "fixture-45": {
    "summary": [
      "entry http-route GET /x",
      "place caller.ts:12",
      "place caller.ts:30",
      "place providers.ts:3",
      "route GET /x",
      "via store.ts"
    ],
    "details": [
      "entry http-route GET /x",
      "place caller.ts:12",
      "place caller.ts:30",
      "place first.ts:2",
      "place providers.ts:3",
      "route GET /x",
      "via store.ts"
    ],
    "bytes": {
      "summary": 866,
      "details": 876
    }
  },
  "fixture-46": {
    "summary": [
      "entry http-route GET /x",
      "route GET /x"
    ],
    "details": [
      "entry http-route GET /x",
      "place src/app/home/home-widget-with-a-long-name.ts:1",
      "place src/app/order/consumers/a-consumer-with-a-long-name.ts:1",
      "place src/app/order/consumers/b-consumer-with-a-long-name.ts:1",
      "place src/app/order/consumers/c-consumer-with-a-long-name.ts:1",
      "place src/app/order/consumers/d-consumer-with-a-long-name.ts:1",
      "place src/app/order/consumers/e-consumer-with-a-long-name.ts:1",
      "place src/app/order/consumers/f-consumer-with-a-long-name.ts:1",
      "place src/app/order/order.api.ts:3",
      "route GET /x",
      "via src"
    ],
    "bytes": {
      "summary": 1250,
      "details": 1818
    }
  },
  "fixture-48": {
    "summary": [],
    "details": [
      "place src/app/order/consumers/a-consumer-with-a-long-name.ts:1",
      "place src/app/order/consumers/b-consumer-with-a-long-name.ts:1",
      "place src/app/order/consumers/c-consumer-with-a-long-name.ts:1",
      "place src/app/order/consumers/d-consumer-with-a-long-name.ts:1",
      "place src/app/order/consumers/e-consumer-with-a-long-name.ts:1",
      "place src/app/order/consumers/f-consumer-with-a-long-name.ts:1",
      "via src"
    ],
    "bytes": {
      "summary": 1034,
      "details": 2191
    }
  },
  "fixture-49": {
    "summary": [],
    "details": [
      "anchor a.ts::a",
      "anchor b.ts::b",
      "anchor c.ts::c"
    ],
    "bytes": {
      "summary": 1176,
      "details": 1033
    }
  },
  "fixture-57": {
    "summary": [],
    "details": [
      "symbol head"
    ],
    "bytes": {
      "summary": 147,
      "details": 243
    }
  },
  "fixture-58": {
    "summary": [],
    "details": [],
    "bytes": {
      "summary": 321,
      "details": 324
    }
  },
  "fixture-59": {
    "summary": [],
    "details": [],
    "bytes": {
      "summary": 149,
      "details": 144
    }
  },
  "fixture-60": {
    "summary": [
      "entry ui-route /orders",
      "place src/routes.ts:12"
    ],
    "details": [
      "entry ui-route /orders",
      "place first.ts:2",
      "place src/routes.ts:12"
    ],
    "bytes": {
      "summary": 550,
      "details": 514
    }
  },
  "fixture-63": {
    "summary": [
      "place src/dep-0.ts:1"
    ],
    "details": [
      "place src/dep-0.ts:1"
    ],
    "bytes": {
      "summary": 547,
      "details": 524
    }
  },
  "fixture-68": {
    "summary": [],
    "details": [],
    "bytes": {
      "summary": 211,
      "details": 211
    }
  },
  "fixture-69": {
    "summary": [
      "entry unknown (no-extractor) for http-route Owners (raised by OwnersApi)",
      "entry unknown (no-extractor) for http-route Owners (raised by V2Api)",
      "entry unknown (no-extractor) for http-route Owners.show (raised by OwnersApi)",
      "entry unknown (no-extractor) for http-route Owners.show (raised by V2Api)",
      "place Owners.java:61"
    ],
    "details": [
      "entry unknown (no-extractor) for http-route Owners (raised by OwnersApi)",
      "entry unknown (no-extractor) for http-route Owners (raised by V2Api)",
      "entry unknown (no-extractor) for http-route Owners.show (raised by OwnersApi)",
      "entry unknown (no-extractor) for http-route Owners.show (raised by V2Api)",
      "place Owners.java:61",
      "place first.ts:2"
    ],
    "bytes": {
      "summary": 861,
      "details": 825
    }
  },
  "changed-operation-and-range": {
    "summary": [
      "entry http-route PUT /items",
      "place api.yaml:37",
      "place route.ts:11-20",
      "route PUT /items",
      "symbol Routes.put"
    ],
    "details": [
      "entry http-route PUT /items",
      "place api.yaml:37",
      "place route.ts:11-20",
      "route PUT /items",
      "symbol Routes.put"
    ],
    "bytes": {
      "summary": 446,
      "details": 439
    }
  }
};
