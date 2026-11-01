const SOURCE = /\.[cm]?ts$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const TEST_FILE = /\.(test|spec)\.[cm]?ts$/;
const TEST_DIRECTORY = /(^|\/)__tests__\//;
const INSTALLED_PACKAGES = /(^|\/)node_modules\//;
const TEMPLATE = /\.html?$/;
const MODULE_CONFIG = /(^|\/)[tj]sconfig(\.[^/]+)?\.json$/;

/** A TypeScript test: a `.test` or `.spec` module, or one under `__tests__`. */
export function isTypeScriptTestFile(path: string): boolean {
  return TEST_FILE.test(path) || TEST_DIRECTORY.test(path);
}

/** A TypeScript module an extractor parses: not a declaration file, a test, or an installed package. */
export function isTypeScriptSource(path: string): boolean {
  return SOURCE.test(path) && !DECLARATION.test(path) && !isTypeScriptTestFile(path) && !INSTALLED_PACKAGES.test(path);
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

/** A template file a `templateUrl` can name, which the relation reader parses for the components a template uses. */
export function isAngularTemplate(path: string): boolean {
  return TEMPLATE.test(path) && !INSTALLED_PACKAGES.test(path);
}
