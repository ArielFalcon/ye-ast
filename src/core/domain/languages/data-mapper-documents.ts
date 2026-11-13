const MAPPER_DOCUMENT = /(^|\/)src\/main\/[^/]+\/(?:.+\/)?[^/]+\.xml$/;
const BUILD_DOCUMENT = /(^|\/)pom\.xml$/;

/**
 * An XML file of a module's main sources or resources, where a MyBatis mapper declares its statements by namespace. The
 * reader decides from the content whether it is one; the path only brings it into the snapshot.
 */
export function isMapperDocument(path: string): boolean {
  return MAPPER_DOCUMENT.test(path) && !BUILD_DOCUMENT.test(path);
}
