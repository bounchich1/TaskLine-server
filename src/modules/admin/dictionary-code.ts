const LATIN: Readonly<Record<string, string>> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
};

const MAX_LENGTH = 40;

export function codeFromLabel(label: string): string {
    const latin = label.toLowerCase().replace(/[а-яё]/g, (letter) => LATIN[letter] ?? '');

    const slug = latin
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+/, '')
        .slice(0, MAX_LENGTH)
        .replace(/_+$/, '');

    if (!slug) {
        return 'topic';
    }

    return /^[a-z]/.test(slug) ? slug : `topic_${slug}`;
}
