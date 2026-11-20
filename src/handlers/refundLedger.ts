import type { RefundRequested } from '../bus/events';
import type { Message, Subscriber } from '../bus/inMemoryBus';
import type { PaymentGateway } from '../integrations/paymentGateway';

/** One line in the refund ledger. */
export interface LedgerEntry {
  entryId: string;
  bookingId: string;
  organizer: string;
  amountCents: number;
  reason: string;
  recordedAtMinute: number;
}

/**
 * Books refunds and sends the money back.
 *
 * For a refund message the handler writes a ledger entry, then calls the
 * payment provider for the same amount. The ledger is append only: entries are
 * numbered in the order they were written, and nothing edits or removes one
 * after the fact.
 */
export class RefundLedger implements Subscriber<RefundRequested> {
  readonly name = 'RefundLedger';

  private readonly entries: LedgerEntry[] = [];
  /** Booking ids the payment provider has confirmed a refund for. */
  private readonly paid = new Set<string>();
  private readonly gateway: PaymentGateway;

  constructor(gateway: PaymentGateway) {
    this.gateway = gateway;
  }

  handle(message: Message<RefundRequested>): void {
    const event = message.payload;
    // Idempotency key: the booking id. A booking can be cancelled only once,
    // so it is owed at most one refund. Each step is checked on its own, so a
    // delivery that wrote the entry but failed to pay is finished, not skipped.
    if (this.forBooking(event.bookingId).length === 0) {
      this.entries.push({
        entryId: `led-${this.entries.length + 1}`,
        bookingId: event.bookingId,
        organizer: event.organizer,
        amountCents: event.amountCents,
        reason: event.reason,
        recordedAtMinute: message.publishedAtMinute,
      });
    }
    if (!this.paid.has(event.bookingId)) {
      this.gateway.refund(event.bookingId, event.amountCents);
      this.paid.add(event.bookingId);
    }
  }

  /** Every ledger entry, oldest first. */
  all(): LedgerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Entries for one booking, oldest first. */
  forBooking(bookingId: string): LedgerEntry[] {
    return this.all().filter((entry) => entry.bookingId === bookingId);
  }

  /** What the ledger says has been refunded, in cents. */
  totalRefundedCents(): number {
    return this.entries.reduce((sum, entry) => sum + entry.amountCents, 0);
  }

  size(): number {
    return this.entries.length;
  }
}
