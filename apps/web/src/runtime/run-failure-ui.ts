// Shared logic that maps a failed run's error code + agent into the failure
// UI: which contextual button the gray error card shows and whether to override
// the error text. Kept in its own module so ChatPane / ProjectView /
// AssistantMessage can import it without a circular dependency.
//
// ⚠️ Deliberately free of runtime dependencies beyond `utils/byokProvider`
// (`import type` only), so `providers/daemon.ts` and the chat components can
// both read it without closing an import cycle.
import type { RunFailureAction } from '@open-design/contracts';
import { byokApiKeyIsEditableInSettings } from '../utils/byokProvider';

// The primary action the failure card offers. Terminal-launch actions pair
// with `secondaryRetry: true` so the user has a Retry button after the
// external step completes (OAuth / switching models happens out-of-band; we
// can't auto-retry from the daemon side).
export type RunFailurePrimaryAction =
  | 'retry'
  | 'switch-model'
  | 'open-settings'
  | 'launch-terminal-auth'
  | 'launch-terminal-switch-model'
  | 'contact-support';

// i18n keys for the gray-card text override (null = show the fallback copy).
// Keys whose value carries `{agent}` are interpolated at render time via
// t(key, { agent }) (see ChatPane displayError).
export type RunFailureMessageKey =
  | 'chat.connectionDropped'
  | 'chat.runError.signInMessage.other'
  | 'chat.runError.cliMissingMessage'
  | 'chat.runError.promptTooLargeMessage'
  | 'chat.runError.modelUnavailableMessage'
  | 'chat.runError.modelCapabilityUnsupportedMessage'
  | 'chat.runError.artifactMissingMessage'
  | 'chat.runError.rateLimitedMessage'
  | 'chat.runError.upstreamUnavailableMessage'
  | 'chat.runError.toolLoopMessage'
  | 'chat.runError.outputInvalidMessage'
  | 'chat.runError.runtimeConfigMessage'
  | 'chat.runError.apiKeyInvalidMessage'
  | 'chat.runError.quotaExhaustedMessage'
  | 'chat.runError.timedOutMessage'
  | 'chat.runError.inactivityTimeoutMessage'
  | 'chat.runError.emptyOutputMessage'
  | 'chat.runError.sessionExpiredMessage'
  | 'chat.runError.gitBashMissingMessage'
  | 'chat.runError.cpuUnsupportedMessage'
  | 'chat.runError.osUnsupportedMessage'
  | 'chat.runError.agentCrashedMessage'
  | 'chat.runError.accountSuspendedMessage'
  | 'chat.runError.certificateFailureMessage'
  | 'chat.runError.proxyConfigurationMessage'
  | 'chat.runError.networkConfigurationMessage'
  | 'chat.runError.hostPolicyBlockMessage'
  | 'chat.runError.localStorageFailureMessage'
  | 'chat.runError.fallbackMessage'
  | 'chat.runError.cliSessionRefusedMessage'
  | 'chat.runError.strategyTaskStateMismatchMessage'
  | 'chat.runError.agentReplyIncompleteMessage'
  | 'chat.runError.noDeliverableMessage'
  | 'chat.runError.clarificationRepeatedMessage'
  | 'chat.runError.regionNotSupportedMessage'
  | 'chat.runError.clientEnvironmentMessage'
  | null;

/**
 * The `{cause}` half of S30's sentence — the parenthesis the design writes as
 * 「{地区不支持 / 证书校验失败}」, i.e. a slot, not a fixed phrase.
 *
 * It is a KEY rather than a string because this module has no `t`: the card
 * resolves it at render time next to `{agent}` (see ChatPane's
 * `runFailureMessageVars`). Keeping the five causes in one sentence — instead
 * of five near-identical sentences — is also what keeps the copy honest across
 * 19 locales: only the noun changes.
 */
export type RunFailureCauseKey =
  | 'chat.runError.clientEnvironmentCause.certificate'
  | 'chat.runError.clientEnvironmentCause.proxy'
  | 'chat.runError.clientEnvironmentCause.network'
  | 'chat.runError.clientEnvironmentCause.hostPolicy'
  | 'chat.runError.clientEnvironmentCause.localStorage';

/**
 * The one sentence a failure card falls back to when its mapping carries no
 * copy of its own.
 *
 * The raw upstream string never renders on the card face: it is persisted on
 * the assistant message's error event and travels out through 〔Export logs〕
 * (`/api/diagnostics/export`), which is where the engineering-facing copy
 * belongs.
 */
export const RUN_FAILURE_FALLBACK_MESSAGE_KEY =
  'chat.runError.fallbackMessage' as const;

/** What the failure card's description slot renders. */
export type RunErrorCardDescription =
  /** No card — another surface already owns this story. */
  | { render: 'none' }
  /** This failure's own mapped copy (interpolated by the caller). */
  | { render: 'mapped'; messageKey: NonNullable<RunFailureMessageKey> }
  /** RUN_FAILURE_FALLBACK_MESSAGE_KEY — nothing we can say more precisely. */
  | { render: 'fallback' }
  /** Copy this app wrote into the shared pane slot; safe to render verbatim. */
  | { render: 'app-text'; text: string };

/**
 * What the failure card says, decided by the PROVENANCE of the text rather than
 * by which branch of the ladder the failure fell through.
 *
 * **Invariant: the card face only ever renders words this app wrote.** Anything
 * that came back from a run — the daemon's `message`, the agent's stderr, an
 * ACP JSON-RPC envelope — resolves to `{ render: 'fallback' }`, no matter how
 * it reached the card.
 *
 * The pane slot (`error`) is shared, which is why it needs a provenance flag of
 * its own: `setError(...)` fills it with copy this app wrote (a conversation
 * that would not load), while `setRunError(message, assistantId)` fills it with
 * a run's raw message. Only the former may be rendered verbatim, and the caller
 * distinguishes them by whether a source assistant id came with it.
 */
export function resolveRunErrorCardDescription(input: {
  /** The failure is being told by some other surface (reconnect row). */
  handedToAnotherSurface: boolean;
  /** `runFailureUi.messageKey` — null when the mapping table has no copy for it. */
  mappedMessageKey: RunFailureMessageKey;
  /** The shared pane-level error slot. */
  paneError: string | null;
  /** True when the pane slot was filled by a run failure (`setRunError`), not by us. */
  paneErrorCameFromARun: boolean;
  /** The failed run's own upstream string, off its persisted error event. */
  failedRunRawDetail: string | null;
  /**
   * This turn really did end in a terminal, user-facing failure — a failed run
   * process, or a run whose result never got delivered — and no other surface
   * is announcing it. When it holds and the three sources are all empty, the
   * card still has to appear: it is the only thing on screen carrying
   * 〔Retry〕〔Export logs〕〔Contact support〕.
   */
  turnEndedInTerminalFailure: boolean;
}): RunErrorCardDescription {
  if (input.handedToAnotherSurface) return { render: 'none' };
  if (input.mappedMessageKey) {
    return { render: 'mapped', messageKey: input.mappedMessageKey };
  }
  // An empty pane slot is not a source — only a slot with words in it decides
  // anything.
  if (input.paneError) {
    return input.paneErrorCameFromARun
      ? { render: 'fallback' }
      : { render: 'app-text', text: input.paneError };
  }
  // Nothing in the pane slot, so the only text left is the run's own — raw by
  // definition, whether or not a `runFailureUi` was resolved for it.
  if (input.failedRunRawDetail) return { render: 'fallback' };
  // Nothing to say, but something to say it ABOUT: a terminal failure always
  // gets a card, so the turn keeps its explanation and its way out.
  return input.turnEndedInTerminalFailure
    ? { render: 'fallback' }
    : { render: 'none' };
}

// i18n keys for the unified error card's TITLE (the "error type" line above the
// detail message). Frontend-only mapping from error code → human-readable type.
export type RunFailureTitleKey =
  | 'chat.runError.title.authRequired'
  | 'chat.runError.title.connectionDropped'
  // S02 · a local agent is not signed in (`{agent}` is filled at render time).
  | 'chat.runError.title.signInRequired.other'
  | 'chat.runError.title.rateLimited'
  | 'chat.runError.title.cliMissing'
  | 'chat.runError.title.promptTooLarge'
  | 'chat.runError.title.modelUnavailable'
  // S13 · 「模型能力不支持」—— 和上面那格**不是**同一句话。
  | 'chat.runError.title.modelCapabilityUnsupported'
  | 'chat.runError.title.upstreamUnavailable'
  | 'chat.runError.title.toolLoop'
  | 'chat.runError.title.outputInvalid'
  | 'chat.runError.title.runtimeConfig'
  | 'chat.runError.title.apiKeyInvalid'
  | 'chat.runError.title.quotaExhausted'
  | 'chat.runError.title.timedOut'
  | 'chat.runError.title.emptyOutput'
  | 'chat.runError.title.sessionExpired'
  | 'chat.runError.title.gitBashMissing'
  | 'chat.runError.title.artifactMissing'
  | 'chat.runError.title.cpuUnsupported'
  | 'chat.runError.title.osUnsupported'
  | 'chat.runError.title.agentCrashed'
  | 'chat.runError.title.accountSuspended'
  | 'chat.runError.title.cliSessionRefused'
  | 'chat.runError.title.strategyTaskHalted'
  | 'chat.runError.title.agentReplyIncomplete'
  | 'chat.runError.title.noDeliverable'
  | 'chat.runError.title.clarificationRepeated'
  | 'chat.runError.title.regionNotSupported'
  | 'chat.runError.title.clientEnvironment'
  | 'chat.runError.title.certificateFailure'
  | 'chat.runError.title.proxyConfiguration'
  | 'chat.runError.title.networkConfiguration'
  | 'chat.runError.title.hostPolicyBlock'
  | 'chat.runError.title.localStorageFailure'
  | 'chat.runError.title.generic';

export interface RunFailureUi {
  primaryAction: RunFailurePrimaryAction;
  // Title shown above the detail message — names the failure type.
  titleKey: RunFailureTitleKey;
  // Override the gray error card's text with a clearer explanation than the
  // raw upstream string; null falls back to RUN_FAILURE_FALLBACK_MESSAGE_KEY.
  messageKey: RunFailureMessageKey;
  // Interpolation values for `messageKey`, for the cases whose copy names
  // something the daemon read off the failure. Absent for every message that
  // is a fixed sentence.
  messageVars?: Record<string, string>;
  // A `{cause}` the copy names but that is itself localized, so it arrives as a
  // key and is translated next to `{agent}` at render time. Only S30 uses it.
  messageCauseKey?: RunFailureCauseKey;
  // Show a secondary plain "retry" button alongside the primary action (used
  // where the fix lands out-of-band, so retry is manual afterwards).
  secondaryRetry: boolean;
  /**
   * Draw no error card. Existing run status and diagnostics remain intact.
   *
   * The browser↔daemon stream drop hands its card to the reconnect line at
   * the tail of the conversation (grid 82–84, S29), which is already saying
   * the same thing with the right button. Two blocks of UI for one event, in
   * two different wordings, is exactly what the design forbids. Missing Git
   * Bash also sets this flag by product decision: the existing failed-run
   * status remains, with no replacement card or installation UI.
   */
  suppressCard?: boolean;
}

/**
 * The browser↔daemon SSE stream ran out of reconnect budget.
 *
 * Duplicated from `providers/daemon.ts` rather than imported, so this module
 * stays free of runtime dependencies. `run-error-ladder.test.ts` pins the two
 * copies equal, since a silently drifting copy is the failure mode of writing
 * it twice.
 */
export const RECONNECT_OWNED_FAILURE_CODE = 'DAEMON_STREAM_DISCONNECTED';
const RECONNECT_OWNED_FAILURE_MESSAGE =
  'daemon stream disconnected before run completed';

/**
 * Is this failure the one the reconnect line already speaks for?
 *
 * Reads the same code-or-message pair as `ProjectView`'s
 * `hasGenericDisconnectFailureEvent`: rows persisted before the structured code
 * existed carry only the sentence, and they have to be recognized too.
 *
 * Not the same thing as `AGENT_CONNECTION_DROPPED` (S11): that is the agent's
 * connection to the MODEL service, which the reconnect line knows nothing about
 * and cannot re-establish, so that failure keeps its card and its retry.
 */
export function isReconnectOwnedFailure(
  code: string | null | undefined,
  rawMessage?: string | null,
): boolean {
  if (code === RECONNECT_OWNED_FAILURE_CODE) return true;
  return typeof rawMessage === 'string'
    && rawMessage.trim() === RECONNECT_OWNED_FAILURE_MESSAGE;
}

/**
 * The rung-1 actions: the things we can do FOR the user in one click.
 *
 * Narrowed out of `RunFailurePrimaryAction` so a mapping cannot accidentally
 * declare "we have a direct fix" and then name `retry` (rung 2) or
 * `contact-support` (rung 3) as that fix.
 */
export type RunFailureDirectFix = Extract<
  RunFailurePrimaryAction,
  | 'switch-model'
  | 'open-settings'
  | 'launch-terminal-auth'
  | 'launch-terminal-switch-model'
>;

/**
 * What KIND of failure this is — the only thing a mapping has to declare.
 *
 * Every field is a question about the failure itself, not about the button we
 * want. The button is derived (`primaryActionForFailure`), which is the whole
 * point: adding a new failure code means answering two questions, not picking
 * a CTA by hand and hoping it stays consistent with the ones picked before it.
 */
export interface RunFailureNature {
  /** Rung 1 — we have a one-click action that actually resolves this. */
  directFix?: RunFailureDirectFix;
  /** Rung 2 — running it again can plausibly succeed (possibly after the user does something). */
  transient?: boolean;
}

/**
 * The primary-button ladder (`specs/current/run-error-catalog.md` §6.Z),
 * top-down; the first rung that matches wins.
 *
 *   1. We have an action that directly solves it   → that action
 *   2. The failure is transient                    → retry from where it failed
 *   3. None of the above                           → contact support (promoted
 *                                                     from the standing secondary)
 *
 * Rung 3 is what makes design principle 4 hold structurally rather than by
 * vigilance: a failure that declares neither a direct fix nor transience can no
 * longer end up with a Retry button, because nothing in this function can
 * produce one.
 */
export function primaryActionForFailure(
  nature: RunFailureNature,
): RunFailurePrimaryAction {
  if (nature.directFix) return nature.directFix;
  if (nature.transient) return 'retry';
  return 'contact-support';
}

/**
 * The daemon's own reading of a failed run: can it be re-run, and what should
 * the user do. Both are computed at finalize time
 * (`apps/daemon/src/run-failure-classification.ts` → `retryable` /
 * `user_action`) and published on `GET /api/runs/:id`
 * (`ChatRunStatusResponse.failureAction`).
 */
export interface RunFailureDaemonVerdict {
  /** Daemon's `retryable`. */
  retryable?: boolean | null;
  /** Daemon's `user_action`, as published on the run-status response. */
  failureAction?: RunFailureAction | null;
}

/**
 * Did the daemon put a NAME on this failure?
 *
 * The classifier emits a specific `failure_detail` when it recognised the
 * cause, and the literal `'unknown'` when it did not. An absent detail is an
 * older daemon that classified nothing at all, which is the same situation.
 *
 * What it does NOT settle is the button: among the causes the daemon names but
 * this module has no row for there are both futile and transient ones, so
 * "named" alone cannot demote a Retry. That call belongs to the daemon's own
 * verdict — see {@link RunFailureDaemonVerdict}.
 */
export function daemonNamedTheFailure(detail: string | null | undefined): boolean {
  return typeof detail === 'string' && detail.length > 0 && detail !== 'unknown';
}

/**
 * Did the daemon already decide that running this again cannot help?
 *
 * Either half is sufficient and they are written independently upstream:
 * `retryable: false` is the classifier's verdict, `failureAction: 'none'` is
 * the same verdict expressed as an instruction. An absent verdict answers no,
 * which is what keeps an older daemon on today's behaviour.
 */
function daemonSaysRetryIsFutile(
  verdict: RunFailureDaemonVerdict | null | undefined,
): boolean {
  if (!verdict) return false;
  return verdict.retryable === false || verdict.failureAction === 'none';
}

/**
 * Read the daemon's verdict off whatever the chat has for this failure.
 *
 * Deliberately structural rather than typed against the event, the same shape
 * of defensive read `runFailureFieldsFromError` already uses. Returns undefined
 * when neither field is present, so a caller passes nothing through rather
 * than an object that says "we asked and the answer was nothing".
 */
export function daemonFailureVerdictFrom(
  source: unknown,
): RunFailureDaemonVerdict | undefined {
  const value = source as
    | { retryable?: unknown; failureAction?: unknown }
    | null
    | undefined;
  if (!value || typeof value !== 'object') return undefined;
  const retryable = typeof value.retryable === 'boolean' ? value.retryable : undefined;
  const failureAction =
    typeof value.failureAction === 'string'
      ? (value.failureAction as RunFailureAction)
      : undefined;
  if (retryable === undefined && failureAction === undefined) return undefined;
  return {
    ...(retryable === undefined ? {} : { retryable }),
    ...(failureAction === undefined ? {} : { failureAction }),
  };
}

/**
 * Does the LADDER hand this card a control that can push the failed run forward?
 *
 * Rung 3 answers no: 〔contact support〕 opens a conversation, not a recovery.
 * Callers use it to decide whether to offer the generic local-CLI escape hatch
 * alongside.
 */
export function hasSelfContainedRecovery(ui: RunFailureUi | null | undefined): boolean {
  if (!ui) return false;
  if (ui.secondaryRetry) return true;
  return ui.primaryAction !== 'contact-support';
}

/**
 * Build a failure card from the nature of the failure. Callers never name a
 * primary action — they describe the failure and the ladder answers.
 */
function failureCard(
  nature: RunFailureNature,
  titleKey: RunFailureTitleKey,
  messageKey: RunFailureMessageKey,
  extra: Partial<Pick<RunFailureUi, 'secondaryRetry' | 'messageVars' | 'messageCauseKey'>> = {},
): RunFailureUi {
  return {
    primaryAction: primaryActionForFailure(nature),
    titleKey,
    messageKey,
    secondaryRetry: extra.secondaryRetry ?? false,
    ...(extra.messageVars ? { messageVars: extra.messageVars } : {}),
    ...(extra.messageCauseKey ? { messageCauseKey: extra.messageCauseKey } : {}),
  };
}

// Named failure type + actionable copy, recovered by re-running once the user
// has followed the instruction (ladder rung 2).
function retryWithGuidance(
  titleKey: RunFailureTitleKey,
  messageKey: RunFailureMessageKey,
): RunFailureUi {
  return failureCard({ transient: true }, titleKey, messageKey);
}

/**
 * The selected model cannot serve this run at all — it is missing, disabled, or
 * no longer in the catalogue. Retrying re-picks the same model and reproduces
 * the same answer, so the card offers the one thing that changes the outcome:
 * picking a different model (ladder rung 1).
 */
function switchModelWithGuidance(
  titleKey: RunFailureTitleKey,
  messageKey: RunFailureMessageKey,
): RunFailureUi {
  return failureCard({ directFix: 'switch-model' }, titleKey, messageKey);
}

/**
 * Named environment failures use the approved supplementary copy
 * (L7ukd6xcqoWpo2xJzKdcDPctnvh, revision 96), not the region-only S30 text.
 * Keep each existing recovery action and cause identity when changing copy.
 */
function clientEnvironmentCard(
  titleKey: RunFailureTitleKey,
  messageKey: RunFailureMessageKey,
  causeKey: RunFailureCauseKey,
): RunFailureUi {
  return failureCard(
    { directFix: 'open-settings' },
    titleKey,
    messageKey,
    { secondaryRetry: true, messageCauseKey: causeKey },
  );
}

/**
 * Nothing on this card can move the run forward and retrying is futile
 * (ladder rung 3). 〔Contact support〕 — a standing secondary on every failure
 * card — is promoted to primary so the card is never a dead end.
 */
function contactSupportOnly(
  titleKey: RunFailureTitleKey,
  messageKey: RunFailureMessageKey,
): RunFailureUi {
  return failureCard({}, titleKey, messageKey);
}

/**
 * The card for "the agent replied, but the reply could not be recorded".
 *
 * A function rather than a shared constant because `AGENT_AGNOSTIC_FAILURE_UI`
 * hands its values straight to callers; four references to one frozen-by-
 * convention object would let a future mutation of one code's card silently
 * rewrite the other three.
 */
function agentReplyIncomplete(): RunFailureUi {
  return retryWithGuidance(
    'chat.runError.title.agentReplyIncomplete',
    'chat.runError.agentReplyIncompleteMessage',
  );
}

// Agent-agnostic failure codes that carry a clear root cause and a concrete
// fix, mapped the same way regardless of which agent produced them. The daemon
// already classifies these into failure_category / user_action
// (apps/daemon/src/run-failure-classification.ts); this is the user-facing half
// of that taxonomy — a human-readable type name plus a one-line instruction.
const AGENT_AGNOSTIC_FAILURE_UI: Record<string, RunFailureUi> = {
  // S23 · the run finished but produced no file.
  ARTIFACT_NOT_FOUND: retryWithGuidance(
    'chat.runError.title.artifactMissing',
    'chat.runError.artifactMissingMessage',
  ),
  // CLI binary not found on PATH (user_action: install_cli).
  AGENT_UNAVAILABLE: retryWithGuidance(
    'chat.runError.title.cliMissing',
    'chat.runError.cliMissingMessage',
  ),
  // Input exceeded the model context window (user_action: reduce_context).
  AGENT_PROMPT_TOO_LARGE: retryWithGuidance(
    'chat.runError.title.promptTooLarge',
    'chat.runError.promptTooLargeMessage',
  ),
  // Guard halted a repeating, non-progressing tool loop (user_action: retry
  // after checking the real target).
  TOOL_LOOP_DETECTED: retryWithGuidance(
    'chat.runError.title.toolLoop',
    'chat.runError.toolLoopMessage',
  ),
  // Model emitted a fabricated role marker and was aborted; a plain retry
  // usually recovers.
  ROLE_MARKER_HALLUCINATION: retryWithGuidance(
    'chat.runError.title.outputInvalid',
    'chat.runError.outputInvalidMessage',
  ),
  // Checked-in runtime def failed strict validation (user_action: fix_config).
  // Ladder rung 3 (catalogue R-031: flow F10, "retryable: no"): the user cannot
  // self-repair and a new run re-reads the same invalid definition.
  AGENT_RUNTIME_DEF_INVALID: contactSupportOnly(
    'chat.runError.title.runtimeConfig',
    'chat.runError.runtimeConfigMessage',
  ),
  // R9 · the browser↔daemon stream gave up reconnecting. Ladder rung 2 — the
  // stream can be re-established, and 〔重新连接〕 already exists for exactly
  // that. But the button lives on the reconnect line at the tail of the
  // conversation (grid 84, S29), not on a card, so this mapping draws no card:
  // the run may well still be alive on the daemon (`ProjectView` re-attaches
  // any run whose only failure event is this one), and a card claiming "task
  // failed" would be both a duplicate and a lie.
  [RECONNECT_OWNED_FAILURE_CODE]: {
    ...failureCard(
      { transient: true },
      'chat.runError.title.connectionDropped',
      'chat.connectionDropped',
    ),
    suppressCard: true,
  },
  // A strategy-task continuation (clarification answer) arrived after the
  // daemon's OD Next protocol gate already settled the task — typically a
  // sticky `blocked` verdict. This is a task-lifecycle rejection, not an
  // engine failure.
  STRATEGY_TASK_STATE_MISMATCH: retryWithGuidance(
    'chat.runError.title.strategyTaskHalted',
    'chat.runError.strategyTaskStateMismatchMessage',
  ),
  // The turn ran to the end and produced no openable file. Ladder rung 2: the
  // deliverable is missing because THIS turn wrote nothing, and a re-run is
  // exactly the thing that can write it.
  od_next_canonical_deliverable_invalid: retryWithGuidance(
    'chat.runError.title.noDeliverable',
    'chat.runError.noDeliverableMessage',
  ),
  // The agent answered — completely, readably, and the reply is already on
  // screen — but the reply carried no usable Runtime State block. All four
  // Runtime State issue codes (`strategies/od-next/protocol.ts`) share the row:
  // to the user they are one story — the reply came back without the marker.
  od_next_protocol_runtime_state_missing: agentReplyIncomplete(),
  od_next_protocol_runtime_state_duplicate: agentReplyIncomplete(),
  od_next_protocol_runtime_state_invalid_json: agentReplyIncomplete(),
  od_next_protocol_runtime_state_invalid_schema: agentReplyIncomplete(),
  // The user answered the clarification form, and the agent came back with
  // ANOTHER question instead of proceeding. Retry does not re-roll this turn,
  // it opens a NEW task (`handleRetry` sends no `strategyTaskExecutionId`), so
  // asking a question becomes a legal outcome again.
  od_next_clarification_repeated: retryWithGuidance(
    'chat.runError.title.clarificationRepeated',
    'chat.runError.clarificationRepeatedMessage',
  ),
};

// Failure causes keyed by the daemon's fine-grained `failure_detail`, for the
// cases where the coarse `error_code` alone is wrong or too vague. This layer
// can OVERRIDE a code mapping — e.g. `hard_quota` and a transient 429 share
// `error_code: RATE_LIMITED`, but only the transient one should offer Retry.
// Applied after the Antigravity agent-specific handling (which owns its own
// quota/auth flows) and before the generic code branches.
const DETAIL_FAILURE_UI: Record<string, RunFailureUi> = {
  // Provider quota / billing hard-stop: retrying reproduces the failure, and
  // topping it up / changing keys is not something we can do for the user, so
  // the card offers no Retry (design principle 4; ladder rung 3).
  hard_quota: contactSupportOnly(
    'chat.runError.title.quotaExhausted',
    'chat.runError.quotaExhaustedMessage',
  ),
  // CLI binary missing detected only from text (leaks in as the opaque
  // AGENT_EXECUTION_FAILED code, not AGENT_UNAVAILABLE) — reuse the same
  // "install the CLI, then retry" card the code path already renders.
  cli_not_installed: retryWithGuidance(
    'chat.runError.title.cliMissing',
    'chat.runError.cliMissingMessage',
  ),
};

/**
 * S05 · 自带 API key 没配好 —— **只对那把 key 我们自己存着的一轮成立**。
 *
 * `authDetail()` 是从**任何** agent 拍平的 stderr 上读出来的,所以本机 CLI 一样
 * 会报 `invalid_api_key`。而本机 CLI 的登录态在用户自己的终端里:把它们送去设置页,
 * 是把人送到一屏**改不了那把 key** 的界面上,同时还吃掉了它们本来该看到的 S02
 * 「{agent} 尚未登录」+ 终端登录指引。
 *
 * 所以这一格按 `byokApiKeyIsEditableInSettings` 收窄到 BYOK / API 提供商那一档
 * (`utils/byokProvider.ts`,和发送前那道 BYOK 闸门是同一条线);不在这一档的
 * agent 一律**继续往下走**,落回它们原本的那条路。
 *
 * 主按钮〔去设置〕是阶梯第 1 档:落点是 `execution` 这一节,BYOK 的 key 输入框
 * (`ByokKeyField`)就渲染在那一屏。不带重试:key 没改之前重试必然同样结果
 * (设计原则四)。
 */
function apiKeyInvalidCardFor(agentId: string | null | undefined): RunFailureUi | null {
  if (!byokApiKeyIsEditableInSettings(agentId)) return null;
  return failureCard(
    { directFix: 'open-settings' },
    'chat.runError.title.apiKeyInvalid',
    'chat.runError.apiKeyInvalidMessage',
  );
}

// Agent-agnostic failure causes keyed by the daemon's `failure_detail`, resolved
// BEFORE the agent branches (unlike DETAIL_FAILURE_UI above). These are
// engine-neutral run outcomes — a timeout, an empty result, a stale resumed
// session, a missing Git Bash — that carry the same named type + fix for every
// agent. They leak in under the opaque AGENT_EXECUTION_FAILED / process-exit
// codes, so without this the card would only show the fallback sentence.
const AGENT_AGNOSTIC_DETAIL_FAILURE_UI: Record<string, RunFailureUi> = {
  stream_disconnected: retryWithGuidance(
    'chat.runError.title.connectionDropped',
    'chat.connectionDropped',
  ),
  // Hard wall-clock timeout for the run (daemon user_action: retry).
  timeout: retryWithGuidance(
    'chat.runError.title.timedOut',
    'chat.runError.timedOutMessage',
  ),
  // The agent stalled (no new output for too long) and was cut off as a
  // timeout. Distinct copy from a hard timeout, same retry recovery.
  inactivity_timeout: retryWithGuidance(
    'chat.runError.title.timedOut',
    'chat.runError.inactivityTimeoutMessage',
  ),
  // Run terminated without producing any output (daemon user_action: retry).
  empty_output: retryWithGuidance(
    'chat.runError.title.emptyOutput',
    'chat.runError.emptyOutputMessage',
  ),
  // A resumed agent session id went stale; the daemon already cleared it so the
  // next run starts fresh (#3408).
  session_resume_expired: retryWithGuidance(
    'chat.runError.title.sessionExpired',
    'chat.runError.sessionExpiredMessage',
  ),
  // Product decision (2026-09-14): no error card for missing Git Bash.
  // Keep the daemon's failed-run diagnosis and the existing run-status shell;
  // suppressing this surface does not turn the failed run into a success.
  git_bash_missing: {
    ...retryWithGuidance(
      'chat.runError.title.gitBashMissing',
      'chat.runError.gitBashMissingMessage',
    ),
    suppressCard: true,
  },
  // The bundled agent binary needs a CPU instruction set (AVX2) this device
  // doesn't have, so it crashes on launch — retrying reproduces the crash. The
  // fix is updating OpenDesign to a build that bundles a compatible runtime.
  // Ladder rung 3 (§6.Z principle 4: "quota spent, account suspended, CPU
  // unsupported — these three get no Retry").
  cpu_unsupported: contactSupportOnly(
    'chat.runError.title.cpuUnsupported',
    'chat.runError.cpuUnsupportedMessage',
  ),
  // The bundled runtime cannot load on this Windows build (older than 10 1809 /
  // build 17763). Deterministic like cpu_unsupported, so no Retry.
  os_unsupported: contactSupportOnly(
    'chat.runError.title.osUnsupported',
    'chat.runError.osUnsupportedMessage',
  ),
  // S19 · the agent exited and did not say why. Causes we CAN name resolve
  // earlier (cli missing, Git Bash, timeouts, stale session, CPU): these six
  // are the residue where the exit carries no reason. Ladder rung 2.
  process_crashed: retryWithGuidance(
    'chat.runError.title.agentCrashed',
    'chat.runError.agentCrashedMessage',
  ),
  signal_killed: retryWithGuidance(
    'chat.runError.title.agentCrashed',
    'chat.runError.agentCrashedMessage',
  ),
  terminated_unknown: retryWithGuidance(
    'chat.runError.title.agentCrashed',
    'chat.runError.agentCrashedMessage',
  ),
  exit_code: retryWithGuidance(
    'chat.runError.title.agentCrashed',
    'chat.runError.agentCrashedMessage',
  ),
  exit_nonzero: retryWithGuidance(
    'chat.runError.title.agentCrashed',
    'chat.runError.agentCrashedMessage',
  ),
  execution_failed: retryWithGuidance(
    'chat.runError.title.agentCrashed',
    'chat.runError.agentCrashedMessage',
  ),
  // S10 · the agent service failed at the protocol level and did not come
  // back. `fatal_rpc_error` is what the daemon writes when the ACP/JSON-RPC
  // channel to the agent reported a FATAL and the child closed; the named
  // members of that family are all extracted ahead of this row, so what is left
  // is "the service backing this agent broke and did not say anything we can
  // act on". By the time a card renders the run has already burned its
  // automatic retry (`run-retry-policy.ts`), which makes S10's "已自动重试过"
  // literally true.
  fatal_rpc_error: retryWithGuidance(
    'chat.runError.title.upstreamUnavailable',
    'chat.runError.upstreamUnavailableMessage',
  ),
  // S10 as well — catalogue R-051 ("上游 5xx / 过载 529 / 网关 502") names
  // exactly these two details, both retryable. The ACP/JSON-RPC path's `fail()`
  // hard-codes `AGENT_EXECUTION_FAILED` and never upgrades the code from the
  // text, so they arrive here carrying the opaque code plus one of these
  // details. Ladder rung 2 — matches the daemon's own verdict for this family.
  //
  // ⚠️ `upstream_client_error` and `network_error` are deliberately NOT here:
  // a 4xx repeats identically (`retryable: false`), and `network_error` is the
  // residue where the endpoint was never reached (R-054, client environment).
  upstream_5xx: retryWithGuidance(
    'chat.runError.title.upstreamUnavailable',
    'chat.runError.upstreamUnavailableMessage',
  ),
  provider_high_demand: retryWithGuidance(
    'chat.runError.title.upstreamUnavailable',
    'chat.runError.upstreamUnavailableMessage',
  ),
  // S18 · risk control suspended the account (catalogue R-064: "card — contact
  // support, no Retry"). Ladder rung 3.
  account_suspended: contactSupportOnly(
    'chat.runError.title.accountSuspended',
    'chat.runError.accountSuspendedMessage',
  ),
  // The `model_unavailable` family — the one failure class the daemon fully
  // diagnoses AND prescribes for (`modelUnavailableDetail()` rules the run
  // `retryable: false` / `user_action: 'switch_model'`). A BYOK agent's model
  // problem arrives as the opaque `AGENT_EXECUTION_FAILED` plus one of these
  // details. Ladder rung 1, and NO retry — neither primary nor secondary: the
  // model picker is ours and re-picking is the one act that changes the
  // outcome. These rows do not READ the daemon verdict: the card is right for
  // an older daemon that ships the detail without it.
  //
  // ⚠️ `provider_routing_error` is deliberately NOT here even though
  // `modelUnavailableDetail()` also emits it: `upstreamDetail()` emits the SAME
  // string for a retryable upstream failure, and this module receives the
  // detail without the category, so one row would mis-card the upstream half.
  cli_version_incompatible: switchModelWithGuidance(
    'chat.runError.title.modelUnavailable',
    'chat.runError.modelUnavailableMessage',
  ),
  model_not_found: switchModelWithGuidance(
    'chat.runError.title.modelUnavailable',
    'chat.runError.modelUnavailableMessage',
  ),
  // S13 的另一半:「模型能力不支持」。和 S07「当前模型不可用」不是同一句话 ——
  // 那句说的是「这个模型现在用不了」,这句说的是「这个模型做不了这件事」。
  model_not_supported: switchModelWithGuidance(
    'chat.runError.title.modelCapabilityUnsupported',
    'chat.runError.modelCapabilityUnsupportedMessage',
  ),
  model_disabled: switchModelWithGuidance(
    'chat.runError.title.modelCapabilityUnsupported',
    'chat.runError.modelCapabilityUnsupportedMessage',
  ),
  local_model_not_loaded: switchModelWithGuidance(
    'chat.runError.title.modelCapabilityUnsupported',
    'chat.runError.modelCapabilityUnsupportedMessage',
  ),
  // S30 · the five client-environment causes. Agent-agnostic on purpose and
  // resolved here, ahead of every agent branch: the proxy, the certificate
  // store, the route and the host policy belong to the user's machine, so the
  // card is the same one whichever agent happened to be running.
  certificate_failure: clientEnvironmentCard(
    'chat.runError.title.certificateFailure',
    'chat.runError.certificateFailureMessage',
    'chat.runError.clientEnvironmentCause.certificate',
  ),
  proxy_configuration: clientEnvironmentCard(
    'chat.runError.title.proxyConfiguration',
    'chat.runError.proxyConfigurationMessage',
    'chat.runError.clientEnvironmentCause.proxy',
  ),
  network_configuration: clientEnvironmentCard(
    'chat.runError.title.networkConfiguration',
    'chat.runError.networkConfigurationMessage',
    'chat.runError.clientEnvironmentCause.network',
  ),
  host_policy_block: clientEnvironmentCard(
    'chat.runError.title.hostPolicyBlock',
    'chat.runError.hostPolicyBlockMessage',
    'chat.runError.clientEnvironmentCause.hostPolicy',
  ),
  local_storage_failure: clientEnvironmentCard(
    'chat.runError.title.localStorageFailure',
    'chat.runError.localStorageFailureMessage',
    'chat.runError.clientEnvironmentCause.localStorage',
  ),
};

// Resolve the failure UI for a failed run:
//   - ACP CLI refused the session → named type + change-the-CLI guidance
//   - agent-agnostic root cause (cli missing, prompt too large, tool loop,
//     bad output, bad runtime def) → named type + fix
//   - agent-agnostic failure_detail (timeout, empty output, stale resumed
//     session, model unavailable, client environment) → named type + fix,
//     for every agent
//   - missing Git Bash → retain failed-run status without an error card
//   - Antigravity, auth / per-model quota → launch the terminal flow + retry
//   - BYOK invalid API key → open Settings
//   - fine-grained failure_detail (hard quota, text-detected cli-missing)
//     → named type + fix, overriding a too-coarse code
//   - model/auth/quota error code → plain retry + named copy
//   - any agent, generic failure → plain retry, unless the daemon named the
//     cause and ruled a retry futile
export function resolveRunFailureUi(
  code: string | null | undefined,
  detail: string | null | undefined,
  agentId: string | null | undefined,
  verdict?: RunFailureDaemonVerdict | null,
): RunFailureUi {
  const ui = resolveRunFailureUiByTables(code, detail, agentId, verdict);
  // S30 changes copy only. Keep the existing code/agent/verdict action
  // selection, and never infer a region restriction from the raw message.
  return detail === 'region_not_supported'
    ? {
      ...ui,
      titleKey: 'chat.runError.title.regionNotSupported',
      messageKey: 'chat.runError.regionNotSupportedMessage',
    }
    : ui;
}

function resolveRunFailureUiByTables(
  code: string | null | undefined,
  detail: string | null | undefined,
  agentId: string | null | undefined,
  verdict?: RunFailureDaemonVerdict | null,
): RunFailureUi {
  // An ACP agent CLI that answered `initialize` and then refused to open a
  // session. Resolved before every other branch, and before the static
  // agent-agnostic table, because this code carries a prescription of its own
  // (change the CLI build, then retry) that the generic mappings would erase.
  // The daemon deliberately sends only the code plus the runtime identity as
  // data — a sentence composed there could never be translated (see
  // runtimes/acp-handshake-failure.ts).
  if (code === 'AGENT_CLI_SESSION_REFUSED') {
    return {
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.cliSessionRefused',
      messageKey: 'chat.runError.cliSessionRefusedMessage',
      secondaryRetry: false,
    };
  }
  // Agent-agnostic codes resolve first so every agent gets the specific
  // guidance instead of the generic fallback.
  const agnostic = typeof code === 'string' ? AGENT_AGNOSTIC_FAILURE_UI[code] : undefined;
  if (agnostic) return agnostic;
  // Engine-neutral failure_detail (timeout, empty output, stale resumed session,
  // missing Git Bash, model unavailable, client environment) resolves before
  // the agent branches so it applies to every agent.
  const agnosticDetail =
    typeof detail === 'string' ? AGENT_AGNOSTIC_DETAIL_FAILURE_UI[detail] : undefined;
  if (agnosticDetail) return agnosticDetail;
  // Antigravity's auth flow is terminal-only — see the
  // `launch-terminal-auth` action comment for why. Without this branch
  // the user sees the daemon-emitted guidance text and would have to
  // open a terminal themselves; with it they get a one-click button
  // that opens Terminal.app / x-terminal-emulator / cmd with `agy`
  // running, and a Retry button to redo the chat after OAuth completes.
  if (agentId === 'antigravity') {
    if (code === 'AGENT_AUTH_REQUIRED') {
      // 文案 S02:Antigravity 的登录只能在终端里做,但它**是**一个本地 agent
      // 没登录 —— 标题点名它自己。
      return failureCard(
        { directFix: 'launch-terminal-auth' },
        'chat.runError.title.signInRequired.other',
        'chat.runError.signInMessage.other',
        { secondaryRetry: true },
      );
    }
    // Quota: each Antigravity model has its own quota, so the action
    // is "open agy, switch model" rather than "sign in." Same handler
    // spawns the same terminal; only the label changes.
    if (code === 'RATE_LIMITED') {
      return failureCard(
        { directFix: 'launch-terminal-switch-model' },
        'chat.runError.title.rateLimited',
        null,
        { secondaryRetry: true },
      );
    }
  }
  // S05 · key 填错了 —— 只在这把 key 归我们保管时才认。不在这一档的 agent 返回
  // null,于是继续往下走它原本那条路(码是 AGENT_AUTH_REQUIRED / UNAUTHORIZED
  // 的落 S02)。
  if (detail === 'invalid_api_key') {
    const apiKeyCard = apiKeyInvalidCardFor(agentId);
    if (apiKeyCard) return apiKeyCard;
  }
  // Fine-grained daemon classification overrides a too-coarse code (e.g.
  // hard_quota vs a transient 429 both arriving as RATE_LIMITED). Placed after
  // the Antigravity agent branch so its bespoke quota/auth flows still win,
  // and before the generic code branches so it can correct them.
  const detailUi = typeof detail === 'string' ? DETAIL_FAILURE_UI[detail] : undefined;
  if (detailUi) return detailUi;
  // Agent-neutral: a mid-response connection drop (any agent) gets a clear,
  // localized "lost connection — retry" message instead of the raw SDK string.
  if (code === 'AGENT_CONNECTION_DROPPED') {
    return retryWithGuidance(
      'chat.runError.title.connectionDropped',
      'chat.connectionDropped',
    );
  }
  // 文案 S02 · 本地 agent 没登录 / 登录过期(除 antigravity 之外的任何 agent ——
  // 它在上面有自己的分支)。它的登录在用户自己的终端里,Open Design 替不了:
  // 标题「{agent} 尚未登录」点名是哪一个,正文给出下一步,主动作是重试(等他们
  // 本地登录完再跑一次)。
  if (code === 'AGENT_AUTH_REQUIRED' || code === 'UNAUTHORIZED') {
    return failureCard(
      { transient: true },
      'chat.runError.title.signInRequired.other',
      'chat.runError.signInMessage.other',
    );
  }
  // Non-antigravity rate limit / upstream outage: name the type and explain the
  // recovery (wait & retry / switch service).
  if (code === 'RATE_LIMITED') {
    return failureCard(
      { transient: true },
      'chat.runError.title.rateLimited',
      'chat.runError.rateLimitedMessage',
    );
  }
  if (code === 'UPSTREAM_UNAVAILABLE') {
    return failureCard(
      { transient: true },
      'chat.runError.title.upstreamUnavailable',
      'chat.runError.upstreamUnavailableMessage',
    );
  }
  // Nothing above claimed this failure — but two very different situations end
  // up here:
  //
  // (a) The daemon NAMED the cause and this table has no row for it. When its
  //     verdict is available it decides, because it read the run and this is a
  //     lookup table. Rung 3.
  //
  // (b) The daemon did not know either. Keep the retry — an unclassified
  //     failure really is usually a one-off.
  //
  // The `daemonNamedTheFailure` guard is load-bearing: the classifier's own
  // last-resort row carries `retryable: false` / `'none'` by DEFAULT, so
  // reading the verdict without this guard would strip the Retry from exactly
  // the case that is supposed to keep it.
  if (daemonNamedTheFailure(detail) && daemonSaysRetryIsFutile(verdict)) {
    return failureCard({}, 'chat.runError.title.generic', null);
  }
  // Copy comes from RUN_FAILURE_FALLBACK_MESSAGE_KEY at render time, not from
  // the upstream string, which travels out through the diagnostics export.
  return failureCard({ transient: true }, 'chat.runError.title.generic', null);
}
