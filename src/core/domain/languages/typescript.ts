const SOURCE = /\.[cm]?ts$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const TEST_FILE = /\.(test|spec|e2e-spec|cy)\.[cm]?ts$/;
const TEST_DIRECTORY = /(^|\/)__tests__\//;
const INSTALLED_PACKAGES = /(^|\/)node_modules\//;
const TEMPLATE = /\.html?$/;
const MODULE_CONFIG = /(^|\/)[tj]sconfig(\.[^/]+)?\.json$/;
const ANGULAR_WORKSPACE = /(^|\/)angular\.json$/;

/** A TypeScript test: a `.test`, `.spec`, `.e2e-spec` or Cypress `.cy` module, or one under `__tests__`. */
export function isTypeScriptTestFile(path: string): boolean {
  return TEST_FILE.test(path) || TEST_DIRECTORY.test(path);
}

/** A TypeScript module an extractor parses: not a declaration file, a test, or an installed package. */
export function isTypeScriptSource(path: string): boolean {
  return isTypeScriptFile(path) && !isTypeScriptTestFile(path);
}

export function isTypeScriptFile(path: string): boolean {
  return SOURCE.test(path) && !DECLARATION.test(path) && !INSTALLED_PACKAGES.test(path);
}

const MANIFEST = /(^|\/)package\.json$/;

/** A `package.json` at any depth outside `node_modules`: its dependencies name the framework of the project it sits in. */
export function isPackageManifest(path: string): boolean {
  return MANIFEST.test(path) && !INSTALLED_PACKAGES.test(path);
}

/** A `tsconfig` or `jsconfig` file, `extends` targets included, that tells how a module specifier resolves. */
export function isModuleConfigFile(path: string): boolean {
  return MODULE_CONFIG.test(path) && !INSTALLED_PACKAGES.test(path);
}

/** An Angular workspace file, whose `fileReplacements` swap one source for another at build time. */
export function isAngularWorkspace(path: string): boolean {
  return ANGULAR_WORKSPACE.test(path) && !INSTALLED_PACKAGES.test(path);
}

/** A template file a `templateUrl` can name, which the relation reader parses for the components a template uses. */
export function isAngularTemplate(path: string): boolean {
  return TEMPLATE.test(path) && !INSTALLED_PACKAGES.test(path);
}

/** An explicit JSON resource eligible for module resolution, excluding configuration and installed packages. */
export function isJsonModuleResource(path: string): boolean {
  return path.endsWith(".json") && !INSTALLED_PACKAGES.test(path) && !isPackageManifest(path) && !isModuleConfigFile(path);
}
