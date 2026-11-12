import ts from "typescript";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { angularCoreExport } from "./angular-injection.ts";
import { manifestsOf, projectOf } from "./angular-projects.ts";
import { buildEntrypoints } from "./angular-build-context.ts";
import { replacedFiles } from "./angular-replacements.ts";
import type { ModuleResolver } from "./module-resolver.ts";
import { ownBindings, propertyOf, unwrapped } from "./syntax.ts";
import { RequestValueReading, type ValueUnit, type LocatedValue } from "./request-value-reading.ts";
import type { FrameworkValueFactory } from "../../ports/framework-values.port.ts";

const INJECTOR_APIS = ["Injector", "createEnvironmentInjector", "createNgModule", "NgModule", "runInInjectionContext"];

export const angularProviderContribution: FrameworkValueFactory = {
  async prepare(reading) {
    if (!(reading instanceof RequestValueReading)) return undefined;
    const lookup = angularProviderValues(reading.files, reading.units, reading.modules, reading.constant);
    return { async valueOf(at) {
      const expression = reading.expression(at), unit = reading.units.get(at.file);
      if (expression === undefined || unit === undefined) return undefined;
      let token: ts.Expression | undefined;
      if (ts.isCallExpression(expression) && expression.arguments.length === 1 && angularCoreExport(expression.expression, unit) === "inject") token = expression.arguments[0];
      else if (ts.isIdentifier(expression) && ts.isParameter(expression.parent) && expression.parent.name === expression) {
        const parameter = expression.parent;
        const decorators = ts.canHaveDecorators(parameter) ? ts.getDecorators(parameter) ?? [] : [];
        const decorator = decorators.length === 1 ? decorators[0]!.expression : undefined;
        if (decorator !== undefined && ts.isCallExpression(decorator) && decorator.arguments.length === 1 && angularCoreExport(decorator.expression, unit) === "Inject") token = decorator.arguments[0];
      }
      const held = token === undefined ? undefined : await lookup(unit, token);
      return held === undefined ? undefined : reading.at(held.expression);
    } };
  },
};

function staticObject(node: ts.ObjectLiteralExpression): boolean {
  const names = node.properties.map((property) => (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ? property.name.text : undefined);
  return names.every((name) => name !== undefined) && new Set(names).size === names.length;
}

/** Source-complete applications with one static root injector; unsupported scopes authorize no value proof. */
function angularProviderValues(files: readonly SourceFile[], units: ReadonlyMap<string, ValueUnit>, modules: ModuleResolver, constant: (unit: ValueUnit, name: string) => Promise<LocatedValue | undefined>) {
  const manifests = manifestsOf(files);
  const replacements = replacedFiles(files);
  const roots = new Map<string, Promise<ReadonlyMap<ts.Expression, LocatedValue>>>();
  const empty = new Map<ts.Expression, LocatedValue>();
  const external = async (unit: ValueUnit, module: string): Promise<boolean> => "external" in await modules.resolve(unit.source.fileName, module);
  const imported = (unit: ValueUnit, expression: ts.Expression, module: string): string | undefined => {
    const node = unwrapped(expression);
    if (ts.isIdentifier(node)) {
      const binding = unit.declared.has(node.text) ? undefined : unit.imports.get(node.text);
      return binding?.module === module && !binding.typeOnly && binding.imported !== "*" ? binding.imported : undefined;
    }
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return undefined;
    const binding = unit.declared.has(node.expression.text) ? undefined : unit.imports.get(node.expression.text);
    return binding?.module === module && !binding.typeOnly && binding.imported === "*" ? node.name.text : undefined;
  };
  const resolve = async (unit: ValueUnit, expression: ts.Expression, trail = new Set<ts.Node>()): Promise<LocatedValue | undefined> => {
    if (replacements === undefined || replacements.has(unit.source.fileName)) return undefined;
    const node = unwrapped(expression);
    if (!ts.isIdentifier(node)) return { unit, expression: node };
    const held = await constant(unit, node.text);
    if (held === undefined || trail.has(held.expression)) return undefined;
    const declaration = held.expression.parent;
    if (!ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
    return resolve(held.unit, held.expression, new Set(trail).add(held.expression));
  };
  const tokenOf = async (unit: ValueUnit, expression: ts.Expression): Promise<ts.Expression | undefined> => {
    const held = await resolve(unit, expression);
    return held !== undefined && ts.isNewExpression(held.expression) && angularCoreExport(held.expression.expression, held.unit) === "InjectionToken" && await external(held.unit, "@angular/core") ? held.expression : undefined;
  };

  const readRoot = async (directory: string): Promise<ReadonlyMap<ts.Expression, LocatedValue>> => {
    if (replacements === undefined) return empty;
    const scoped = [...units.values()].filter((unit) => projectOf(unit.source.fileName, manifests)?.directory === directory);
    const scopedFiles = files.filter((file) => projectOf(file.path, manifests)?.directory === directory);
    const entrypoints = buildEntrypoints(scopedFiles);
    if (entrypoints === undefined || entrypoints.size !== 1) return empty;
    const bootstraps: { unit: ValueUnit; call: ts.CallExpression }[] = [];
    const objects: ts.ObjectLiteralExpression[] = [];
    const nodes: { unit: ValueUnit; node: ts.Node }[] = [];
    for (const unit of scoped) {
      const visit = (node: ts.Node): void => {
        nodes.push({ unit, node });
        if (ts.isObjectLiteralExpression(node)) objects.push(node);
        if (ts.isCallExpression(node) && imported(unit, node.expression, "@angular/platform-browser") === "bootstrapApplication") bootstraps.push({ unit, call: node });
        ts.forEachChild(node, visit);
      };
      visit(unit.source);
    }
    if (bootstraps.length !== 1) return empty;
    const root = bootstraps[0]!;
    if (!entrypoints.has(root.unit.source.fileName) || replacements.has(root.unit.source.fileName) || !(await external(root.unit, "@angular/platform-browser"))) return empty;
    for (let parent = root.call.parent; parent !== undefined && !ts.isSourceFile(parent); parent = parent.parent) {
      if (ts.isFunctionLike(parent) || ts.isClassLike(parent) || ts.isIfStatement(parent) || ts.isConditionalExpression(parent)) return empty;
    }
    const configArg = root.call.arguments[1];
    if (root.call.arguments.length !== 2 || configArg === undefined) return empty;
    const config = await resolve(root.unit, configArg);
    if (config === undefined || !ts.isObjectLiteralExpression(config.expression) || !staticObject(config.expression)) return empty;
    const providersArg = propertyOf(config.expression, "providers");
    const providers = providersArg === undefined ? undefined : await resolve(config.unit, providersArg);
    if (providers === undefined || !ts.isArrayLiteralExpression(providers.expression)) return empty;
    const allowed = new Set<ts.Node>([config.expression, providers.expression]);
    const protectedNodes = new Set<ts.Node>(allowed);
    const values = new Map<ts.Expression, LocatedValue>();
    for (const entry of providers.expression.elements) {
      if (ts.isSpreadElement(entry) || !ts.isExpression(entry)) return empty;
      const held = await resolve(providers.unit, entry);
      if (held === undefined || !ts.isObjectLiteralExpression(held.expression) || !staticObject(held.expression) || held.expression.properties.length !== 2 || held.expression.properties.some((property) => !ts.isPropertyAssignment(property))) return empty;
      const token = propertyOf(held.expression, "provide"), value = propertyOf(held.expression, "useValue");
      const identity = token === undefined ? undefined : await tokenOf(held.unit, token);
      if (identity === undefined || value === undefined || values.has(identity)) return empty;
      allowed.add(held.expression);
      allowed.add(identity);
      protectedNodes.add(held.expression);
      protectedNodes.add(identity);
      let valueRoot = unwrapped(value);
      while (ts.isPropertyAccessExpression(valueRoot) || ts.isElementAccessExpression(valueRoot)) valueRoot = unwrapped(valueRoot.expression);
      const supplied = await resolve(held.unit, valueRoot);
      if (supplied === undefined || !(ts.isStringLiteralLike(supplied.expression) || ts.isObjectLiteralExpression(supplied.expression) && staticObject(supplied.expression))) return empty;
      if (projectOf(supplied.unit.source.fileName, manifests)?.directory !== directory) return empty;
      protectedNodes.add(supplied.expression);
      values.set(identity, { unit: held.unit, expression: value });
    }
    if (objects.some((object) => !allowed.has(object) && (propertyOf(object, "providers") !== undefined || propertyOf(object, "viewProviders") !== undefined || propertyOf(object, "provide") !== undefined))) return empty;
    const protectedValue = async (unit: ValueUnit, node: ts.Expression): Promise<boolean> => {
      const seen = new Set<ts.Node>();
      const reaches = async (source: ValueUnit, value: ts.Node): Promise<boolean> => {
        if (protectedNodes.has(value)) return true;
        if (seen.has(value)) return false;
        seen.add(value);
        if (ts.isIdentifier(value)) {
          const parent = value.parent;
          if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === value) return false;
          for (let scope: ts.Node | undefined = parent; scope !== undefined; scope = scope.parent) {
            const binding = ownBindings(scope).get(value.text);
            if (binding === undefined) continue;
            return binding.initializer === undefined ? false : reaches(source, binding.initializer);
          }
          const held = await constant(source, value.text);
          return held !== undefined && reaches(held.unit, held.expression);
        }
        const children: ts.Node[] = [];
        ts.forEachChild(value, (child) => { children.push(child); });
        for (const child of children) if (await reaches(source, child)) return true;
        return false;
      };
      return reaches(unit, node);
    };
    for (const { unit, node } of nodes) {
      if (ts.isIdentifier(node)) {
        const bound = unit.imports.get(node.text);
        if (bound?.module === "@angular/core" && INJECTOR_APIS.includes(bound.imported)) return empty;
      }
      if (ts.isPropertyAccessExpression(node) && INJECTOR_APIS.includes(angularCoreExport(node, unit) ?? "")) return empty;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && (await protectedValue(unit, node.left) || await protectedValue(unit, node.right))) return empty;
      if ((ts.isDeleteExpression(node) || ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && await protectedValue(unit, ts.isDeleteExpression(node) ? node.expression : node.operand)) return empty;
      if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name) && node.initializer !== undefined && await protectedValue(unit, node.initializer)) return empty;
      if (ts.isReturnStatement(node) && node.expression !== undefined && await protectedValue(unit, node.expression)) return empty;
      if (ts.isPropertyAssignment(node) && !allowed.has(node.parent) && await protectedValue(unit, node.initializer)) return empty;
      if (ts.isShorthandPropertyAssignment(node) && !allowed.has(node.parent) && await protectedValue(unit, node.name)) return empty;
      if (ts.isNewExpression(node) && node.arguments !== undefined && (await Promise.all(node.arguments.map((argument) => protectedValue(unit, argument)))).some(Boolean)) return empty;
      if (!ts.isCallExpression(node)) continue;
      const frameworkCall = angularCoreExport(node.expression, unit);
      if (["Component", "Directive", "Injectable", "Pipe"].includes(frameworkCall ?? "")) {
        const metadata = node.arguments[0];
        if (metadata === undefined || !ts.isObjectLiteralExpression(metadata) || !staticObject(metadata)) return empty;
      }
      if (ts.isPropertyAccessExpression(node.expression) && await protectedValue(unit, node.expression.expression)) return empty;
      for (const argument of node.arguments) {
        if (!(await protectedValue(unit, argument))) continue;
        const core = angularCoreExport(node.expression, unit);
        if (node !== root.call && !((core === "inject" || core === "Inject") && node.arguments[0] === argument)) return empty;
      }
    }
    return values;
  };

  return async (unit: ValueUnit, token: ts.Expression): Promise<LocatedValue | undefined> => {
    const project = projectOf(unit.source.fileName, manifests);
    if (!project?.dependencies.has("@angular/core") || !(await external(unit, "@angular/core"))) return undefined;
    let reading = roots.get(project.directory);
    if (reading === undefined) { reading = readRoot(project.directory); roots.set(project.directory, reading); }
    const identity = await tokenOf(unit, token);
    return identity === undefined ? undefined : (await reading).get(identity);
  };
}
