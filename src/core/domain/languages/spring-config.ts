const CONFIG_FILE = /(^|\/)src\/main\/resources\/(config\/)?application(-(?<profile>[^/]+))?\.(properties|xml|ya?ml)$/;
const MAIN_SOURCE_SET = /^(.*\/)?src\/main\/java\//;

/** A Spring Boot `application` file a module's main resources hold, at the root or under `config/`, with or without a profile. */
export function isSpringConfigFile(path: string): boolean {
  return CONFIG_FILE.test(path);
}

/** The profile an `application-<profile>` file name declares, or undefined for `application`. */
export function profileOfConfigFile(path: string): string | undefined {
  return CONFIG_FILE.exec(path)?.groups?.profile;
}

/** The main resources directory of the module whose main source set holds the source, or undefined outside one. */
export function resourcesOfSource(path: string): string | undefined {
  const match = MAIN_SOURCE_SET.exec(path);
  return match === null ? undefined : `${match[1] ?? ""}src/main/resources/`;
}
