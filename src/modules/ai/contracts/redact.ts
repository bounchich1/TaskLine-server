/**
 * Masks secrets and personal contacts before text reaches the model or long-term memory:
 * API keys and JWTs, e-mail addresses, Russian phone numbers, and `password: …`-style values.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_.-]{20,})\b/g, '[СЕКРЕТ]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g, '[ТЕЛЕФОН]')
    .replace(/((?:пароль|password|token|api[_ -]?key|secret)\s*[:=]\s*)\S+/gi, '$1[СЕКРЕТ]');
}
