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

**Your prediction against the run.** Where they agree and where they do not.

### Your fix

**The diff.** Paste it.

**What your fix uses to decide what to do on a second delivery, and what it
does not protect.** One or two lines.

### After your fix

**The run.** Paste what `npm run demo:replay` printed on the fixed code.

**What stays the same across its three states.** Name the numbers you
compared.

---

## Milestone 3: a delivery that stops halfway

### The failure

**The run.** Run `npm run demo:failure` and paste what the delivery left
behind (the ledger, the provider, and the dead-letter list).

### Your recovery

**What, if anything, the failed delivery left undone.**

**The option you took and its evidence.** If you redelivered the
message, paste the state after the redelivery and the bus log line for that
message. If you left the message for a person to handle, write the runbook line
they would follow, and name which fields of the dead-lettered message they read to
follow it and what each one tells them.

### The other option

**What the option you did not take would have cost.** One line, in terms of who
does the work, when the organizer gets their money, and what has to be true for
it to be safe.
