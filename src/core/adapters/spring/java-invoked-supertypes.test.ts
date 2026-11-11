import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { withJavaSources } from "./java-project.ts";
import { createJavaProject } from "./java-symbols.ts";
import { readHierarchy } from "./java-dispatch-targets.ts";

test("retains settled invoked supertypes through local types and leaves ambiguous names unsettled", async () => {
  const sources = [
    { path: "app/Types.java", content: `package app;
import org.springframework.security.core.userdetails.UserDetailsService;
import graphql.schema.DataFetcher;
import jakarta.validation.ConstraintValidator;
class A implements UserDetailsService {}
interface V extends ConstraintValidator<String, String> {}
class B implements V {}
class C extends A {}
class D implements org.springframework.security.core.userdetails.UserDetailsService {}
class E implements DataFetcher {}
class Holder { Object value = new UserDetailsService() {}; }
` },
    { path: "app/Ambiguous.java", content: `package app;
import first.*;
import second.*;
class Ambiguous implements UserDetailsService {}` },
  ];
  const parser = await createJavaParser();
  withJavaSources(parser, (parse) => {
    const { files } = parse(sources);
    const project = createJavaProject(files);
    const hierarchy = readHierarchy(files, project);
    const contract = "org.springframework.security.core.userdetails.UserDetailsService";
    assert.deepEqual(hierarchy.invokedSupertypes.get(contract)?.map((type) => type.name), ["A", "C", "D"]);
    assert.deepEqual(hierarchy.invokedSupertypes.get("jakarta.validation.ConstraintValidator")?.map((type) => type.name), ["V", "B"]);
    assert.deepEqual(hierarchy.invokedSupertypes.get("graphql.schema.DataFetcher")?.map((type) => type.name), ["E"]);
    const ambiguous = project.types.find((type) => type.name === "Ambiguous")!;
    assert.deepEqual(hierarchy.unsettledSupertypes.get(ambiguous), ["UserDetailsService"]);
    assert.ok([...hierarchy.invokedSupertypes.values()].every((types) => !types.includes(ambiguous)));
    const unplaced = hierarchy.unplaced.find(({ fqns }) => fqns.includes(contract));
    assert.deepEqual([unplaced?.file.path, unplaced?.node.type, unplaced?.node.startPosition.row], ["app/Types.java", "object_creation_expression", 10]);
  });
});
