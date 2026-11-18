// Portable path rules shared by Shiplet packages and the static upload policy,
// so an upload is refused before storage when its package would be.

const MAX_PORTABLE_PATH_BYTES = 1_024;
const MAX_PORTABLE_PATH_SEGMENT_BYTES = 255;

export function isPortablePath(path: string) {
  if (
    path.length === 0 ||
    new TextEncoder().encode(path).byteLength > MAX_PORTABLE_PATH_BYTES ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return false;
  }
  for (const segment of segments) {
    if (
      new TextEncoder().encode(segment).byteLength >
        MAX_PORTABLE_PATH_SEGMENT_BYTES ||
      /[<>:"|?*]/u.test(segment) ||
      /[. ]$/u.test(segment)
    ) {
      return false;
    }
    const basename = segment.split(".", 1)[0].toLocaleUpperCase("en-US");
    if (
      basename === "CON" ||
      basename === "PRN" ||
      basename === "AUX" ||
      basename === "NUL" ||
      /^COM[1-9]$/u.test(basename) ||
      /^LPT[1-9]$/u.test(basename)
    ) {
      return false;
    }
  }
  return true;
}

/** Paths with the same key name one file once letter case and Unicode form are ignored. */
export function portableCollisionKey(path: string) {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}
