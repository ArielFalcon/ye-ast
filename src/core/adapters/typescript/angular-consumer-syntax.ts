import ts from "typescript";
import type { AngularConsumerSyntaxFactory, ExpressionHandle, InputSyntax, ResolverSyntax, RouteDataSyntax } from "../../ports/angular-consumer-syntax.port.ts";
import type { ImportedName } from "../../ports/router-vocabulary.port.ts";
import { TypeScriptReading } from "./consumer-readers.ts";
import { lineOf, propertyOf, unwrapped } from "./syntax.ts";
import { memberSite } from "./consumer-flow.walker.ts";
import type { Unit } from "./consumer-flow.index.ts";
import { readAngularRouteFile } from "./angular-router.extractor.ts";
import { coreExternalOf, readAngularMetadataFile } from "./angular-metadata.extractor.ts";
import { modulesOf } from "./angular-routes.adapter.ts";
import { loadRouteTables, type RouteTable } from "./route-table.loader.ts";
import { createModuleResolver, manifestPackages } from "./module-resolver.ts";
import { Walker } from "./consumer-flow.walker.ts";
import { importedNameOf } from "./imported-name.ts";
import { moduleShape } from "./module-shape.ts";
import { createDeclarationLookup } from "./declaration-lookup.ts";
import { isModified, mutatedTarget } from "./consumer-flow.syntax.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import { manifestsOf, projectOf } from "./angular-projects.ts";

function nameOf(unit: Unit, expression: ts.Expression): ImportedName | undefined {
  return importedNameOf(expression, unit.imports, unit.declared);
}

function typeNameOf(unit: Unit, name: ts.EntityName): ImportedName | undefined {
  if (ts.isIdentifier(name)) return importedNameOf(name, unit.imports, unit.declared, "type");
  const base = typeNameOf(unit, name.left);
  return base === undefined ? undefined : { ...base, members: [...base.members, name.right.text] };
}

export const createAngularConsumerSyntax: AngularConsumerSyntaxFactory = async (reading, repo, router) => {
  if (!(reading instanceof TypeScriptReading)) return undefined;
  const program = await reading.program();
  const files = new Map(reading.files.map((file) => [file.path, file]));
  const packages = manifestPackages(reading.files);
  const read = async (path: string) => files.get(path)?.content;
  const resolver = createModuleResolver(read, packages, { listing: [...files.keys()] });
  const declarationOf = createDeclarationLookup(async (file) => {
    const unit = program.index.units.get(file);
    return unit === undefined ? undefined : moduleShape(unit.tree);
  }, async (file, specifier) => {
    const result = await resolver.resolve(file, specifier);
    return "file" in result ? result.file : undefined;
  });
  const namespaceImporters = new Map<string, { unit: Unit; local: string }[]>();
  for (const unit of program.index.units.values()) for (const [local, binding] of unit.imports) {
    if (binding.imported !== "*" || binding.typeOnly === true) continue;
    const target = await resolver.resolve(unit.file, binding.module);
    if (!("file" in target)) continue;
    const members = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === local) members.add(node.name.text);
      node.forEachChild(visit);
    };
    visit(unit.tree);
    for (const member of members) {
      const origin = await declarationOf(target.file, member);
      if (origin === undefined) continue;
      const key = `${origin.file}\0${origin.name}`;
      namespaceImporters.set(key, [...(namespaceImporters.get(key) ?? []), { unit, local }]);
    }
  }
  const graph = await loadRouteTables({ candidates: [...files.keys()].filter(isTypeScriptSource), listing: [...files.keys()], packages, router, read, reading: async (path) => {
    const unit = program.index.units.get(path);
    if (unit === undefined) return undefined;
    const routes = readAngularRouteFile(unit.tree, router);
    if (routes === undefined) return undefined;
    const external = await coreExternalOf(routes, async (specifier) => "external" in await resolver.resolve(path, specifier));
    return { routes, modules: modulesOf(readAngularMetadataFile(unit.tree, routes, false, external)) };
  } });
  const routes: ResolverSyntax[] = [];
  const unresolvedResolvers: { at: { path: string; line: number }; reason: "unresolved" }[] = [];
  const bootstraps = new Map<string, { path: string; line: number; offset: number }[]>();
  const initializers = new Map<string, { unit: Unit; value: ts.Expression } | undefined>();
  const initializer = (unit: Unit, name: string, safeCall?: ts.CallExpression): { unit: Unit; value: ts.Expression } | undefined => {
    const origin = unit.imports.has(name) ? program.index.origin(unit.file, name) : { file: unit.file, name };
    if (origin === undefined || origin === "external") return undefined;
    const source = program.index.units.get(origin.file);
    if (source === undefined || (source.declared.get(origin.name) ?? 0) !== 1) return undefined;
    const key = `${origin.file}\0${origin.name}\0${safeCall === undefined ? "" : `${unit.file}:${safeCall.getStart(unit.tree)}`}`;
    if (initializers.has(key)) return initializers.get(key);
    const inspect = (): { unit: Unit; value: ts.Expression } | undefined => {
      let mutated = false;
      const check = (node: ts.Node, local: string, owner: Unit): void => {
        if (ts.isIdentifier(node) && node.text === local) {
          let target: ts.Node = node;
          while ((ts.isPropertyAccessExpression(target.parent) || ts.isElementAccessExpression(target.parent)) && target.parent.expression === target) target = target.parent;
          const parent = target.parent;
          if (isModified(target) || ts.isPrefixUnaryExpression(parent) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken) || ts.isPostfixUnaryExpression(parent) || ts.isCallExpression(parent) && parent.expression === target && target !== node) mutated = true;
          if (ts.isCallExpression(parent) && mutatedTarget(parent) === target) mutated = true;
          if (ts.isVariableDeclaration(parent) && parent.initializer === target || ts.isBinaryExpression(parent) && parent.right === target && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) mutated = true;
          if (ts.isCallExpression(parent) && parent !== safeCall && parent.arguments.some((argument) => argument === target)) {
            const callee = nameOf(owner, parent.expression);
            const path = callee?.binding?.imported === "*" ? callee.members : [callee?.binding?.imported, ...(callee?.members ?? [])];
            const bootstrap = callee?.binding?.module === "@angular/platform-browser" && path.join(".") === "bootstrapApplication";
            if (!bootstrap && (callee === undefined || router.configurationOf(callee) === undefined)) mutated = true;
          }
        }
        node.forEachChild((child) => check(child, local, owner));
      };
      check(source.tree, origin.name, source);
      for (const importer of program.index.units.values()) for (const [local, binding] of importer.imports) {
        if (binding.imported === "*") continue;
        const resolved = program.index.origin(importer.file, local);
        if (resolved !== undefined && resolved !== "external" && resolved.file === origin.file && resolved.name === origin.name) {
          if (importer.declared.has(local)) return undefined;
          check(importer.tree, local, importer);
        }
      }
      for (const importer of namespaceImporters.get(`${origin.file}\0${origin.name}`) ?? []) {
        if (importer.unit.declared.has(importer.local)) return undefined;
        check(importer.unit.tree, importer.local, importer.unit);
      }
      if (mutated) return undefined;
      for (const statement of source.tree.statements) if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === origin.name && declaration.initializer !== undefined) return { unit: source, value: declaration.initializer };
      }
      return undefined;
    };
    const result = inspect();
    initializers.set(key, result);
    return result;
  };
  const boundPath = (name: ImportedName | undefined, module: string): string | undefined => name?.binding?.module === module ? (name.binding.imported === "*" ? name.members : [name.binding.imported, ...name.members]).join(".") : undefined;
  const providers = (unit: Unit, expression: ts.Expression, bootstrap: { path: string; line: number; offset: number }, trail: ReadonlySet<string>, context: "config" | "providers"): void => {
    const value = unwrapped(expression);
    if (ts.isIdentifier(value)) {
      const declared = initializer(unit, value.text);
      const key = declared === undefined ? undefined : `${declared.unit.file}\0${declared.value.getStart(declared.unit.tree)}\0${context}`;
      if (declared !== undefined && key !== undefined && !trail.has(key)) providers(declared.unit, declared.value, bootstrap, new Set(trail).add(key), context);
      return;
    }
    if (context === "config" && ts.isObjectLiteralExpression(value)) {
      const list = propertyOf(value, "providers");
      if (list !== undefined) providers(unit, list, bootstrap, trail, "providers");
      return;
    }
    if (context !== "providers") return;
    if (ts.isArrayLiteralExpression(value)) {
      for (const element of value.elements) providers(unit, ts.isSpreadElement(element) ? element.expression : element as ts.Expression, bootstrap, trail, "providers");
      return;
    }
    if (!ts.isCallExpression(value)) return;
    const key = `${unit.file}\0${value.getStart(unit.tree)}`;
    bootstraps.set(key, [...(bootstraps.get(key) ?? []), bootstrap]);
    if (boundPath(nameOf(unit, value.expression), "@angular/core") === "importProvidersFrom") for (const argument of value.arguments) providers(unit, argument, bootstrap, trail, "providers");
  };
  for (const unit of program.index.units.values()) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && boundPath(nameOf(unit, node.expression), "@angular/platform-browser") === "bootstrapApplication" && node.arguments[1] !== undefined) {
        providers(unit, node.arguments[1], { path: unit.file, line: lineOf(unit.tree, node), offset: node.getStart(unit.tree) }, new Set(), "config");
      }
      node.forEachChild(visit);
    };
    visit(unit.tree);
  }
  const walk = async (table: RouteTable, root?: ResolverSyntax["root"]): Promise<void> => {
    const seen = new Map<RouteTable, Set<boolean>>();
    const visit = async (held: RouteTable, aboveConditional: boolean): Promise<void> => {
      const conditional = aboveConditional || held.conditional;
      const states = seen.get(held) ?? new Set<boolean>();
      if (states.has(conditional)) return;
      states.add(conditional);
      seen.set(held, states);
      const entries = async (list: typeof held.entries): Promise<void> => {
        for (const entry of list) {
          const routeUnit = program.index.units.get(entry.file);
          if (routeUnit !== undefined) for (const raw of entry.resolvers ?? []) {
            if (raw.name === undefined) continue;
            const imported = routeUnit.imports.get(raw.name);
            if (imported?.typeOnly === true || (imported !== undefined && routeUnit.declared.has(raw.name))) { unresolvedResolvers.push({ at: { path: entry.file, line: raw.line }, reason: "unresolved" }); continue; }
            let origin = imported === undefined ? { file: entry.file, name: raw.name } : program.index.origin(entry.file, raw.name);
            if (raw.member !== undefined) {
              if (imported?.imported !== "*") { unresolvedResolvers.push({ at: { path: entry.file, line: raw.line }, reason: "unresolved" }); continue; }
              const target = await resolver.resolve(entry.file, imported.module);
              origin = "file" in target ? await declarationOf(target.file, raw.member) : undefined;
            }
            if (origin === undefined || origin === "external") { unresolvedResolvers.push({ at: { path: entry.file, line: raw.line }, reason: "unresolved" }); continue; }
            const targetUnit = program.index.units.get(origin.file);
            const fn = targetUnit?.functions.get(origin.name);
            const cls = targetUnit?.classes.get(origin.name);
            const method = cls?.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === "resolve");
            const declaration = fn?.declaration ?? method;
            if (targetUnit === undefined || declaration === undefined) { unresolvedResolvers.push({ at: { path: entry.file, line: raw.line }, reason: "unresolved" }); continue; }
            const component = entry.component === undefined || entry.component === "unknown" ? undefined : { file: entry.component.path, owner: entry.component.symbol };
            routes.push({ target: { kind: "return", repo, file: origin.file, symbol: fn?.name ?? "resolve", line: lineOf(targetUnit.tree, declaration) }, key: raw.key, at: { path: entry.file, line: raw.line }, offset: raw.offset, ...(component === undefined ? {} : { component }), ...(root === undefined ? {} : { root }), ...(conditional ? { conditional: true as const } : {}) });
          }
          await entries(entry.children);
          if (entry.loaded !== undefined) await visit(entry.loaded, conditional);
        }
      };
      await entries(held.entries);
    };
    await visit(table, false);
  };
  for (const { table, file, config } of graph.rootConfigurations) {
    const unit = program.index.units.get(file);
    if (unit === undefined) continue;
    let call: ts.CallExpression | undefined;
    const find = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.getStart(unit.tree) === config.offset) call = node;
      else node.forEachChild(find);
    };
    find(unit.tree);
    if (call === undefined) continue;
    const configCall: ts.CallExpression = call;
    const configuration = nameOf(unit, configCall.expression);
    if (configuration === undefined) continue;
    const features: (ImportedName | "unreadable")[] = [];
    const featureOf = (owner: Unit, argument: ts.Expression, seen: ReadonlySet<string>): void => {
      const value = ts.isSpreadElement(argument) ? unwrapped(argument.expression) : unwrapped(argument);
      if (ts.isCallExpression(value)) { features.push(nameOf(owner, value.expression) ?? "unreadable"); return; }
      if (ts.isSpreadElement(argument) && ts.isIdentifier(value)) {
        const declared = initializer(owner, value.text);
        const key = declared === undefined ? undefined : `${declared.unit.file}\0${declared.value.getStart(declared.unit.tree)}`;
        const array = declared === undefined ? undefined : unwrapped(declared.value);
        if (key !== undefined && declared !== undefined && array !== undefined && ts.isArrayLiteralExpression(array) && !seen.has(key)) {
          for (const element of array.elements) featureOf(declared.unit, element as ts.Expression, new Set(seen).add(key));
          return;
        }
      }
      features.push("unreadable");
    };
    for (const argument of configCall.arguments.slice(1)) {
      featureOf(unit, argument, new Set());
    }
    const optionsOf = (owner: Unit, expression: ts.Expression, trail: ReadonlySet<string>): NonNullable<ResolverSyntax["root"]>["options"] => {
      const value = unwrapped(expression);
      if (ts.isIdentifier(value)) {
        const declared = initializer(owner, value.text);
        const key = declared === undefined ? undefined : `${declared.unit.file}\0${declared.value.getStart(declared.unit.tree)}`;
        return declared === undefined || key === undefined || trail.has(key) ? "unreadable" : optionsOf(declared.unit, declared.value, new Set(trail).add(key));
      }
      if (!ts.isObjectLiteralExpression(value)) return "unreadable";
      return value.properties.map((property) => {
        if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))) return { value: "unreadable" as const };
        const raw = unwrapped(property.initializer);
        return { name: property.name.text, value: raw.kind === ts.SyntaxKind.TrueKeyword ? true : raw.kind === ts.SyntaxKind.FalseKeyword ? false : "unreadable" as const };
      });
    };
    const options = configCall.arguments[1] === undefined ? undefined : optionsOf(unit, configCall.arguments[1], new Set());
    const roots = [...(bootstraps.get(`${file}\0${config.offset}`) ?? [])];
    if (config.owner !== undefined) for (const held of graph.bootstrapRoots) {
      if (!held.modules.has(`${file}\0${config.owner}`)) continue;
      const bootUnit = program.index.units.get(held.file);
      if (bootUnit === undefined) continue;
      let proved = false;
      const findBoot = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.getStart(bootUnit.tree) === held.bootstrap.offset && ts.isPropertyAccessExpression(node.expression) && ts.isCallExpression(node.expression.expression)) {
          const factory = nameOf(bootUnit, node.expression.expression.expression);
          proved = boundPath(factory, "@angular/platform-browser-dynamic") === "platformBrowserDynamic" || boundPath(factory, "@angular/platform-browser") === "platformBrowser";
        } else node.forEachChild(findBoot);
      };
      findBoot(bootUnit.tree);
      if (proved) roots.push({ path: held.file, line: held.bootstrap.line, offset: held.bootstrap.offset ?? 0 });
    }
    const root = { at: { path: file, line: config.line }, offset: config.offset ?? 0, configuration, features, ...(options === undefined ? {} : { options }) };
    if (roots.length === 0) await walk(table, root);
    else for (const bootstrap of roots) await walk(table, { ...root, bootstrap: { path: bootstrap.path, line: bootstrap.line }, bootstrapOffset: bootstrap.offset });
  }
  for (const table of graph.unreached) await walk(table);
  const expressions = new Map<ExpressionHandle, { unit: Unit; node: ts.Expression }>();
  const manifests = manifestsOf(reading.files);
  const allIssues = [
    ...graph.unparsed.map((path) => ({ at: { path, line: 1 }, reason: "source-unreadable" as const })),
    ...graph.unresolvedReferences.map(({ path, line }) => ({ at: { path, line }, reason: "unresolved" as const })),
    ...graph.resolverIssues.map(({ path, line }) => ({ at: { path, line }, reason: "unresolved" as const })),
    ...unresolvedResolvers,
  ];
  const issues = [...new Map(allIssues.map((issue) => [`${issue.at.path}\0${issue.at.line}\0${issue.reason}`, issue])).values()];
  const uncertainProjects = new Set(issues.map(({ at }) => projectOf(at.path, manifests)?.directory));
  const uncertainFiles = [...program.index.units.keys()].filter((file) => uncertainProjects.has(projectOf(file, manifests)?.directory));
  return { routes, uncertainFiles, sameProject(first, second) {
    return projectOf(first, manifests)?.directory === projectOf(second, manifests)?.directory;
  }, issues(file) {
    const project = projectOf(file, manifests);
    return issues.filter(({ at }) => projectOf(at.path, manifests)?.directory === project?.directory);
  }, routeData(file, owner) {
    const unit = program.index.units.get(file);
    const cls = unit?.classes.get(owner);
    if (unit === undefined || cls === undefined) return undefined;
    const holders = new Map<string, Pick<RouteDataSyntax, "type" | "injection">>();
    const describe = (field: string, type: ts.TypeNode | undefined, initializer: ts.Expression | undefined): void => {
      const typeName = type !== undefined && ts.isTypeReferenceNode(type) ? typeNameOf(unit, type.typeName) : undefined;
      const init = initializer === undefined ? undefined : unwrapped(initializer);
      const callee = init !== undefined && ts.isCallExpression(init) ? nameOf(unit, init.expression) : undefined;
      const token = init !== undefined && ts.isCallExpression(init) && init.arguments[0] !== undefined ? nameOf(unit, init.arguments[0]) : undefined;
      holders.set(field, { ...(typeName === undefined ? {} : { type: typeName }), ...(callee === undefined || token === undefined ? {} : { injection: { callee, token } }) });
    };
    for (const member of cls.members) {
      if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) describe(member.name.text, member.type, member.initializer);
      if (ts.isConstructorDeclaration(member)) for (const parameter of member.parameters) if (ts.isIdentifier(parameter.name)) describe(parameter.name.text, parameter.type, parameter.initializer);
    }
    const found: RouteDataSyntax[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "data") {
        const holder = unwrapped(node.expression);
        const receiver = ts.isPropertyAccessExpression(holder) && holder.name.text === "snapshot" ? unwrapped(holder.expression) : holder;
        if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const reference = holders.get(receiver.name.text);
          if (reference !== undefined) {
            const handle = {} as ExpressionHandle;
            expressions.set(handle, { unit, node });
            found.push({ at: { path: file, line: lineOf(unit.tree, node) }, expression: handle, ...reference });
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(cls);
    return found;
  }, followExpression(expression, path, hops) {
    const held = expressions.get(expression);
    if (held === undefined) return { uses: [], next: [], frontiers: [] };
    const walker = new Walker(repo, program, held.unit);
    walker.startExpression(held.node, path, hops);
    return { uses: walker.uses.map((one) => one.value), next: walker.next.map((one) => one.value), frontiers: walker.frontiers.map((one) => one.value) };
  }, inputs(file, owner) {
    const unit = program.index.units.get(file);
    const cls = unit?.classes.get(owner);
    if (unit === undefined) return undefined;
    if (cls === undefined) return [];
    return cls.members.flatMap((member): InputSyntax[] => {
      if (member.name === undefined || !ts.isIdentifier(member.name)) return [];
      const declarations: InputSyntax["declarations"][number][] = [];
      const add = (expression: ts.Expression, args: readonly ts.Expression[], decorator: boolean, call?: ts.CallExpression) => {
        let callee = expression;
        const required = ts.isPropertyAccessExpression(callee) && callee.name.text === "required";
        if (required && ts.isPropertyAccessExpression(callee)) callee = callee.expression;
        const name = nameOf(unit, callee);
        const option = decorator || required ? args[0] : args[1];
        const aliasOf = (owner: Unit, value: ts.Expression, seen: ReadonlySet<string>): string | { unreadable: true } | undefined => {
          const held = unwrapped(value);
          if (decorator && ts.isStringLiteralLike(held)) return held.text;
          if (ts.isIdentifier(held) && held.text === "undefined" && !owner.imports.has(held.text) && !owner.declared.has(held.text)) return undefined;
          if (ts.isIdentifier(held)) {
            const declared = initializer(owner, held.text, call);
            const key = declared === undefined ? undefined : `${declared.unit.file}\0${declared.value.getStart(declared.unit.tree)}`;
            return declared === undefined || key === undefined || seen.has(key) ? { unreadable: true } : aliasOf(declared.unit, declared.value, new Set(seen).add(key));
          }
          if (!ts.isObjectLiteralExpression(held) || held.properties.some(ts.isSpreadAssignment)) return { unreadable: true };
          const alias = propertyOf(held, "alias");
          if (alias === undefined) return held.properties.some((property) => property.name !== undefined && ts.isComputedPropertyName(property.name)) ? { unreadable: true } : undefined;
          return ts.isStringLiteralLike(alias) ? alias.text : { unreadable: true };
        };
        const alias = option === undefined ? undefined : aliasOf(unit, option, new Set());
        if (name !== undefined) declarations.push({ name, kind: decorator ? "decorator" : "initializer", required, ...(typeof alias === "object" ? { aliasUnreadable: true as const } : alias === undefined ? {} : { alias }) });
      };
      for (const decorator of ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : []) {
        const value = decorator.expression;
        add(ts.isCallExpression(value) ? value.expression : value, ts.isCallExpression(value) ? value.arguments : [], true, ts.isCallExpression(value) ? value : undefined);
      }
      const init = ts.isPropertyDeclaration(member) && member.initializer !== undefined ? unwrapped(member.initializer) : undefined;
      if (init !== undefined && ts.isCallExpression(init)) add(init.expression, init.arguments, false, init);
      return [{ member: memberSite(repo, unit, cls, owner, member.name.text) as InputSyntax["member"], at: { path: file, line: lineOf(unit.tree, member) }, offset: member.getStart(unit.tree), declarations }];
    });
  } };
};
