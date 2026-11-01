import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredIdentifier } from "./declared-identifiers.ts";

test("keyword declarations name what they declare, whatever modifiers precede them", () => {
  const lines: Array<[string, string]> = [
    ["export function loadOrder(id: string) {", "loadOrder"],
    ["export default async function* stream() {", "stream"],
    ["  export abstract class OrderService {", "OrderService"],
    ["public final class Order {", "Order"],
    ["interface Port {", "Port"],
    ["export enum Status {", "Status"],
    ["public record Point(int x, int y) {", "Point"],
    ["export type Id = string;", "Id"],
    ["declare namespace Shop {", "Shop"],
    ["export const TAX_RATE = 0.2;", "TAX_RATE"],
    ["let counter = 0;", "counter"],
    ["var legacy;", "legacy"],
  ];
  for (const [line, name] of lines) assert.equal(declaredIdentifier(line), name, line);
});

test("a member names itself when it has a modifier, a return type or a body", () => {
  const lines: Array<[string, string]> = [
    ["  public BigDecimal total(Order order) {", "total"],
    ["  private static void audit(String message);", "audit"],
    ["  Order find(String id) {", "find"],
    ["  async fetchAll(): Promise<Order[]> {", "fetchAll"],
    ["  total() {", "total"],
    ["  private audit(String message);", "audit"],
    ["  void audit(String message);", "audit"],
    ["  public void total(Order order,", "total"],
  ];
  for (const [line, name] of lines) assert.equal(declaredIdentifier(line), name, line);
});

test("an import, a call, a control statement and an annotation declare nothing", () => {
  const lines = [
    'import { Order } from "./order";',
    "import type Order from './order';",
    "import java.util.List;",
    "  order.total();",
    "  total();",
    "  return total(order);",
    "  await load(id);",
    "  if (ready) {",
    "  } else if (retry(3)) {",
    "  @Override",
    "  const { a, b } = pair;",
  ];
  for (const line of lines) assert.equal(declaredIdentifier(line), undefined, line);
});
