import type { CarrierSite, FlowResult } from "../../domain/contracts/consumer-flow.ts";
import { formatHypothesis } from "../../domain/contracts/hypothesis.ts";
import { provenanceOf } from "../../domain/shared/fact.ts";
import { compositeBase } from "../../domain/topology/composite-inputs.ts";
import type { Link } from "../../domain/topology/link.ts";
import type { AngularMetadataReader } from "../../ports/angular-metadata.port.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import type { ConsumerFlowReader } from "../../ports/consumer-flow.port.ts";
import type { ConsumerSession, ConsumerSources } from "../../ports/consumer-sources.port.ts";
import type { ConsumerTemplateReader } from "../../ports/consumer-template.port.ts";
import type { TemplateFlowReader } from "../../ports/consumer-template-flow.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { createHeadReader, type HeadReaderDeps } from "../snapshot/head-reading.ts";
import { prepareCommit } from "../snapshot/prepared-snapshot.ts";
import { ABORTED, declaredTrustOf, withScratch } from "../snapshot/read-snapshot.ts";
import type { WorkspaceReadOperation } from "../topology/workspace-operation.ts";
import { createConsumerTemplateReader } from "./consumer-templates.ts";

export interface ConsumerSourcesDeps {
  operation: WorkspaceReadOperation;
  heads: HeadReaderDeps;
  digest: Digest;
  /** Reads the TypeScript sources of one repository and follows a value through them. */
  flow(files: readonly SourceFile[], repo: string): Promise<ConsumerFlowReader>;
  metadata: AngularMetadataReader;
  templateFlow: TemplateFlowReader;
}

interface Reading {
  flow: ConsumerFlowReader;
  templates: ConsumerTemplateReader;
  graph: CodeGraphReader | undefined;
}

/**
 * The workspace read of a consequences query: the links the join admitted and, for each repository that calls the
 * operation, its sources and code graph, held until the query has answered. A repository read live, or one the refresh
 * could not provide, has no reader, so a carrier in it is a frontier.
 */
export function createConsumerSources(deps: ConsumerSourcesDeps): ConsumerSources {
  const heads = createHeadReader(deps.heads);
  return {
    async withSession(request, use) {
      const { hypothesis, ...planning } = request;
      const operation = `${hypothesis.method} ${hypothesis.path}`;
      const answered = await deps.operation.withRead(planning, async (read, context) => {
        const { fact } = read;
        if (fact.status === "unknown") return { ok: false as const, fault: { kind: "git-failed" as const, detail: "the workspace read answered nothing" } };
        const { links } = fact.value;
        const callers = new Set(links.filter((link) => isCallOf(link, operation)).map((link) => link.from.repo));

        return withScratch(deps.heads.scratch, async (directory) => {
          const readings = new Map<string, Reading>();
          const stores: CodeGraphReader[] = [];
          try {
            for (const plan of context.plans) {
              if (plan.kind !== "read" || !callers.has(plan.at.repoId)) continue;
              const trust = (await declaredTrustOf(deps.heads, plan.at.declared)) ?? "untrusted";
              const prepared = await prepareCommit({ ...deps.heads, preparation: context.preparation }, plan.at.source, plan.at.revision, directory, context.selection, { scope: context.scope, trust }, context.signal);
              if (!prepared.ok) return prepared;
              const loaded = await prepared.value.sources(context.signal);
              if (!loaded.ok) return loaded;
              const { sources } = loaded.value;
              const indexed = await heads.indexHead(prepared.value.tree, prepared.value.root, directory, context.signal);
              if (indexed === "aborted") return ABORTED;
              if (indexed !== "unavailable") stores.push(indexed.store);
              readings.set(plan.at.repoId, {
                flow: await deps.flow(sources, plan.at.repoId),
                templates: await createConsumerTemplateReader({ metadata: deps.metadata, flow: deps.templateFlow }, sources),
                graph: indexed === "unavailable" ? undefined : indexed.store,
              });
            }

            const { schema, snapshot, producer, inputs } = fact;
            const base = compositeBase(
              { schema, snapshot, producer, inputs, evidence: [] },
              Object.entries(fact.value.sections).map(([repo, section]) => ({ kind: `discovery:${repo}`, fact: provenanceOf(section) })),
              fact.value.workspace,
              (text) => deps.digest.of(text),
              { ...inputs.declaredConfig, hypothesis: formatHypothesis(hypothesis) },
            );
            const session: ConsumerSession = {
              base,
              links,
              cuts: fact.status === "partial" ? fact.cuts : [],
              graph: (repo) => readings.get(repo)?.graph,
              flow: { follow: (carrier) => readings.get(carrier.site.repo)?.flow.follow(carrier) ?? unread(carrier.site) },
              templates: { follow: (carrier) => readings.get(carrier.site.repo)?.templates.follow(carrier) ?? unread(carrier.site) },
            };
            return { ok: true, value: await use(session) };
          } finally {
            for (const store of stores) store.close();
          }
        });
      });
      return answered.ok ? { ok: true, value: answered.value.value } : answered;
    },
  };
}

function isCallOf(link: Link, operation: string): boolean {
  return link.transport === "http" && link.to.kind === "http-route" && link.to.name === operation;
}

function unread(site: CarrierSite): FlowResult {
  const at = { path: site.file, line: site.kind === "member" ? (site.line ?? 1) : site.line };
  return { uses: [], next: [], frontiers: [{ at, cause: "unmodelled-flow", reason: "source-unreadable", hops: [] }] };
}
