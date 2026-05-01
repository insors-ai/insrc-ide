/**
 * Per-session SkillEvent ring buffer.
 *
 * plans/analyzers/skills-core.md Phase 7.2.
 *
 * Mirrors the access-audit pattern (shared/access.ts AccessAuditLog):
 * a bounded ring keyed off Session lifetime, oldest events roll off
 * once the cap is exceeded. The runner's per-call emit() pushes here
 * AND to the daemon log -- the log line is for grep / forensics, the
 * ring is for the workbench skill-trace panel + the `skill.audit`
 * RPC's "what skills did this run touch?" view.
 *
 * Read-only from the consumer side: `list()` returns a snapshot. We
 * never expose the underlying array (would let a bad caller mutate
 * the audit trail of an active session).
 *
 * v1 size is 1000 events, sized off the access-audit precedent:
 * roughly 100-300 skill invocations per session at 4-7 events each.
 * If a follow-up plan adds richer per-skill telemetry the cap
 * becomes a tuning knob; for now there's no need.
 */

import type { SkillEvent } from './types.js';

export interface SkillAuditLog {
  /** Append an event. Drops the oldest entry once `maxEntries` is exceeded. */
  push(event: SkillEvent): void;
  /** Snapshot copy of the buffer in chronological order. */
  list(): readonly SkillEvent[];
  /** Drop every entry. Called on session.close(); not exposed via RPC. */
  clear(): void;
}

const DEFAULT_MAX_ENTRIES = 1000;

export class DefaultSkillAuditLog implements SkillAuditLog {
  private readonly events: SkillEvent[] = [];

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  push(event: SkillEvent): void {
    this.events.push(event);
    // Splice is O(n) but n is bounded by maxEntries+1; the cost is
    // negligible compared to the work the runner is already doing.
    if (this.events.length > this.maxEntries) {
      this.events.splice(0, this.events.length - this.maxEntries);
    }
  }

  list(): readonly SkillEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events.length = 0;
  }
}
