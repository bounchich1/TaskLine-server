const SERVER_ROOT = new URL('../../', import.meta.url);

export function serverFile(relativePath: string): URL {
    return new URL(relativePath, SERVER_ROOT);
}
