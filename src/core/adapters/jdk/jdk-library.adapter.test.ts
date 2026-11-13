import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { LibraryOutcome, LibrarySignatures } from "../../ports/library-signatures.port.ts";
import { ACC_INTERFACE, ACC_PUBLIC, ACC_SUPER, buildClass } from "./class-file.testing.ts";
import { createJdkLibrarySource } from "./jdk-library.adapter.ts";
import { FUNCTION_SPEC, OBJECT_SPEC, TEMURIN_RELEASE, writeJdkHome } from "./jdk-home.testing.ts";

let scratch: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ye-ast-jdk-library-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function nextDirectory(): string {
  counter += 1;
  return join(scratch, `home-${counter}`);
}

function used(outcome: LibraryOutcome): LibrarySignatures {
  assert.equal(outcome.kind, "used", JSON.stringify(outcome));
  return (outcome as Extract<LibraryOutcome, { kind: "used" }>).signatures;
}

const ENTRY_SPEC = { access: ACC_PUBLIC | ACC_INTERFACE, name: "java/util/Map$Entry", signature: "<K:Ljava/lang/Object;V:Ljava/lang/Object;>Ljava/lang/Object;" } as const;

test("the module layout and the layout without a module directory both hold java types, and only java types", async () => {
  const withModule = await writeJdkHome(nextDirectory(), {
    release: TEMURIN_RELEASE.replace("25.0.5", "25.0.1"),
    signatures: [
      { set: "OP", spec: OBJECT_SPEC },
      { set: "OP", spec: FUNCTION_SPEC },
      { set: "OP", module: "jdk.internal.misc", spec: { access: ACC_PUBLIC | ACC_SUPER, name: "jdk/internal/misc/Unsafe" } },
      { set: "OP", spec: ENTRY_SPEC },
    ],
  });
  const without = await writeJdkHome(nextDirectory(), {
    release: 'JAVA_VERSION="25"\n',
    signatures: [{ set: "OP", module: null, spec: OBJECT_SPEC }, { set: "OP", module: null, spec: FUNCTION_SPEC }],
  });
  const source = createJdkLibrarySource();

  const modular = used(source.open({ path: withModule }));
  assert.deepEqual(modular.typeOf("java.util.function.Function")?.members.map((member) => member.name), ["apply"]);
  assert.equal(modular.typeOf("java.util.Map.Entry")?.kind, "interface");
  assert.equal(modular.typeOf("jdk.internal.misc.Unsafe"), undefined);
  assert.equal(modular.typeOf("java.util.function.Missing"), undefined);
  assert.equal(used(source.open({ path: without })).typeOf("java.util.function.Function")?.members[0]?.parameters.length, 1);
});

test("a release set letter covers the releases it names, and a type is held only where its set covers the JDK's release", async () => {
  const home = await writeJdkHome(nextDirectory(), {
    release: 'JAVA_VERSION="11.0.2"\n',
    signatures: [
      { set: "89A", spec: OBJECT_SPEC },
      { set: "89A", spec: FUNCTION_SPEC },
      { set: "B", spec: { access: ACC_PUBLIC | ACC_SUPER, name: "java/util/Later" } },
    ],
  });
  const eleven = createJdkLibrarySource().open({ path: home });
  assert.equal(eleven.kind, "unused");
  assert.equal(eleven.kind === "unused" && eleven.reason, "release-not-held");

  const ten = await writeJdkHome(nextDirectory(), {
    release: 'JAVA_VERSION="10"\n',
    signatures: [{ set: "89A", spec: OBJECT_SPEC }, { set: "89A", spec: FUNCTION_SPEC }, { set: "B", spec: { access: ACC_PUBLIC | ACC_SUPER, name: "java/util/Later" } }],
  });
  const signatures = used(createJdkLibrarySource().open({ path: ten }));
  assert.ok(signatures.typeOf("java.util.function.Function"));
  assert.equal(signatures.typeOf("java.util.Later"), undefined);
  assert.equal(signatures.basis.feature, 10);
});

test("two entries covering one type at the release make it not held, never the first one", async () => {
  const home = await writeJdkHome(nextDirectory(), {
    release: 'JAVA_VERSION="25.0.1"\n',
    signatures: [
      { set: "OP", spec: OBJECT_SPEC },
      { set: "P", spec: FUNCTION_SPEC },
      { set: "OP", spec: FUNCTION_SPEC },
    ],
  });
  const signatures = used(createJdkLibrarySource().open({ path: home }));
  assert.equal(signatures.typeOf("java.util.function.Function"), undefined);
  assert.ok(signatures.typeOf("java.lang.Object"));
});

test("an entry whose class is not the one its path names is not held", async () => {
  const home = await writeJdkHome(nextDirectory(), {
    release: 'JAVA_VERSION="25"\n',
    signatures: [],
    members: [
      { name: "P/java.base/java/lang/Object.sig", content: buildClass(OBJECT_SPEC) },
      { name: "P/java.base/java/util/function/Function.sig", content: buildClass({ ...FUNCTION_SPEC, name: "java/util/function/Other" }) },
    ],
  });
  assert.equal(used(createJdkLibrarySource().open({ path: home })).typeOf("java.util.function.Function"), undefined);
});

test("the release file states the feature, the version and the vendor", async () => {
  const cases = [
    { text: TEMURIN_RELEASE, feature: 25, version: "25.0.5", vendor: "Eclipse Adoptium" },
    { text: 'JAVA_VERSION="1.8.0_392"\n', feature: 8, version: "1.8.0_392", vendor: undefined },
    { text: "JAVA_VERSION=26-ea\r\nIMPLEMENTOR=Acme\r\n", feature: 26, version: "26-ea", vendor: "Acme" },
  ];
  for (const { text, feature, version, vendor } of cases) {
    const home = await writeJdkHome(nextDirectory(), { release: text, signatures: [{ set: "89ABCDEFGHIJKLMNOPQ", spec: OBJECT_SPEC }] });
    const { basis } = used(createJdkLibrarySource().open({ path: home }));
    assert.equal(basis.feature, feature, text);
    assert.equal(basis.release, feature, text);
    assert.equal(basis.version, version, text);
    assert.equal(basis.vendor, vendor, text);
    assert.equal(basis.basis, "declared-jdk");
    assert.match(basis.digest, /^[0-9a-f]{64}$/);
  }
});

test("a JDK 8 home, a home without a release file and a link are unreadable", async () => {
  const eight = await writeJdkHome(nextDirectory(), {
    release: 'JAVA_VERSION="1.8.0_392"\n',
    signatures: [],
    members: [{ name: "META-INF/sym/rt.jar/java/lang/Object.class", content: "CLASS" }],
  });
  const noRelease = await writeJdkHome(nextDirectory(), { signatures: [{ set: "P", spec: OBJECT_SPEC }] });
  const linked = await writeJdkHome(nextDirectory(), { release: 'JAVA_VERSION="25"\n', signatures: [{ set: "P", spec: OBJECT_SPEC }] });
  await rm(join(linked, "release"));
  await writeFile(join(scratch, "elsewhere"), 'JAVA_VERSION="25"\n');
  await symlink(join(scratch, "elsewhere"), join(linked, "release"));
  const source = createJdkLibrarySource();
  for (const path of [eight, noRelease, linked, join(scratch, "absent")]) {
    assert.deepEqual(source.open({ path }), { kind: "unused", reason: "jdk-unreadable" }, path);
  }
});

test("a type is decoded once per archive digest and release, whatever path the archive is read from", async () => {
  const spec = { signatures: [{ set: "P", spec: OBJECT_SPEC }, { set: "P", spec: FUNCTION_SPEC }], release: 'JAVA_VERSION="25"\n' } as const;
  const first = await writeJdkHome(nextDirectory(), spec);
  const second = await writeJdkHome(nextDirectory(), spec);
  const source = createJdkLibrarySource();
  const one = used(source.open({ path: first }));
  const two = used(source.open({ path: second }));
  assert.equal(one.typeOf("java.util.function.Function"), two.typeOf("java.util.function.Function"));
  assert.equal(one.basis.digest, two.basis.digest);
});

const REAL_HOME = join(homedir(), "Library/Java/JavaVirtualMachines/temurin-25.0.5/Contents/Home");

test("conformance: the real Temurin 25 home decodes Stream.map at release 25", { skip: existsSync(join(REAL_HOME, "lib", "ct.sym")) ? false : `no Temurin 25 home at ${REAL_HOME}` }, () => {
  const signatures = used(createJdkLibrarySource().open({ path: REAL_HOME }));
  assert.equal(signatures.basis.feature, 25);
  const maps = signatures.typeOf("java.util.stream.Stream")?.members.filter((member) => member.name === "map" && member.parameters.length === 1) ?? [];
  assert.equal(maps.length, 1);
  assert.match(maps[0]!.parameters[0]!, /^java\.util\.function\.Function(<|$)/);
  assert.equal(signatures.typeOf("java.util.Map.Entry")?.kind, "interface");
});
