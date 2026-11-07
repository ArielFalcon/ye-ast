import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_FLOW, type CarrierSite } from "../../domain/contracts/consumer-flow.ts";
import type { AngularClass } from "../../domain/relations/angular-class.ts";
import type { AngularMetadataReader } from "../../ports/angular-metadata.port.ts";
import type { TemplateFlowReader } from "../../ports/consumer-template-flow.port.ts";
import type { TemplateUnit } from "../../ports/template-usage.port.ts";
import { createConsumerTemplateReader } from "./consumer-templates.ts";

type CallResult = Extract<CarrierSite, { kind: "template-call-result" }>;

const FILE = "src/app/views.ts";
const component = (symbol: string, line: number, template: NonNullable<Extract<AngularClass, { kind: "component" }>["template"]>): AngularClass => ({
  kind: "component",
  ref: { path: FILE, symbol, line },
  template,
  imports: [],
  hostDirectives: [],
});

const SOURCE = ["@Component({ template: `", "<p>{{ a(x) }}</p>`", "})", "class First {}", "", "@Component({ template: `", "<p>{{ b(x) }}</p>`", "})", "class Second {}", ""].join("\n");

function readerOf(classes: readonly AngularClass[], contents: Record<string, string>) {
  const seen: TemplateUnit[] = [];
  const metadata: AngularMetadataReader = { read: async () => ({ classes, findings: [], fields: [], locals: [] }) };
  const flow: TemplateFlowReader = {
    follow(unit) {
      seen.push(unit);
      return NO_FLOW;
    },
  };
  const files = Object.entries(contents).map(([path, content]) => ({ path, content }));
  return { seen, reader: createConsumerTemplateReader({ metadata, flow }, files) };
}

const call = (start: number, resource = FILE): CallResult => ({ kind: "template-call-result", repo: "r", resource, start, end: start + 4, callee: "a", argument: 0 });

test("the result of a template call is read in the template that holds the expression: two inline templates in one file stay apart", async () => {
  const classes = [component("First", 1, { inline: { text: "\n<p>{{ a(x) }}</p>", line: 2 } }), component("Second", 6, { inline: { text: "\n<p>{{ b(x) }}</p>", line: 7 } })];
  const { seen, reader } = readerOf(classes, { [FILE]: SOURCE });
  const secondStart = SOURCE.indexOf("<p>{{ b(x)") + 7;

  (await reader).follow({ site: call(SOURCE.indexOf("<p>{{ a(x)") + 7), path: [] });
  (await reader).follow({ site: call(secondStart), path: [] });

  assert.deepEqual(
    seen.map((unit) => unit.component.symbol),
    ["First", "Second"],
  );
});

test("the result of a template call in a template of its own file is read in that file", async () => {
  const classes = [component("First", 1, { file: { path: "src/app/first.html", at: { path: FILE, line: 1 } } })];
  const { seen, reader } = readerOf(classes, { [FILE]: SOURCE, "src/app/first.html": "<p>{{ a(x) }}</p>" });

  (await reader).follow({ site: call(3, "src/app/first.html"), path: [] });

  assert.deepEqual(
    seen.map((unit) => [unit.path, unit.offset]),
    [["src/app/first.html", undefined]],
  );
});

test("the result of a template call whose template cannot be placed is a frontier, never an empty answer", async () => {
  const { reader } = readerOf([component("First", 1, { inline: { text: "x", line: 2 } })], { [FILE]: SOURCE });

  const result = (await reader).follow({ site: call(0, "src/app/gone.html"), path: [] });

  assert.deepEqual(
    result.frontiers.map((frontier) => [frontier.at.path, frontier.cause, frontier.reason]),
    [["src/app/gone.html", "unmodelled-flow", "source-unreadable"]],
  );
});
