const MIN_WORD = 4;
const MIN_SHARE = 0.3;
const MIN_STEM = 5;
const TITLE_LIMIT = 120;

const STOPWORDS = new Set([
    'здравствуйте',
    'добрый',
    'доброе',
    'день',
    'вечер',
    'утро',
    'пожалуйста',
    'спасибо',
    'подскажите',
    'помогите',
    'почему',
    'когда',
    'сейчас',
    'опять',
    'снова',
    'очень',
    'меня',
    'мной',
    'этот',
    'этого',
    'было',
    'будет',
    'тоже',
    'также',
    'есть',
    'нету',
    'вообще',
    'просто',
    'можно',
    'нужно',
    'сделать',
    'какой',
    'какие',
    'который',
    'которые',
    'только',
    'вашего',
    'ваша',
    'ваши',
    'наша',
    'наши',
    'свой',
    'своей',
]);

const LOCALITY_PATTERNS = [
    /(?:^|[^а-я])((?:ул|улица|пр|проспект|пер|переулок|мкр|микрорайон|бульвар|б-р|шоссе|наб)\.?\s+[а-я0-9-]{3,})/g,
    /(?:^|[^а-я])((?:д|дом)\.?\s*\d{1,4}[а-я]?)/g,
    /(?:^|[^а-я])(с\s+\d{1,2}(?::\d{2})?(?:\s*(?:ч|часов|утра|вечера))?)/g,
    /(?:^|[^а-я])((?:весь|всем|во всем)\s+(?:дом[еу]?|подъезд[еу]?|район[еу]?|улиц[аеы]))/g,
    /(?:^|[^а-я])(у\s+соседей)/g,
];

export function normalizeText(text: string): string {
    return text.toLowerCase().replaceAll('ё', 'е').replaceAll(/\s+/g, ' ').trim();
}

function localityTerms(text: string): Set<string> {
    const found = new Set<string>();

    for (const pattern of LOCALITY_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
            found.add(match[1].replaceAll(/\s+/g, ' ').trim());
        }
    }

    return found;
}

function wordTerms(text: string): Set<string> {
    const words = text.match(/[а-яa-z0-9]+/g) ?? [];

    return new Set(words.filter((word) => word.length >= MIN_WORD && !STOPWORDS.has(word) && !/^\d+$/.test(word)));
}

function countDocuments(texts: string[], extract: (text: string) => Set<string>): Map<string, number> {
    const counts = new Map<string, number>();

    for (const text of texts) {
        for (const term of extract(text)) {
            counts.set(term, (counts.get(term) ?? 0) + 1);
        }
    }

    return counts;
}

function localityRank(term: string): number {
    return LOCALITY_PATTERNS.findIndex((pattern) => new RegExp(pattern.source).test(` ${term}`));
}

function frequent(counts: Map<string, number>, minimum: number, rank: (term: string) => number = () => 0): string[] {
    return [...counts.entries()]
        .filter(([, count]) => count >= minimum)
        .sort((left, right) => right[1] - left[1] || rank(left[0]) - rank(right[0]) || left[0].localeCompare(right[0]))
        .map(([term]) => term);
}

function patternChar(char: string): string {
    if (char === 'е') {
        return '[её]';
    }

    return char === ' ' ? String.raw`\s+` : char.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function originalForm(term: string, descriptions: string[]): string {
    const pattern = new RegExp(term.replace(/[\s\S]/gu, patternChar), 'iu');

    for (const text of descriptions) {
        const found = pattern.exec(text);

        if (found) {
            return found[0].replaceAll(/\s+/g, ' ');
        }
    }

    return term;
}

export function commonTerms(descriptions: string[], limit = 6): { terms: string[]; localities: string[] } {
    const texts = descriptions.map(normalizeText);
    const minimum = Math.max(2, Math.ceil(texts.length * MIN_SHARE));
    const localities = frequent(countDocuments(texts, localityTerms), minimum, localityRank);
    const words = frequent(countDocuments(texts, wordTerms), minimum);

    const stem = (word: string) =>
        words.some((other) => other !== word && other.length >= MIN_STEM && word.startsWith(other));

    const covered = (word: string) => stem(word) || localities.some((term) => term.includes(word));
    const terms = [...localities, ...words.filter((word) => !covered(word))].slice(0, limit);
    const original = (term: string) => originalForm(term, descriptions);

    return { terms: terms.map(original), localities: localities.slice(0, limit).map(original) };
}

export function suggestionTitle(topic: string, localities: string[]): string {
    const place = localities.at(0);

    return (place ? `${topic} — ${place}` : `Массовая проблема: ${topic}`).slice(0, TITLE_LIMIT);
}

export function defaultPublicMessage(topic: string): string {
    return (
        `Мы знаем о массовой проблеме («${topic}») и уже работаем над ней. ` +
        'Отдельно писать не нужно — сообщим, когда всё заработает.'
    );
}

export const DEFAULT_ACK = 'Мы знаем об этой проблеме и уже работаем над ней. Сообщим, когда всё заработает.';

export function pluralTickets(count: number): string {
    const tens = count % 100;
    const units = count % 10;

    if (tens >= 11 && tens <= 14) {
        return `${count} обращений`;
    }

    if (units === 1) {
        return `${count} обращение`;
    }

    return units >= 2 && units <= 4 ? `${count} обращения` : `${count} обращений`;
}
