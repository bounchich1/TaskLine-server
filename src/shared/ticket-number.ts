/** Ticket numbers are shown to clients and staff zero-padded to six digits (№000042). */
export function formatTicketNumber(value: number | string): string {
  return String(value).padStart(6, '0');
}
