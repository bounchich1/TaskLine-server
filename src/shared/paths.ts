/**
 * Root of the server package. Resolved from this file's own location, which is `src/shared/` when
 * running from source and `dist/shared/` when built, so it must stay exactly two levels deep.
 * Read files that live outside `src/` (migrations, contracts, agent skills) through this.
 */
const SERVER_ROOT = new URL('../../', import.meta.url);

export function serverFile(relativePath: string): URL {
  return new URL(relativePath, SERVER_ROOT);
}
