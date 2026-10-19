const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export function editRatio(original: string, final: string): number {
    const source = words(original);
    const target = words(final);
    const longest = Math.max(source.length, target.length);

    if (longest === 0) {
        return 0;
    }

    let previous = Array.from({ length: target.length + 1 }, (_, index) => index);

    for (let i = 1; i <= source.length; i++) {
        const current = [i];

        for (let j = 1; j <= target.length; j++) {
            const substitution = (previous[j - 1] ?? 0) + (source[i - 1] === target[j - 1] ? 0 : 1);

            current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
        }

        previous = current;
    }

    return Math.min(1, (previous[target.length] ?? 0) / longest);
}
