import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceFile } from "../core/ports/entrypoint-extractor.port.ts";
import { composeAngularRelations } from "./angular-relations.ts";

const CORE = "import { Component, Directive, Pipe, inject } from '@angular/core';\n";

const SOURCES: SourceFile[] = [
  { path: "package.json", content: JSON.stringify({ dependencies: { "@angular/core": "22.0.0" } }) },
  { path: "src/app/orders.service.ts", content: "export class OrdersService {}\n" },
  { path: "src/app/ui/index.ts", content: "export * from './card.component';\nexport { HiDirective as Hi } from './hi.directive';\nexport * from './money.pipe';\n" },
  { path: "src/app/ui/card.component.ts", content: `${CORE}@Component({ selector: 'app-card', template: '' })\nexport class CardComponent {}\n` },
  { path: "src/app/ui/hi.directive.ts", content: `${CORE}\n@Directive({ selector: '[appHi]' })\nexport class HiDirective {}\n` },
  { path: "src/app/ui/money.pipe.ts", content: `${CORE}@Pipe({ name: 'money' })\nexport class MoneyPipe {}\n` },
  {
    path: "src/app/shell/shell.component.ts",
    content: `${CORE}import { CardComponent, Hi, MoneyPipe } from '../ui';\nimport { OrdersService } from '../orders.service';\n\n@Component({ selector: 'app-shell', imports: [CardComponent, Hi, MoneyPipe], templateUrl: './shell.html' })\nexport class ShellComponent {\n  orders = inject(OrdersService);\n}\n`,
  },
  { path: "src/app/shell/shell.html", content: "<app-card appHi></app-card>\n<p>{{ total | money }}</p>\n" },
];

test("an injection and the uses of a template resolve to the classes the barrels re-export, and the same sources give the same findings", async () => {
  const { relations: findings } = await composeAngularRelations().extract(SOURCES);

  assert.deepEqual(
    findings.map((finding) => (finding.status === "complete" ? [finding.value.kind, finding.value.from, finding.value.to, finding.evidence] : finding)),
    [
      ["injects", { path: "src/app/shell/shell.component.ts", symbol: "ShellComponent", line: 6 }, { path: "src/app/orders.service.ts", symbol: "OrdersService", line: 1 }, [{ path: "src/app/shell/shell.component.ts", line: 7 }]],
      ["uses-component", { path: "src/app/shell/shell.component.ts", symbol: "ShellComponent", line: 6 }, { path: "src/app/ui/card.component.ts", symbol: "CardComponent", line: 3 }, [{ path: "src/app/shell/shell.html", line: 1 }]],
      ["uses-directive", { path: "src/app/shell/shell.component.ts", symbol: "ShellComponent", line: 6 }, { path: "src/app/ui/hi.directive.ts", symbol: "HiDirective", line: 4 }, [{ path: "src/app/shell/shell.html", line: 1 }]],
      ["uses-pipe", { path: "src/app/shell/shell.component.ts", symbol: "ShellComponent", line: 6 }, { path: "src/app/ui/money.pipe.ts", symbol: "MoneyPipe", line: 3 }, [{ path: "src/app/shell/shell.html", line: 2 }]],
    ],
  );
  assert.deepEqual(await composeAngularRelations().extract([...SOURCES].reverse()), await composeAngularRelations().extract(SOURCES));
});
