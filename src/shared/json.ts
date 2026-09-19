/** Bounded JSON parser: rejects duplicate keys and preserves unsafe integer tokens. */
export function strictJson(text: string, losslessIds = false, maxBytes = 32768): unknown {
  if (Buffer.byteLength(text) > maxBytes) {
    throw new Error('json_too_large');
  }
  let at = 0;
  const ws = () => {
    while (/\s/.test(text[at] ?? '') && at < text.length) {
      at++;
    }
  };
  const str = (): string => {
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') {
        at += 2;
        continue;
      }
      if (text[at++] === '"') {
        return JSON.parse(text.slice(start, at)) as string;
      }
    }
    throw new Error('invalid_json_string');
  };
  const value = (depth: number): unknown => {
    if (depth > 40) {
      throw new Error('json_depth');
    }
    ws();
    const ch = text[at];
    if (ch === '"') {
      return str();
    }
    if (ch === '{') {
      at++;
      ws();
      const result: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      if (text[at] === '}') {
        at++;
        return result;
      }
      for (;;) {
        ws();
        if (text[at] !== '"') {
          throw new Error('invalid_json_key');
        }
        const key = str();
        if (keys.has(key)) {
          throw new Error('duplicate_json_key');
        }
        keys.add(key);
        ws();
        if (text[at++] !== ':') {
          throw new Error('invalid_json_colon');
        }
        result[key] = value(depth + 1);
        ws();
        const end = text[at++];
        if (end === '}') {
          return result;
        }
        if (end !== ',') {
          throw new Error('invalid_json_object');
        }
      }
    }
    if (ch === '[') {
      at++;
      ws();
      const result: unknown[] = [];
      if (text[at] === ']') {
        at++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        ws();
        const end = text[at++];
        if (end === ']') {
          return result;
        }
        if (end !== ',') {
          throw new Error('invalid_json_array');
        }
      }
    }
    const literal = /^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(at),
    );
    if (!literal) {
      throw new Error('invalid_json_value');
    }
    at += literal[0].length;
    const parsed: unknown = JSON.parse(literal[0]);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) {
      throw new Error('nonfinite_json_number');
    }
    if (
      losslessIds &&
      typeof parsed === 'number' &&
      /^-?\d+$/.test(literal[0]) &&
      !Number.isSafeInteger(parsed)
    ) {
      return literal[0];
    }
    return parsed;
  };
  const result = value(0);
  ws();
  if (at !== text.length) {
    throw new Error('trailing_json');
  }
  return result;
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
