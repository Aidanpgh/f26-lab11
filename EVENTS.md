# EVENTS.md

One section per milestone. Fill each one in order as you go.

The prediction in milestone 2 should be written before you run the replay. That is the
part a TA will ask about.

Keep it short and specific. Point at operations, call sites, and what a caller
gets back.

---

## Milestone 1: what runs in the request path, and what runs after it

### The operations table

One row per operation. Read the code, not the file
names. "As wired today" is what the code does now. "Your call" is what you
would do if this were your service. List up to eight operations, and remove
the rows you don't use.

| # | Operation | As wired today | Your call | Why (in one line) |
|---|---|---|---|---|
| 1 | Validate request, check for clashes, price, and save the booking | Synchronous in `BookingService.book()` | Synchronous | The caller needs a yes/no and a booking id before the request returns. |
| 2 | Index the booking in search (room-finder page) | Synchronous in `book()` (`bookingService.ts:94`), *before* the save | Event-driven: a new subscriber on `booking.confirmed` | A page that only displays bookings should not be able to stop bookings from being made. |
| 3 | Audit record (`booking.created`, `booking.cancelled`, `refund.requested`) | Synchronous in `book()` / `cancel()` | Synchronous | Cheap local write, and every booking that really happened must have an audit record. |
| 4 | Confirmation / cancellation email | Event-driven (`EmailConfirmationHandler`) | Event-driven | The organizer can wait a few seconds for mail; a mail problem should not fail a booking. |
| 5 | Receipt rendering | Event-driven (`ReceiptGenerator`) | Event-driven | Not needed to finish the booking, and it overwrites by booking id so a repeat is harmless. |
| 6 | Reminder scheduling (and dropping it on cancel) | Event-driven (`ReminderScheduler`) | Event-driven | The reminder is due 30 minutes before the meeting, so it has plenty of slack. |
| 7 | Dashboard stats | Event-driven (`StatsUpdater`) | Event-driven | It recounts the store every time, so lag or a repeat just recomputes the same numbers. |
| 8 | Refund: ledger entry + payment provider refund | Event-driven (`RefundLedger` on `refund.requested`); the amount is computed synchronously in `cancel()` | Event-driven | A payment provider outage should not stop people from cancelling. |

### Two calls in detail

**Row 2: indexing the booking in search → move it onto the bus.** The caller of
`book()` (the reservations page or the front-desk kiosk) needs to know *right
now* whether the room is theirs and what the booking id is. It does not need the
booking to show up on the room-finder page in the same instant; a few seconds,
or even the length of a search outage, is acceptable. Today the index call sits
in the request path before `store.save`, so when the search cluster is down the
caller gets a `SearchIndexUnavailableError` and no booking at all. With the call
moved to a subscriber on `booking.confirmed`, the booking is saved and returned
normally during an outage; only the search subscriber fails, the bus records a
dead letter for it, and the message is redelivered once search is back. The cost
is that a new booking is missing from the room-finder page until that redelivery
happens, so someone (or something) has to watch the dead-letter list.

**Row 8: refund → keep it on the bus.** The caller of `cancel()` needs the
booking released and needs to know how much they will get back. Both of those
are decided synchronously in `cancel()`, so the caller gets them even if the
payment provider is down. Actually moving the money can happen shortly after.
Making the refund synchronous would mean a payment provider outage stops all
cancellations, which is the same mistake the ticket describes for search. The
cost of the bus is that delivery is at least once: the refund message can be
delivered more than once, so the refund handler has to be safe to repeat
(milestone 2), and a failed delivery has to be noticed and recovered
(milestone 3).

### The incident

**The call behind `TICKET.md`.** `src/service/bookingService.ts`, method
`BookingService.book()`, line 94:
`this.searchIndex.indexBooking(booking, room, now);`. When the search cluster is
down, this throws `SearchIndexUnavailableError`. Nothing in `book()` catches it,
so the caller gets that error instead of a `Booking`. Because the call comes
before `this.store.save(booking)` on line 95, the booking is never saved, no
audit record is written, and no `booking.confirmed` event is published (so no
email, receipt, or reminder). `cancel()` never calls the search index (stale rows
are removed later by the nightly `CleanupSweep`, which already tolerates an
outage), which is why cancellations kept working during the incident.

---

## Milestone 2: what a second delivery does

### Your prediction (before you run anything)

**What you expect `redeliver` on a refund message to do.** `RefundLedger.handle()`
only appends: every delivery pushes a new ledger entry and calls
`gateway.refund()`, and nothing checks whether this message or booking was
already refunded. `redeliver` hands the same message (same id) to the same
subscribers again. So after the cancellation plus two redeliveries I expect:

- **Ledger:** 3 entries for the same booking (`led-1`, `led-2`, `led-3`), and
  `totalRefundedCents` = 3 × the refund amount.
- **Payment provider:** 3 settlements (`stl-1` to `stl-3`) for the same booking,
  so the organizer is actually paid 3 × what they are owed.
- **Bus log:** still only one `refund.requested` message with the same id (no new
  message is published), its delivery count goes 1 → 2 → 3, and no dead letters
  because nothing throws.

### Before your fix

**The run.** Paste what `npm run demo:replay` printed without editing it. A TA
may ask you about it in milestone 3.

```

> campus-reservations@1.0.0 demo:replay
> tsx src/demos/replayDemo.ts

booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 2
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 2
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
money returned in total: $170.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 3
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-3 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 3
gateway settlements: 3
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
  stl-3 bk-1001 $85.00
money returned in total: $255.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**Your prediction against the run.** They agree on every point. Each delivery
of `msg-3` added a ledger entry (`led-1` to `led-3`) and a settlement (`stl-1` to
`stl-3`), so an $85.00 refund paid out $255.00. The bus log still has one
`refund.requested` message, with `deliveries=3`, and there are 0 dead letters,
because nothing threw. Paying the organizer twice extra raised no error at all.

### Your fix

**The diff.** Paste it.

```diff
diff --git a/src/handlers/refundLedger.ts b/src/handlers/refundLedger.ts
index 600ffca..d4aec1f 100644
--- a/src/handlers/refundLedger.ts
+++ b/src/handlers/refundLedger.ts
@@ -24,6 +24,8 @@ export class RefundLedger implements Subscriber<RefundRequested> {
   readonly name = 'RefundLedger';
 
   private readonly entries: LedgerEntry[] = [];
+  /** Booking ids the payment provider has confirmed a refund for. */
+  private readonly paid = new Set<string>();
   private readonly gateway: PaymentGateway;
 
   constructor(gateway: PaymentGateway) {
@@ -32,15 +34,23 @@ export class RefundLedger implements Subscriber<RefundRequested> {
 
   handle(message: Message<RefundRequested>): void {
     const event = message.payload;
-    this.entries.push({
-      entryId: `led-${this.entries.length + 1}`,
-      bookingId: event.bookingId,
-      organizer: event.organizer,
-      amountCents: event.amountCents,
-      reason: event.reason,
-      recordedAtMinute: message.publishedAtMinute,
-    });
-    this.gateway.refund(event.bookingId, event.amountCents);
+    // Idempotency key: the booking id. A booking can be cancelled only once,
+    // so it is owed at most one refund. Each step is checked on its own, so a
+    // delivery that wrote the entry but failed to pay is finished, not skipped.
+    if (this.forBooking(event.bookingId).length === 0) {
+      this.entries.push({
+        entryId: `led-${this.entries.length + 1}`,
+        bookingId: event.bookingId,
+        organizer: event.organizer,
+        amountCents: event.amountCents,
+        reason: event.reason,
+        recordedAtMinute: message.publishedAtMinute,
+      });
+    }
+    if (!this.paid.has(event.bookingId)) {
+      this.gateway.refund(event.bookingId, event.amountCents);
+      this.paid.add(event.bookingId);
+    }
   }
 
   /** Every ledger entry, oldest first. */
```

**What your fix uses to decide what to do on a second delivery, and what it
does not protect.** The key is the **booking id**: a booking can be cancelled
only once, so it is owed at most one refund. The handler checks each step on its
own. It writes the ledger entry only if that booking has none, and it calls the
provider only if that booking is not in its `paid` set. This also blocks a second,
different refund message for the same booking. It does **not** protect:
legitimate multiple refunds for one booking (they would be wrongly skipped), a
second refund message with a *different amount* (the first amount wins
silently), the `paid` set being lost on restart (it lives in memory, so a real
service would store it durably or pass the booking id to the provider as its
idempotency key), or a provider that settles the money but fails before
answering (we never record `paid`, so a redelivery would pay again).

### After your fix

**The run.** Paste what `npm run demo:replay` printed on the fixed code.

```
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**What stays the same across its three states.** After the cancellation,
after one redelivery, and after two: ledger entries = 1 (`led-1`), gateway calls
= 1, gateway settlements = 1 (`stl-1`), money returned = $85.00 (equal to the
refund owed), and dead letters = 0. The only number that changes is the bus's
delivery count for `msg-3`, which reaches `deliveries=3`.

---

## Milestone 3: a delivery that stops halfway

### The failure

**The run.** Run `npm run demo:failure` and paste what the delivery left
behind (the ledger, the provider, and the dead-letter list).

```
armed: call 1 to the payment provider will throw
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3
the cancel call itself returned: booking is cancelled

=== after the failed delivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 0
money returned in total: $0.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=1

the refund message is in the log and in the dead-letter list. Milestone 3 asks what you do with it.
```

### Your recovery

**What, if anything, the failed delivery left undone.** The money. The
cancellation itself finished (the booking is `cancelled` and `cancel()` returned
normally), and `RefundLedger` wrote `led-1` for $85.00. Then
`gateway.refund()` threw, so the provider settled nothing (0 settlements,
$0.00 returned). The ledger says $85.00 was refunded, but the organizer has not
been paid, so the books and the money disagree. The bus recorded one dead letter
for `msg-3` (attempt 1, `RefundLedger`), and nothing retries it on its own.

**The option you took and its evidence.** If you redelivered the
message, paste the state after the redelivery and the bus log line for that
message. If you left the message for a person to handle, write the runbook line
they would follow, and name which fields of the dead-lettered message they read to
follow it and what each one tells them.

I **redelivered** the message: `app.bus.redeliver(messageId)` at the end of
`main()` in `src/demos/failureDemo.ts`, then `printRefundState` and
`printMessageLog` again. `npm run typecheck` stays green.

```
=== after redelivering the refund message ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=2
```

Bus log line for the refund message: `msg-3 refund.requested deliveries=2`.
Delivery 1 failed at the provider, and delivery 2 finished the work. Because of
the milestone 2 fix, delivery 2 saw that `bk-1001` already had a ledger entry
and did not write `led-2`. It also saw that `bk-1001` was not yet paid, so it
called the provider (gateway call 2) and settled `stl-1` for $85.00. The ledger
($85.00) and the provider ($85.00) now agree. The dead-letter entry is still in
the list, because the list is a log of failed attempts, not a queue, and
`redeliver` removes nothing from it.

### The other option

**What the option you did not take would have cost.** Leaving it for triage
means a person has to notice the dead letter, read it, check the provider, and
act. The organizer gets their $85.00 only when someone gets to it (hours or the
next business day, not seconds). It is safe without any idempotency in the
handler, but only if that person checks the provider's settlements for
`bk-1001` before paying, so they do not pay twice.
