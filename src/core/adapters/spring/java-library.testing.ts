import type { LibraryMember, LibraryReading, LibrarySignatures, LibraryType } from "../../ports/library-signatures.port.ts";

interface MemberFlags {
  static?: true;
  abstract?: true;
  varargs?: true;
  typeParameters?: readonly string[];
}

/** A method as a library signature states it: its parameter and return types in source form, fully qualified. */
export function member(name: string, parameters: readonly string[], returns: string, flags: MemberFlags = {}): LibraryMember {
  return { name, typeParameters: flags.typeParameters ?? [], parameters, returns, static: flags.static === true, abstract: flags.abstract === true, varargs: flags.varargs === true };
}

interface TypeShape {
  kind?: LibraryType["kind"];
  typeParameters?: readonly string[];
  supertypes?: readonly string[];
  members?: readonly LibraryMember[];
}

function type({ kind = "interface", typeParameters = [], supertypes = [], members = [] }: TypeShape): LibraryType {
  return { kind, abstract: kind === "interface", typeParameters, supertypes, members };
}

const OBJECT_MEMBERS = [member("equals", ["java.lang.Object"], "boolean"), member("hashCode", [], "int"), member("toString", [], "java.lang.String")];

/** A small `java.*` of hand-written declarations, enough for the library contexts of the function-value proof. */
export function jdkTypes(): Record<string, LibraryType> {
  return {
    "java.lang.Object": type({ kind: "class", members: OBJECT_MEMBERS }),
    "java.lang.String": type({ kind: "class", supertypes: ["java.lang.Object"], members: [member("trim", [], "java.lang.String")] }),
    "java.lang.Runnable": type({ members: [member("run", [], "void", { abstract: true })] }),
    "java.lang.Iterable": type({ typeParameters: ["T"], members: [member("forEach", ["java.util.function.Consumer<? super T>"], "void")] }),
    "java.util.Collection": type({
      typeParameters: ["E"],
      supertypes: ["java.lang.Iterable<E>"],
      members: [member("stream", [], "java.util.stream.Stream<E>"), member("add", ["E"], "boolean", { abstract: true }), member("removeIf", ["java.util.function.Predicate<? super E>"], "boolean"), member("toArray", ["java.lang.Object[]"], "java.lang.Object[]")],
    }),
    "java.util.List": type({
      typeParameters: ["E"],
      supertypes: ["java.util.Collection<E>"],
      members: [member("add", ["E"], "boolean", { abstract: true }), member("get", ["int"], "E", { abstract: true }), member("subList", ["int", "int"], "java.util.List<E>", { abstract: true }), member("of", ["E[]"], "java.util.List<E>", { static: true, varargs: true, typeParameters: ["E"] })],
    }),
    "java.util.ArrayList": type({ kind: "class", typeParameters: ["E"], supertypes: ["java.lang.Object", "java.util.List<E>"] }),
    "java.awt.List": type({ kind: "class", supertypes: ["java.lang.Object"] }),
    "java.util.Optional": type({
      kind: "class",
      typeParameters: ["T"],
      supertypes: ["java.lang.Object"],
      members: [
        member("orElseThrow", ["java.util.function.Supplier<? extends X>"], "T", { typeParameters: ["X extends java.lang.Throwable"] }),
        member("orElse", ["T"], "T"),
        member("map", ["java.util.function.Function<? super T, ? extends U>"], "java.util.Optional<U>", { typeParameters: ["U"] }),
      ],
    }),
    "java.util.Objects": type({
      kind: "class",
      supertypes: ["java.lang.Object"],
      members: [
        member("requireNonNull", ["T", "java.util.function.Supplier<java.lang.String>"], "T", { static: true, typeParameters: ["T"] }),
        member("requireNonNullElse", ["T", "T"], "T", { static: true, typeParameters: ["T"] }),
        member("requireNonNullElseGet", ["T", "java.util.function.Supplier<? extends T>"], "T", { static: true, typeParameters: ["T"] }),
      ],
    }),
    "java.util.Comparator": type({
      typeParameters: ["T"],
      members: [
        member("compare", ["T", "T"], "int", { abstract: true }),
        member("equals", ["java.lang.Object"], "boolean", { abstract: true }),
        member("reversed", [], "java.util.Comparator<T>"),
        member("comparing", ["java.util.function.Function<? super T, ? extends U>"], "java.util.Comparator<T>", { static: true, typeParameters: ["T", "U"] }),
      ],
    }),
    "java.util.stream.BaseStream": type({ typeParameters: ["T", "S"], members: [member("close", [], "void", { abstract: true })] }),
    "java.util.stream.Stream": type({
      typeParameters: ["T"],
      supertypes: ["java.util.stream.BaseStream<T, java.util.stream.Stream<T>>"],
      members: [
        member("map", ["java.util.function.Function<? super T, ? extends R>"], "java.util.stream.Stream<R>", { abstract: true, typeParameters: ["R"] }),
        member("filter", ["java.util.function.Predicate<? super T>"], "java.util.stream.Stream<T>", { abstract: true }),
        member("reduce", ["java.util.function.BinaryOperator<T>"], "java.util.Optional<T>", { abstract: true }),
        member("reduce", ["T", "java.util.function.BinaryOperator<T>"], "T", { abstract: true }),
        member("collect", ["java.util.stream.Collector<? super T, A, R>"], "R", { abstract: true, typeParameters: ["R", "A"] }),
        member("of", ["T[]"], "java.util.stream.Stream<T>", { static: true, varargs: true, typeParameters: ["T"] }),
      ],
    }),
    "java.util.stream.Collector": type({
      typeParameters: ["T", "A", "R"],
      members: [member("of", ["java.util.function.Supplier<R>", "java.util.function.BiConsumer<R, T>", "java.util.function.BinaryOperator<R>", "java.util.stream.Collector.Characteristics[]"], "java.util.stream.Collector<T, R, R>", { static: true, varargs: true, typeParameters: ["T", "R"] })],
    }),
    "java.util.function.Function": type({
      typeParameters: ["T", "R"],
      members: [member("apply", ["T"], "R", { abstract: true }), member("andThen", ["java.util.function.Function<? super R, ? extends V>"], "java.util.function.Function<T, V>", { typeParameters: ["V"] }), member("identity", [], "java.util.function.Function<T, T>", { static: true, typeParameters: ["T"] })],
    }),
    "java.util.function.BiFunction": type({ typeParameters: ["T", "U", "R"], members: [member("apply", ["T", "U"], "R", { abstract: true })] }),
    "java.util.function.BinaryOperator": type({ typeParameters: ["T"], supertypes: ["java.util.function.BiFunction<T, T, T>"] }),
    "java.util.function.BiConsumer": type({ typeParameters: ["T", "U"], members: [member("accept", ["T", "U"], "void", { abstract: true })] }),
    "java.util.function.Consumer": type({ typeParameters: ["T"], members: [member("accept", ["T"], "void", { abstract: true })] }),
    "java.util.function.Predicate": type({ typeParameters: ["T"], members: [member("test", ["T"], "boolean", { abstract: true })] }),
    "java.util.function.Supplier": type({ typeParameters: ["T"], members: [member("get", [], "T", { abstract: true })] }),
  };
}

/** The declared JDK for every path, over the given types. */
export function librariesOf(types: Readonly<Record<string, LibraryType>> = jdkTypes()): LibraryReading {
  const signatures: LibrarySignatures = {
    basis: { version: "25", feature: 25, release: 25, basis: "declared-jdk", digest: "fake" },
    typeOf: (fqn) => types[fqn],
  };
  return { of: () => signatures };
}

/** The types with one member of a type replaced: a table entry that lacks a flag, or states another. */
export function withMember(types: Record<string, LibraryType>, fqn: string, name: string, change: Partial<LibraryMember>): Record<string, LibraryType> {
  const held = types[fqn]!;
  return { ...types, [fqn]: { ...held, members: held.members.map((candidate) => (candidate.name === name ? { ...candidate, ...change } : candidate)) } };
}
