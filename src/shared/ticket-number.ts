export function formatTicketNumber(value: number | string): string {
  return String(value).padStart(6, '0');
}
