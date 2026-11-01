// Experience diagnostics reporting has been removed: nothing here talks to a
// network or to the daemon. These no-ops stay so the existing call sites keep
// compiling.
import type { ClientExperienceDiagnostic } from '@open-design/contracts/analytics';

export function reportExperienceFailure(
  _input: Omit<ClientExperienceDiagnostic, 'occurrenceId' | 'observedAt'>,
  _occurrence?: string,
): void {}

export function reportExperienceEvent(_event: string, _props: Record<string, unknown>): void {}

export function reportProjectFailure(
  _project: { id: string; status?: { value: string; runId?: string; updatedAt?: number } },
  _surface: string,
): void {}
