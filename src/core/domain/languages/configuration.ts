import { isMapperDocument } from "./data-mapper-documents.ts";
import { isJvmBuildFile } from "./jvm-build.ts";
import { isContractDocument } from "./openapi.ts";
import { isSpringConfigFile } from "./spring-config.ts";
import { isAngularWorkspace, nxConfigurationOf, isModuleConfigFile, isPackageManifest, isTypeScriptSource } from "./typescript.ts";

/**
 * A file that interprets other files instead of declaring an entrypoint: the manifest that names a project's framework,
 * the compiler configuration that resolves a module specifier, the Angular or Nx build configuration that swaps a source,
 * the JVM build file that declares a source generator, the Spring configuration that declares the base path, the MyBatis
 * mapper document that declares a statement, and the contract document the code implements. An extractor needs them to place what it reads, so a caller's `include` never
 * narrows them away.
 */
export function isExtractorConfiguration(path: string): boolean {
  return isPackageManifest(path) || isModuleConfigFile(path) || isAngularWorkspace(path) || nxConfigurationOf(path) !== undefined || isJvmBuildFile(path) || isSpringConfigFile(path) || isMapperDocument(path) || isContractDocument(path);
}

export function isEntrypointReadingInput(path: string): boolean {
  return isExtractorConfiguration(path) || isTypeScriptSource(path);
}
