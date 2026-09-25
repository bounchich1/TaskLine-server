const MAX_DEPTH = 40;
const LITERAL = /^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

export function strictJson(text: string, losslessIds = false, maxBytes = 32768): unknown {
  if (Buffer.byteLength(text) > maxBytes) {
    throw new Error('json_too_large');
  }
  return new StrictJsonParser(text, losslessIds).document();
}

class StrictJsonParser {
  private at = 0;

  constructor(
    private readonly text: string,
    private readonly losslessIds: boolean,
  ) {}

  document(): unknown {
    const result = this.value(0);
    this.skipWhitespace();
    if (this.at !== this.text.length) {
      throw new Error('trailing_json');
    }
    return result;
  }

  private value(depth: number): unknown {
    if (depth > MAX_DEPTH) {
      throw new Error('json_depth');
    }
    this.skipWhitespace();
    const next = this.text.charAt(this.at);
    if (next === '"') {
      return this.string();
    }
    if (next === '{') {
      return this.object(depth);
    }
    if (next === '[') {
      return this.array(depth);
    }
    return this.literal();
  }

  private object(depth: number): Record<string, unknown> {
    this.at++;
    this.skipWhitespace();
    const result = Object.create(null) as Record<string, unknown>;
    if (this.text.charAt(this.at) === '}') {
      this.at++;
      return result;
    }
    const seen = new Set<string>();
    for (;;) {
      const key = this.memberName(seen);
      result[key] = this.value(depth + 1);
      this.skipWhitespace();
      const end = this.text.charAt(this.at++);
      if (end === '}') {
        return result;
      }
      if (end !== ',') {
        throw new Error('invalid_json_object');
      }
    }
  }

  private memberName(seen: Set<string>): string {
    this.skipWhitespace();
    if (this.text.charAt(this.at) !== '"') {
      throw new Error('invalid_json_key');
    }
    const key = this.string();
    if (seen.has(key)) {
      throw new Error('duplicate_json_key');
    }
    seen.add(key);
    this.skipWhitespace();
    if (this.text.charAt(this.at++) !== ':') {
      throw new Error('invalid_json_colon');
    }
    return key;
  }

  private array(depth: number): unknown[] {
    this.at++;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.text.charAt(this.at) === ']') {
      this.at++;
      return result;
    }
    for (;;) {
      result.push(this.value(depth + 1));
      this.skipWhitespace();
      const end = this.text.charAt(this.at++);
      if (end === ']') {
        return result;
      }
      if (end !== ',') {
        throw new Error('invalid_json_array');
      }
    }
  }

  private string(): string {
    const start = this.at++;
    while (this.at < this.text.length) {
      if (this.text.charAt(this.at) === '\\') {
        this.at += 2;
        continue;
      }
      if (this.text.charAt(this.at++) === '"') {
        return JSON.parse(this.text.slice(start, this.at)) as string;
      }
    }
    throw new Error('invalid_json_string');
  }

  private literal(): unknown {
    const match = LITERAL.exec(this.text.slice(this.at));
    if (!match) {
      throw new Error('invalid_json_value');
    }
    const [token] = match;
    this.at += token.length;
    const parsed: unknown = JSON.parse(token);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) {
      throw new Error('nonfinite_json_number');
    }
    const unsafeInteger =
      typeof parsed === 'number' && /^-?\d+$/.test(token) && !Number.isSafeInteger(parsed);
    return this.losslessIds && unsafeInteger ? token : parsed;
  }

  private skipWhitespace(): void {
    while (this.at < this.text.length && /\s/.test(this.text.charAt(this.at))) {
      this.at++;
    }
  }
}

export function jsonText(value: unknown): string {
  return String(value);
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected_object');
  }
  return value as Record<string, unknown>;
}

export function decimalId(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error('unsafe_id');
  }
  const id = String(value);
  if (!/^-?\d{1,20}$/.test(id)) {
    throw new Error('invalid_id');
  }
  return id;
}
