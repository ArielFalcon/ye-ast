import type { Frozen } from "../migration.testing.ts";

/**
 * The identities and sizes of the legacy `renderTrace` text of each fixture of `trace.fixtures.testing.ts`,
 * frozen from commit 615583226 before the family moved to the presentation model (RFC-0041 U6).
 */
export const TRACE_LEGACY: Readonly<Record<string, Frozen>> = {
 "nested steps with leaves, external calls and effects": {
  "summary": [
   "place src/order.ts:1-30",
   "place src/order.ts:15",
   "place src/order.ts:16",
   "place src/tax.ts:7",
   "place src/tax.ts:8",
   "route GET /rates",
   "route POST /orders/checkout"
  ],
  "details": [
   "place src/config.ts:7",
   "place src/flat-tax.ts:3-6",
   "place src/order.ts:1-30",
   "place src/order.ts:15",
   "place src/order.ts:16",
   "place src/order.ts:40",
   "place src/tax.ts:4-9",
   "place src/tax.ts:7",
   "place src/tax.ts:8",
   "route GET /rates",
   "route POST /orders/checkout"
  ],
  "bytes": {
   "summary": 586,
   "details": 1133
  }
 },
 "large: nineteen steps over three files with repeated calls": {
  "summary": [
   "place src/checkout/checkout.service.ts:1-140",
   "place src/checkout/checkout.service.ts:40",
   "place src/checkout/checkout.service.ts:92",
   "place src/pricing/pricing.service.ts:11",
   "place src/tax/tax.service.ts:13",
   "route GET /rates",
   "route POST /orders"
  ],
  "details": [
   "place src/checkout/checkout.service.ts:1-140",
   "place src/checkout/checkout.service.ts:40",
   "place src/checkout/checkout.service.ts:92",
   "place src/pricing/pricing.service.ts:1-140",
   "place src/pricing/pricing.service.ts:10-40",
   "place src/pricing/pricing.service.ts:11",
   "place src/tax/tax.service.ts:1-140",
   "place src/tax/tax.service.ts:12",
   "place src/tax/tax.service.ts:13",
   "place src/tax/tax.service.ts:50-58",
   "place src/tax/tax.service.ts:6-14",
   "route GET /rates",
   "route POST /orders"
  ],
  "bytes": {
   "summary": 781,
   "details": 1775
  }
 },
 "partial: unresolved-link, depth and build-output cuts": {
  "summary": [
   "anchor src/flow.ts::deep",
   "place src/order.ts:1-30",
   "place src/order.ts:15",
   "place src/order.ts:16",
   "place src/tax.ts:7",
   "place src/tax.ts:8",
   "route GET /rates",
   "route POST /orders/checkout"
  ],
  "details": [
   "anchor src/a.ts::A.handle",
   "anchor src/b.ts::B.handle",
   "anchor src/c.ts::Client.send",
   "anchor src/flow.ts::deep",
   "anchor src/s.ts::Store.save",
   "cut place src/order.ts:15",
   "cut place src/order.ts:18",
   "cut place src/order.ts:22",
   "cut place src/pet-edit.html:3",
   "place src/config.ts:7",
   "place src/flat-tax.ts:3-6",
   "place src/order.ts:1-30",
   "place src/order.ts:15",
   "place src/order.ts:16",
   "place src/order.ts:40",
   "place src/tax.ts:4-9",
   "place src/tax.ts:7",
   "place src/tax.ts:8",
   "route GET /rates",
   "route POST /orders/checkout"
  ],
  "bytes": {
   "summary": 1172,
   "details": 1691
  }
 },
 "partial: a function value awaiting a declared JDK": {
  "summary": [
   "place src/order.ts:1-30",
   "place src/order.ts:15",
   "place src/order.ts:16",
   "place src/tax.ts:7",
   "place src/tax.ts:8",
   "route GET /rates",
   "route POST /orders/checkout"
  ],
  "details": [
   "anchor src/a.ts::A.handle",
   "cut place src/lib.ts:4",
   "cut place src/order.ts:15",
   "place src/config.ts:7",
   "place src/flat-tax.ts:3-6",
   "place src/order.ts:1-30",
   "place src/order.ts:15",
   "place src/order.ts:16",
   "place src/order.ts:40",
   "place src/tax.ts:4-9",
   "place src/tax.ts:7",
   "place src/tax.ts:8",
   "route GET /rates",
   "route POST /orders/checkout"
  ],
  "bytes": {
   "summary": 1059,
   "details": 1529
  }
 },
 "workspace links and unlinked call sites": {
  "summary": [
   "confidence 0.6",
   "place src/OrderController.java:30",
   "place src/checkout/checkout.service.ts:24",
   "place src/checkout/checkout.service.ts:26",
   "place src/http/client.ts:10-16",
   "place src/http/client.ts:12",
   "place src/http/client.ts:20",
   "route DELETE /gone",
   "route DELETE /gone:",
   "route POST /orders",
   "symbol OrderController.create",
   "symbol api"
  ],
  "details": [
   "confidence 0.6",
   "place src/OrderController.java:30",
   "place src/checkout/checkout.service.ts:24",
   "place src/checkout/checkout.service.ts:26",
   "place src/http/client.ts:10-16",
   "place src/http/client.ts:12",
   "place src/http/client.ts:20",
   "route DELETE /gone",
   "route DELETE /gone:",
   "route POST /orders",
   "symbol OrderController.create",
   "symbol api"
  ],
  "bytes": {
   "summary": 932,
   "details": 977
  }
 },
 "requested ranges that hold no token": {
  "summary": [
   "place src/order.ts:12-20",
   "place src/order.ts:8-9"
  ],
  "details": [
   "place src/order.ts:12-20",
   "place src/order.ts:8-9"
  ],
  "bytes": {
   "summary": 348,
   "details": 388
  }
 },
 "complete with no steps": {
  "summary": [],
  "details": [],
  "bytes": {
   "summary": 217,
   "details": 224
  }
 },
 "unknown fact": {
  "summary": [
   "entry unknown (index-unavailable)",
   "place src/gone.ts:1"
  ],
  "details": [
   "entry unknown (index-unavailable)",
   "place src/gone.ts:1"
  ],
  "bytes": {
   "summary": 119,
   "details": 119
  }
 }
};
