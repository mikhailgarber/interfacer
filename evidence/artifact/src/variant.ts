/**
 * What this project was recorded against.
 *
 * Not a runtime check: the entry point is an input, so one artifact serving many
 * hosts is the intended behaviour and a host difference is normal rather than a
 * signal. It is a diagnosis. When a run reports drift, this says what the
 * artifact was built against, which is what makes the cause findable — a field
 * nobody thought to edit when they copied the project and changed the URL.
 *
 * A field nobody knows is absent rather than guessed: a fabricated version reads
 * as fact.
 */
export const variant = {
  capability: 'balanceLookup',
  recordedAgainst: '127.0.0.1:4001',
  recordedOn: '2026-09-02',
} as const;
