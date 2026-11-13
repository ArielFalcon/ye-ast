import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import { ACC_ABSTRACT, ACC_INTERFACE, ACC_PUBLIC, ACC_STATIC, ACC_SUPER, type ClassSpec } from "../core/adapters/jdk/class-file.testing.ts";
import { FUNCTION_SPEC, OBJECT_SPEC, TEMURIN_RELEASE, writeJdkHome } from "../core/adapters/jdk/jdk-home.testing.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";
import { composeCli } from "./compose.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const INTERFACE = ACC_PUBLIC | ACC_INTERFACE | ACC_ABSTRACT;
const ABSTRACT = ACC_PUBLIC | ACC_ABSTRACT;
const OBJECT_SIGNATURE = "<T:Ljava/lang/Object;>Ljava/lang/Object;";

/** The few `java.*` declarations the repository below uses, written as ct.sym states them. */
const JDK: readonly ClassSpec[] = [
  OBJECT_SPEC,
  FUNCTION_SPEC,
  { access: INTERFACE, name: "java/util/function/Predicate", signature: OBJECT_SIGNATURE, members: [{ flags: ABSTRACT, name: "test", descriptor: "(Ljava/lang/Object;)Z", signature: "(TT;)Z" }] },
  { access: INTERFACE, name: "java/util/function/Supplier", signature: OBJECT_SIGNATURE, members: [{ flags: ABSTRACT, name: "get", descriptor: "()Ljava/lang/Object;", signature: "()TT;" }] },
  { access: INTERFACE, name: "java/util/function/BinaryOperator", signature: "<T:Ljava/lang/Object;>Ljava/lang/Object;" },
  {
    access: ACC_PUBLIC | ACC_SUPER,
    name: "java/util/Optional",
    signature: OBJECT_SIGNATURE,
    members: [{ flags: ACC_PUBLIC, name: "orElseThrow", descriptor: "(Ljava/util/function/Supplier;)Ljava/lang/Object;", signature: "<X:Ljava/lang/Throwable;>(Ljava/util/function/Supplier<+TX;>;)TT;^TX;" }],
  },
  {
    access: ACC_PUBLIC | ACC_SUPER,
    name: "java/util/Objects",
    members: [{ flags: ACC_PUBLIC | ACC_STATIC, name: "requireNonNullElse", descriptor: "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", signature: "<T:Ljava/lang/Object;>(TT;TT;)TT;" }],
  },
  {
    access: INTERFACE,
    name: "java/util/stream/Stream",
    signature: OBJECT_SIGNATURE,
    members: [
      { flags: ABSTRACT, name: "map", descriptor: "(Ljava/util/function/Function;)Ljava/util/stream/Stream;", signature: "<R:Ljava/lang/Object;>(Ljava/util/function/Function<-TT;+TR;>;)Ljava/util/stream/Stream<TR;>;" },
      { flags: ABSTRACT, name: "filter", descriptor: "(Ljava/util/function/Predicate;)Ljava/util/stream/Stream;", signature: "(Ljava/util/function/Predicate<-TT;>;)Ljava/util/stream/Stream<TT;>;" },
      { flags: ABSTRACT, name: "reduce", descriptor: "(Ljava/util/function/BinaryOperator;)Ljava/util/Optional;", signature: "(Ljava/util/function/BinaryOperator<TT;>;)Ljava/util/Optional<TT;>;" },
    ],
  },
  { access: INTERFACE, name: "java/util/Collection", signature: "<E:Ljava/lang/Object;>Ljava/lang/Object;", members: [
    { flags: ABSTRACT, name: "stream", descriptor: "()Ljava/util/stream/Stream;", signature: "()Ljava/util/stream/Stream<TE;>;" },
    { flags: ABSTRACT, name: "add", descriptor: "(Ljava/lang/Object;)Z", signature: "(TE;)Z" },
  ] },
  { access: INTERFACE, name: "java/util/List", signature: "<E:Ljava/lang/Object;>Ljava/lang/Object;Ljava/util/Collection<TE;>;", interfaces: ["java/util/Collection"] },
];

const POM = "<project><groupId>shop</groupId><artifactId>orders</artifactId></project>\n";
const HEXAGONAL: Readonly<Record<string, string>> = {
  "pom.xml": POM,
  "src/main/java/shop/CustomersPort.java": "package shop;\npublic interface CustomersPort {\n  String customer(long id);\n}\n",
  "src/main/java/shop/CustomersAdapter.java": `package shop;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;
@Component
public class CustomersAdapter implements CustomersPort {
  private RestTemplate http;
  public String customer(long id) { return http.getForObject("/customers/1", String.class); }
}
`,
  "src/main/java/shop/OrdersService.java": `package shop;
import org.springframework.stereotype.Service;
@Service
public class OrdersService {
  private CustomersPort customers;
  public String checkout(long id) { return customers.customer(id); }
}
`,
  "src/main/java/shop/OrdersController.java": `package shop;
import org.springframework.web.bind.annotation.*;
@RestController
public class OrdersController {
  private OrdersService service;
  @GetMapping("/orders/{id}")
  public String get(@PathVariable long id) { return service.checkout(id); }
}
`,
};
const ROOT = "src/main/java/shop/OrdersController.java:OrdersController.get";
const STREAMS = `package shop;
import java.util.*;
import java.util.function.*;
import java.util.stream.*;
class Util {
  String first(List<String> items) {
    return items.stream().map(x -> x.trim()).filter(x -> !x.isEmpty()).reduce((a, b) -> a).orElseThrow(IllegalStateException::new);
  }
}
`;

let workspace: string;
let repo: string;
let homes = 0;
let homeDirectory: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-"));
  homeDirectory = join(workspace, "jdk");
  repo = join(workspace, "shop");
  mkdirSync(repo);
  mkdirSync(join(workspace, "scratch"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));
after(() => rmSync(homeDirectory, { recursive: true, force: true }));

function commit(files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo, env: GIT_ENV });
}

function jdkHome(types: readonly ClassSpec[] = JDK): Promise<string> {
  homes += 1;
  return writeJdkHome(join(homeDirectory, `home-${homes}`), { release: TEMURIN_RELEASE, signatures: types.map((spec) => ({ set: "OP", spec })) });
}

interface Traced {
  status: string;
  value: TraceValue;
  cuts?: Cut[];
  inputs: { buildOutputs?: { kind: string; at: string; verified: boolean }[] };
}

async function cli(command: string, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })([command, ...argv], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

async function trace(...options: string[]): Promise<Traced> {
  const answer = await cli("trace", ...options, repo, ROOT);
  assert.equal(answer.code, EXIT_CODE.ok, answer.stderr);
  return JSON.parse(answer.stdout);
}

const httpPaths = (value: TraceValue) => value.steps.flatMap((step) => step.effects ?? []).flatMap((effect) => (effect.kind === "http" ? [effect.target.path] : []));
const dispatchCuts = (found: Traced) => (found.cuts ?? []).filter((cut) => JSON.stringify(cut).includes("dispatch not proven") || JSON.stringify(cut).includes("dispatch-not-proven"));
const STEPS_TO_ADAPTER = ["get", "checkout", "customer", "customer"];

test("a port whose only function values go to JDK library methods is followed to its adapter's request once the JDK is declared, and not before", async () => {
  commit({ ...HEXAGONAL, "src/main/java/shop/Util.java": STREAMS });
  const plain = await trace();
  const declared = await trace("--jdk", await jdkHome());

  assert.equal(plain.status, "partial");
  assert.deepEqual(httpPaths(plain.value), []);
  assert.ok(dispatchCuts(plain).length > 0, JSON.stringify(plain.cuts));
  assert.deepEqual(declared.value.steps.map((step) => step.symbol), STEPS_TO_ADAPTER);
  assert.deepEqual(httpPaths(declared.value), ["/customers/1"]);
  assert.equal(declared.status, "complete");
  assert.deepEqual(declared.inputs.buildOutputs?.map(({ kind, at, verified }) => ({ kind, at, verified })), [{ kind: "jdk", at: "", verified: false }]);
});

test("a function value that a library parameter cannot settle keeps the cut with the JDK declared", async () => {
  const uses: Readonly<Record<string, string>> = {
    "an element added to a list of the port (a type variable parameter)": "void run(List<CustomersPort> ports) { ports.add(id -> \"\"); }",
    "the port as a sibling argument of a generic method (fixture 4)": "CustomersPort port; void run() { Objects.requireNonNullElse(port, id -> \"\"); }",
    "the port written on a declaration (fixture 3)": "CustomersPort p = id -> \"\";",
    "a receiver outside the JDK": "void run(org.acme.Mapper mapper) { mapper.map(x -> x); }",
    "a library class the JDK does not hold": "void run(java.util.concurrent.Executor executor) { executor.execute(() -> {}); }",
  };
  const home = await jdkHome();
  for (const [context, member] of Object.entries(uses)) {
    commit({ ...HEXAGONAL, "src/main/java/shop/Util.java": `${STREAMS.replace(/class Util \{[\s\S]*$/, "")}class Util { ${member} }\n` });
    const found = await trace("--jdk", home);
    assert.equal(found.status, "partial", context);
    assert.deepEqual(httpPaths(found.value), [], context);
    assert.ok(dispatchCuts(found).length > 0, context);
  }
});

test("a declared JDK that holds none of the types the repository uses leaves the cut", async () => {
  commit({ ...HEXAGONAL, "src/main/java/shop/Util.java": STREAMS });
  const found = await trace("--jdk", await jdkHome([OBJECT_SPEC]));

  assert.equal(found.status, "partial");
  assert.deepEqual(httpPaths(found.value), []);
});

test("a declared JDK that holds nothing the repository uses answers a trace as without it but for the recorded input, and callers is the same with or without library function values", async () => {
  commit({ ...HEXAGONAL, "src/main/java/shop/Util.java": STREAMS });
  const plain = await trace();
  const { inputs: declaredInputs, ...declared } = await trace("--jdk", await jdkHome([OBJECT_SPEC]));
  const { inputs: plainInputs, ...plainRest } = plain;
  const adapterCallers = async () => JSON.parse((await cli("callers", repo, "src/main/java/shop/CustomersAdapter.java:CustomersAdapter.customer")).stdout).value;
  const withValues = await adapterCallers();
  commit({ "src/main/java/shop/Util.java": "package shop;\nclass Util { String first(java.util.List<String> items) { return items.get(0); } }\n" });

  assert.deepEqual(declared, plainRest);
  assert.deepEqual(declaredInputs.buildOutputs?.map(({ kind }) => kind), ["jdk"]);
  assert.equal("buildOutputs" in plainInputs, false);
  assert.deepEqual(await adapterCallers(), withValues);
  assert.ok(JSON.stringify(withValues).includes("OrdersController"), "callers reaches the controller through the port");
});
