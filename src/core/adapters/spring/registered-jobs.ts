import type { Node } from "web-tree-sitter";
import type { Job } from "../../domain/entrypoints/entrypoint.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import { methodSite, spanOf, subjectOf, unknown } from "./findings.ts";
import { argumentsOf } from "./java-members.ts";
import { invocationsOf } from "./java-invocations.ts";
import { externalNames, scopeOf, type JavaProject, type TypeDecl } from "./java-symbols.ts";

/** A library builder that registers a recurring job: the calls that give the job, as a method reference, and its cron. */
interface JobBuilder {
  type: string;
  job: string;
  cron: string;
}

const JOB_BUILDERS: readonly JobBuilder[] = [{ type: "org.jobrunr.scheduling.RecurringJobBuilder", job: "withJobLambda", cron: "withCron" }];

/**
 * The jobs a class registers through a library builder chain that starts at the builder's own static factory. The job
 * is the method the chain's method reference names; a lambda, a reference to another type, or a cron the sources do not
 * give leaves the registration an unknown item that names the handler when it is known.
 */
export function registeredJobsOf(type: TypeDecl, project: JavaProject): Finding<Job>[] {
  return invocationsOf(type).flatMap(({ node, member }): Finding<Job>[] => {
    const name = node.type === "method_invocation" ? node.childForFieldName("name")?.text : undefined;
    const builder = JOB_BUILDERS.find((candidate) => candidate.job === name);
    const chain = chainOf(node);
    if (builder === undefined || chain === undefined || !startsAt(chain.root, builder, type)) return [];
    const span = spanOf(type.file.path, node);
    const raisedBy = `${builder.type}.${builder.job}`;
    const reference = argumentsOf(node)[0];
    const target = reference?.type === "method_reference" && reference.namedChildren[0]?.type === "this" ? reference.namedChildren.at(-1)?.text : undefined;
    const handlers = target === undefined ? [] : project.classChain(type).flatMap((owner) => owner.methods.filter((method) => method.name === target && method.parameterTypes.length === 0 && method.hasBody));
    const [handler, ...others] = handlers;
    if (handler === undefined || others.length > 0) return [unknown("no-extractor", [span], subjectOf("job", member === undefined ? type.qualifiedName : `${type.qualifiedName}.${member.childForFieldName("name")?.text ?? ""}`, raisedBy))];
    const { handler: place } = methodSite(handler);
    const subject = subjectOf("job", place.symbol, raisedBy);
    const cron = chain.calls.find((call) => call.childForFieldName("name")?.text === builder.cron);
    const argument = cron === undefined ? undefined : argumentsOf(cron)[0];
    if (argument === undefined) return [unknown("no-extractor", [span], subject)];
    const evaluation = project.evaluate({ node: argument, scope: scopeOf(type) });
    if ("gap" in evaluation) return [unknown(evaluation.gap, [span, spanOf(type.file.path, argument)], subject)];
    return [{ status: "complete", value: { kind: "job", name: `scheduled cron=${evaluation.value}`, trigger: { attribute: "cron", value: evaluation.value }, handler: place }, evidence: [span] }];
  });
}

/** The calls of a fluent chain, outermost first, and the expression it starts at. */
function chainOf(node: Node): { calls: Node[]; root: Node } | undefined {
  const calls: Node[] = [];
  let current: Node | null = node;
  while (current?.type === "method_invocation") {
    calls.push(current);
    current = current.childForFieldName("object");
  }
  return current === null ? undefined : { calls, root: current };
}

function startsAt(root: Node, builder: JobBuilder, type: TypeDecl): boolean {
  return root.type === "identifier" && externalNames(root.text, type.file, false).includes(builder.type);
}
