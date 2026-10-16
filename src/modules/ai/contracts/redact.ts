type Replacer = (match: string, ...groups: string[]) => string;

type Rule = readonly [RegExp, string | Replacer];

const SECRET = '[СЕКРЕТ]';

const STREET_WORDS = [
  'ул\\.', 'улица', 'пр-?т\\.?', 'проспект', 'пер\\.', 'переулок', 'б-р', 'бульвар', 'ш\\.', 'шоссе',
  'наб\\.', 'набережная', 'пл\\.', 'площадь', 'мкр\\.?', 'микрорайон',
];

const STREET = `(?:${STREET_WORDS.join('|')})`;

const SECRETS: readonly Rule[] = [
  [/\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_.-]{20,})\b/g, SECRET],
  [/((?:пароль|password|token|api[_ -]?key|secret)\s*[:=]\s*)\S+/gi, `$1${SECRET}`],
  [/(?<!\p{L})((?:cvv2?|cvc2?|пин-?код|pin)\s*[:=]?\s*)\d{3,6}(?!\d)/giu, `$1${SECRET}`],
  [/(?<!\p{L})(код(?:\s+из)?\s+(?:смс|sms)\s*[:=]?\s*)\d{4,8}(?!\d)/giu, `$1${SECRET}`],
];

const DOCUMENTS: readonly Rule[] = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]'],
  [/(?<!\p{L})(паспорт\p{L}*\D{0,25}?)\d{2}\s?\d{2}\s*(?:№|номер)?\s*\d{6}(?!\d)/giu, '$1[ПАСПОРТ]'],
  [/(?<!\p{L})серия\s*\d{2}\s?\d{2}\s*(?:№|номер)\s*\d{6}(?!\d)/giu, '[ПАСПОРТ]'],
  [/(?<!\p{L})(код\s+подразделения\s*:?\s*)\d{3}-?\d{3}(?!\d)/giu, '$1[ПАСПОРТ]'],
  [/(?<!\d)\d{3}-\d{3}-\d{3}[\s-]\d{2}(?!\d)/g, '[СНИЛС]'],
  [/(?<!\p{L})(снилс\D{0,10}?)\d{11}(?!\d)/giu, '$1[СНИЛС]'],
  [/(?<!\p{L})(инн\D{0,10}?)(?:\d{12}|\d{10})(?!\d)/giu, '$1[ИНН]'],
  [/(?<!\p{L})(полис\p{L}*\D{0,20}?)\d{16}(?!\d)/giu, '$1[ПОЛИС]'],
  [
    /(?<!\p{L})((?:дата\s+рождения|д\.\s?р\.|родил(?:ся|ась))\D{0,10}?)\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/giu,
    '$1[ДАТА РОЖДЕНИЯ]',
  ],
];

const NUMBERS: readonly Rule[] = [
  [/(?<!\d)\d{20}(?!\d)/g, '[СЧЁТ]'],
  [/(?<!\p{L})(карт\p{L}*\D{0,15}?)(?:\d[ -]?){12,18}\d(?!\d)/giu, '$1[КАРТА]'],
  [/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, (match) => (passesLuhn(match.replace(/\D/g, '')) ? '[КАРТА]' : match)],
  [/(?<!\d)(?:\+7|8|7)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g, '[ТЕЛЕФОН]'],
  [/(?<![\d+])\+(?!7)\d{1,3}[\s(-]*\d[\d\s()-]{6,14}\d(?!\d)/g, '[ТЕЛЕФОН]'],
  [/(?<!\d)9\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g, '[ТЕЛЕФОН]'],
];

const ADDRESSES: readonly Rule[] = [
  [new RegExp(`(?<!\\p{L})(${STREET}\\s+[\\p{L}\\d .-]{2,40}?,?\\s+)\\d+\\p{L}?(?:\\s*[-/]\\s*\\d+)?(?!\\d)`, 'giu'), '$1[ДОМ]'],
  [/(?<!\p{L})((?:д\.|дом)\s*)\d+\s*\p{L}?(?:\s*\/\s*\d+)?(?!\d)/giu, '$1[ДОМ]'],
  [/(?<!\p{L})((?:корп(?:ус)?\.?|стр(?:оение)?\.?)\s*)\d+(?!\d)/giu, '$1[ДОМ]'],
  [/(?<!\p{L})((?:кв(?:артира)?\.?|оф(?:ис)?\.?)\s*)\d+\p{L}?(?!\d)/giu, '$1[КВ]'],
];

const RULES: readonly Rule[] = [...SECRETS, ...DOCUMENTS, ...NUMBERS, ...ADDRESSES];

export function redact(text: string): string {
  return RULES.reduce(
    (current, [pattern, replacement]) =>
      typeof replacement === 'string' ? current.replace(pattern, replacement) : current.replace(pattern, replacement),
    text,
  );
}

function passesLuhn(digits: string): boolean {
  let sum = 0;

  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);

    if (index % 2 === 1) {
      digit *= 2;
      digit -= digit > 9 ? 9 : 0;
    }

    sum += digit;
  }

  return sum % 10 === 0;
}
