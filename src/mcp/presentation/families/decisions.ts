import type { Fact } from "../../../core/domain/shared/fact.ts";
import type { DecisionValue } from "../../../core/ports/decision-queries.port.ts";
import { renderFactNarrowing, renderFactStatus } from "../../presentation-context.ts";
import type { Presentation } from "../model.ts";
import { cutSection, nameRow, repositorySourceLine } from "../rows.ts";

export function present(fact: Fact<DecisionValue>): Presentation {
  return {
    status: renderFactStatus(fact), snapshots: fact.status === "unknown" || fact.value.repositories.length === 0 ? [fact.snapshot] : fact.value.repositories.map(item => item.snapshot),
    narrowing: [...renderFactNarrowing(fact), ...(fact.status === "unknown" ? [] : [repositorySourceLine(fact.value.source)])],
    sections: fact.status === "unknown" ? [] : [
      { id: "value.decisions", title: `decisions (${fact.value.decisions.length})`, role: "context", layout: "list", primary: true, rows: fact.value.decisions.map(decision => nameRow(decision)) },
      { id: "value.undecidedBase", title: "names whose base is undecided", role: "context", layout: "list", rows: (fact.value.undecidedBase ?? []).map(name => nameRow(name)) },
      cutSection(fact.status === "partial" ? fact.cuts : []),
    ],
  };
}
