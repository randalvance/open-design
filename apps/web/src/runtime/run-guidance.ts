// Shared logic that maps a failed run's error code + agent into the failure
// UI: which contextual button the gray error card shows and whether to override
// the error text. Kept in its own module so ChatPane / ProjectView /
// AssistantMessage can import it without a circular dependency.
import {
  isModelWindowLimitFailure,
  readMembershipConcurrencyResetAt,
  readModelWindowResetAt,
} from '@open-design/contracts';
import type { RunFailureAction } from '@open-design/contracts';
import { byokApiKeyIsEditableInSettings } from '../utils/byokProvider';

// Primary action offered in the gray error card.
//   - retry:                       re-run with the current agent.
//   - launch-terminal-auth:        Antigravity-specific. agy's `-p`
//                                  print mode cannot complete Google
//                                  Sign-In on its own (no input field
//                                  for the auth code), so OD spawns a
//                                  system Terminal running `agy` and
//                                  the user finishes OAuth there.
//   - switch-model:                the selected model is gone/disabled, so a
//                                  retry reproduces the same answer. Opens the
//                                  model picker (Settings → Execution) instead
//                                  of offering a dead Retry. Design principle
//                                  4: a retry button only appears where a retry
//                                  can actually work.
//   - launch-terminal-switch-model: Antigravity-specific. agy has no
//                                  `--model` flag (upstream #35), so
//                                  switching to a model with available
//                                  quota means opening agy's TUI and
//                                  using its Switch Model picker. The
//                                  daemon spawns the same terminal as
//                                  launch-terminal-auth — the button
//                                  label is the only thing that changes.
//   - open-settings:               S30. The failure is in the user's own machine
//                                  or network path — a corporate proxy, a
//                                  rewritten TLS chain, an unreachable route, a
//                                  host policy, a broken local store. Nothing
//                                  upstream changes on a re-run, and the only
//                                  lever we own is the place those overrides are
//                                  entered: Settings → Local CLI → "Advanced:
//                                  proxy & custom paths", whose `configuredEnv`
//                                  outranks the inherited process env
//                                  (`apps/daemon/src/runtimes/env.ts`). Pairs
//                                  with `secondaryRetry: true` because the
//                                  upstream string this classifies on also
//                                  covers a genuine handshake flake — design
//                                  keeps 〔重试〕 on this card deliberately.
//   - contact-support:             ladder rung 3. Retrying is futile and we have
//                                  no other way out, so the always-present
//                                  secondary 〔Contact support〕 is promoted to
//                                  primary rather than leaving a dead-end card.
// Both terminal-launch actions pair with `secondaryRetry: true` so the
// user has a Retry button after the external step completes (OAuth /
// switching models happens out-of-band; we can't auto-retry from the
// daemon side).
export type RunFailurePrimaryAction =
  | 'retry'
  | 'switch-model'
  | 'open-settings'
  | 'launch-terminal-auth'
  | 'launch-terminal-switch-model'
  | 'contact-support';

// i18n keys for the gray-card text override (null = show the raw error).
// Keys ending in a value with `{agent}` are interpolated at render time via
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
  | 'chat.runError.modelWindowLimitMessage'
  | 'chat.runError.modelWindowLimitMessageNoTime'
  | 'chat.runError.membershipConcurrencyLimitMessage'
  | 'chat.runError.membershipConcurrencyLimitMessageNoTime'
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
 * Before this existed the card rendered `rawError` — the upstream string, in
 * English, sometimes a slab of stderr — straight onto the card face, which is
 * design principle 5 ("say it in plain words") inverted. The raw text is still
 * reachable, just not on the card: it is persisted on the assistant message's
 * error event and travels out through 〔Export logs〕 (`/api/diagnostics/export`),
 * which is where the engineering-facing copy belongs. (The card's own
 * collapsible diagnostic area was removed on 2026-08-27.)
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
 * This is deliberately NOT "hide the failure". The product principle is that
 * the UI shows the agent's behavior as it actually is: the card still appears,
 * still names the failure type, still carries 〔Contact support〕〔Export logs〕
 * and whatever recovery action the rung provides. What is withheld is the
 * TRANSPORT ENVELOPE — event ids, `sessionID`, `properties`, local ports and
 * filesystem paths — which describes our plumbing, not the user's task. The raw
 * text is not deleted either: it stays on the assistant message's persisted
 * error event and leaves through the diagnostics export.
 *
 * Why provenance and not a branch guard: the previous shape ended in a bare
 * `: rawError` tail, reached whenever the two guards in front of it did not
 * both hold. Every failure the mapping table does not claim — and there are
 * dozens — was one guard away from spilling. A lookup table can always be one
 * row short; this predicate cannot.
 *
 * The pane slot (`error`) is shared, which is why it needs a provenance flag of
 * its own: `setError(...)` fills it with copy this app wrote (a conversation
 * that would not load), while `setRunError(message, assistantId)` fills it with
 * a run's raw message. Only the former may be rendered verbatim, and the caller
 * distinguishes them by whether a source assistant id came with it.
 */
export function resolveRunErrorCardDescription(input: {
  /** The failure is being told by some other surface (reconnect row, upgrade card). */
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
   * is announcing it.
   *
   * It is the answer to "is there something to be silent ABOUT", which is a
   * different question from every source above ("do we have words for it").
   * When it holds and the three sources are all empty, the card still has to
   * appear: it is the only thing on screen carrying 〔Retry〕〔Export logs〕
   * 〔Contact support〕, and dropping it drops the whole recovery surface with
   * the explanation. The shell header's "run failed" line is written on the
   * assumption that this card is below it saying why.
   */
  turnEndedInTerminalFailure: boolean;
}): RunErrorCardDescription {
  if (input.handedToAnotherSurface) return { render: 'none' };
  if (input.mappedMessageKey) {
    return { render: 'mapped', messageKey: input.mappedMessageKey };
  }
  // An empty pane slot is not a source — it used to SHADOW the run's own detail
  // (being the higher-priority source) and take the card down with it, which is
  // the same silence this function now refuses everywhere else. Only a slot
  // with words in it decides anything.
  if (input.paneError) {
    return input.paneErrorCameFromARun
      ? { render: 'fallback' }
      : { render: 'app-text', text: input.paneError };
  }
  // Nothing in the pane slot, so the only text left is the run's own — raw by
  // definition, whether or not a `runFailureUi` was resolved for it.
  if (input.failedRunRawDetail) return { render: 'fallback' };
  // Nothing to say, but something to say it ABOUT: a terminal failure always
  // gets a card, so the turn keeps its explanation and its way out. Ordered
  // last so every handoff and every more precise source still wins.
  return input.turnEndedInTerminalFailure
    ? { render: 'fallback' }
    : { render: 'none' };
}

// i18n keys for the unified error card's TITLE (the "error type" line above the
// detail message). Frontend-only mapping from error code → human-readable type;
// the daemon does not yet emit a type name (the raw status label is just the
// word "error"). A full backend type ⇄ frontend pairing is a later effort.
export type RunFailureTitleKey =
  | 'chat.runError.title.authRequired'
  | 'chat.runError.title.balance'
  | 'chat.runError.title.connectionDropped'
  | 'chat.runError.title.signInRequired.other'
  | 'chat.runError.title.rateLimited'
  | 'chat.runError.title.modelWindowLimit'
  | 'chat.runError.title.membershipConcurrencyLimit'
  | 'chat.runError.title.cliMissing'
  | 'chat.runError.title.promptTooLarge'
  | 'chat.runError.title.modelUnavailable'
  // S13 · 「模型能力不支持」—— 和上面那格**不是**同一句话。文档 S13 表里
  // 「模型不存在」与「模型能力不支持」分列两行,S07 的「模型不可用」又是第三行;
  // 三句话不能共用一个键,否则谁改都盖到别人头上。
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
  // Override the gray error card's text (clearer than the raw upstream string).
  messageKey: RunFailureMessageKey;
  // Interpolation values for `messageKey`, for the cases whose copy names
  // something the daemon read off the failure (e.g. when a rolling model window
  // reopens). Absent for every message that is a fixed sentence.
  messageVars?: Record<string, string>;
  // A `{cause}` the copy names but that is itself localized, so it arrives as a
  // key and is translated next to `{agent}` at render time. Only S30 uses it.
  messageCauseKey?: RunFailureCauseKey;
  // Show a secondary plain "retry" button alongside the primary action (used
  // by the recharge case, where retry is manual after topping up).
  secondaryRetry: boolean;
  /**
   * Draw no error card. Existing run status and diagnostics remain intact.
   *
   * The browser↔daemon stream drop hands its card to the
   * reconnect line at the tail of the conversation (grid 82–84, S29), which is
   * already saying the same thing with the right button. Two blocks of UI for
   * one event, in two different wordings, is exactly what the design forbids.
   *
   * Missing Git Bash also sets this flag by product decision: the existing
   * failed-run status remains, with no replacement card or installation UI.
   */
  suppressCard?: boolean;
}

/**
 * The browser↔daemon SSE stream ran out of reconnect budget.
 *
 * Duplicated from `providers/daemon.ts`, where the same pair names the failure;
 * `run-error-ladder.test.ts` pins the two copies equal, since a silently
 * drifting copy is the failure mode of writing it twice.
 */
export const RECONNECT_OWNED_FAILURE_CODE = 'DAEMON_STREAM_DISCONNECTED';
const RECONNECT_OWNED_FAILURE_MESSAGE =
  'daemon stream disconnected before run completed';

/**
 * Is this failure the one the reconnect line already speaks for?
 *
 * Reads the same code-or-message pair as `ProjectView`'s
 * `hasGenericDisconnectFailureEvent`: rows persisted before the structured code
 * existed carry only the sentence, and they have to be recognized too or the
 * duplicate card comes back for exactly the users with the longest history.
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
 * The two window-limit message keys, narrowed away from `RunFailureMessageKey`
 * (which includes `null` for the cases that keep the raw upstream string) so
 * callers can hand the result straight to `t()` without a non-null assertion.
 */
export type ModelWindowLimitMessageKey =
  | 'chat.runError.modelWindowLimitMessage'
  | 'chat.runError.modelWindowLimitMessageNoTime';

/**
 * The copy a rolling model-window rejection should render, or null when the
 * text is some other failure.
 *
 * Two surfaces need this and they arrive from opposite directions: the chat
 * card already knows the daemon's `model_window_limit` classification and only
 * wants the instant, while the Home composer fails before a run exists and has
 * nothing but the raw upstream sentence. Sharing one reader keeps them from
 * disagreeing about what counts as a window limit.
 */
export function modelWindowLimitCopy(
  rawMessage: string | null | undefined,
): { messageKey: ModelWindowLimitMessageKey; retryAt?: string } | null {
  if (!isModelWindowLimitFailure(rawMessage)) return null;
  const parsed = readModelWindowResetAt(rawMessage);
  // Shape-valid but not a real instant (`2026-13-45T…`) counts as unreadable,
  // so the message key and the variable can never disagree about whether a
  // time exists — the card would otherwise render "Invalid Date".
  const retryAt = parsed && Number.isFinite(Date.parse(parsed)) ? parsed : null;
  return retryAt
    ? { messageKey: 'chat.runError.modelWindowLimitMessage', retryAt }
    // Promising a time we could not read is worse than not naming one.
    : { messageKey: 'chat.runError.modelWindowLimitMessageNoTime' };
}

/**
 * The instant a model window reopens, rendered for a reader in `locale`.
 *
 * The gateway reports UTC; a user waiting on a clock needs their own. Date and
 * time are both shown because the wait can cross midnight, and the year is left
 * off because a rolling window never reaches one.
 *
 * Returns the input untouched if it cannot be formatted, so the copy degrades
 * to a machine-readable instant rather than to a gap.
 */
export function formatModelWindowRetryAt(retryAt: string, locale: string): string {
  const parsed = new Date(retryAt);
  if (!Number.isFinite(parsed.getTime())) return retryAt;
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(parsed);
  } catch {
    return retryAt;
  }
}

/**
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
 * point: adding a new failure code means answering three questions, not picking
 * a CTA by hand and hoping it stays consistent with the sixteen picked before it.
 */
export interface RunFailureNature {
  /** Rung 1 — we have a one-click action that actually resolves this. */
  directFix?: RunFailureDirectFix;
  /** Rung 2 — running it again can plausibly succeed (possibly after the user does something). */
  transient?: boolean;
}

/**
 * The primary-button ladder, top-down; the first rung that matches wins.
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
 * the user do. Both are already computed at finalize time
 * (`apps/daemon/src/run-failure-classification.ts` → `retryable` /
 * `user_action`) and both are already on `GET /api/runs/:id`
 * (`ChatRunStatusResponse.failureAction`).
 *
 * ⚠️ They do NOT reach the card today. The chat reads its failure off the
 * persisted `status`/`error` event, and the streaming layer only stamps
 * `failureCategory` + `failureDetail` onto it. Carrying these two the same way
 * is a three-file change outside this module — the SSE `end` frame /
 * `PersistedAgentEvent` shape in contracts, `providers/daemon.ts`'s
 * `markErrorRunFailure`, and `runtime/chat-events.ts`'s
 * `appendErrorStatusEvent` — so this parameter is written to be inert until
 * they land, and correct the moment they do.
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
 * The two cases the fallback used to merge are separable in the data, and this
 * is the whole of the test: the classifier emits a specific `failure_detail`
 * when it recognised the cause, and the literal `'unknown'` when it did not
 * (the last `classification('unknown', 'unknown', …)` in
 * `run-failure-classification.ts`). An absent detail is an older daemon that
 * classified nothing at all, which is the same situation.
 *
 * What it does NOT settle is the button. Among the causes the daemon names but
 * this module has no row for there are both futile ones (`spawn_enoexec`,
 * `cli_version_incompatible`) and genuinely transient ones (`upstream_5xx`,
 * `provider_high_demand`), so "named" alone cannot demote a Retry without
 * taking it away from failures that deserve it. That call belongs to the
 * daemon's own verdict — see {@link RunFailureDaemonVerdict}.
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
 * Deliberately structural rather than typed against the event: the fields are
 * not on `PersistedAgentEvent` yet (see {@link RunFailureDaemonVerdict}), and
 * the same shape of defensive read is how `runFailureFieldsFromError` already
 * picks the classification off a surfaced error. Returns undefined when neither
 * field is present, so a caller passes nothing through rather than an object
 * that says "we asked and the answer was nothing".
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
 * 〔contact support〕 opens a conversation, not a recovery. Callers use this to
 * decide whether to offer the generic local-CLI escape hatch alongside.
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
  extra: Partial<
    Pick<RunFailureUi, 'secondaryRetry' | 'messageVars' | 'messageCauseKey'>
  > = {},
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

// Agent-agnostic failure codes that carry a clear root cause and a concrete
// fix, mapped the same way regardless of which agent produced them. The daemon
// already classifies these into failure_category / user_action
// (apps/daemon/src/run-failure-classification.ts); this is the user-facing half
// of that taxonomy — a human-readable type name plus a one-line instruction,
// with the raw upstream string preserved in the card's collapsible source area.
const AGENT_AGNOSTIC_FAILURE_UI: Record<string, RunFailureUi> = {
  // S23 · 跑完了但没生成文件。正文以前是 `null`,于是卡面落到兜底那一句
  // (「这次没能顺利完成。反复出现的话,把日志发给我们。」)—— 用户面对的是一次
  // **正常结束**的任务,兜底句却在说它失败了,而且什么都没解释。文档 S23 有终稿,
  // 补上。
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
  // Selected model is missing/disabled (user_action: switch_model). The daemon
  // already names the fix — offer it as the button instead of a Retry that is
  // guaranteed to fail the same way.
  // `AMR_MODEL_UNAVAILABLE` only exists on runs persisted before the hosted
  // agent was removed; they still have to render the right card.
  AMR_MODEL_UNAVAILABLE: switchModelWithGuidance(
    'chat.runError.title.modelUnavailable',
    'chat.runError.modelUnavailableMessage',
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
  // self-repair and a new run re-reads the same invalid definition, so the
  // button now matches what the copy has always said — talk to us.
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
  // engine failure: name the halted task and point at retrying the request
  // or starting a new one instead of showing the generic "task failed" card.
  STRATEGY_TASK_STATE_MISMATCH: retryWithGuidance(
    'chat.runError.title.strategyTaskHalted',
    'chat.runError.strategyTaskStateMismatchMessage',
  ),
  // The agent answered — completely, readably, and the reply is already on
  // screen — but the reply carried no usable Runtime State block, and the OD
  // Next clarification stage admits only `plan_ready` (which needs a Plan
  // Contract this reply never had), `blocked`, or `canceled`. So the turn
  // settles terminal-`blocked`.
  //
  // Refusing it is CORRECT and is not what these rows change. What they change
  // is what the user is told. Without a row here the failure fell through to
  // the generic fallback, whose `messageKey: null` renders
  // RUN_FAILURE_FALLBACK_MESSAGE_KEY — a blank "the task failed" — while the
  // user is looking at their submitted answers and a full prose plan. The one
  // sentence that actually described the failure lived only in the English
  // diagnostic text. That is design principle 5 inverted twice over: it
  // explains nothing, and it lets the user suspect their own answers.
  //
  // Ladder rung 2. The omission is intermittent — the same prompt re-run
  // usually emits the block — so Retry is the honest action, and
  // `retryWithGuidance` keeps exactly the button the fallback already gave.
  //
  // ⚠️ `docs/design/run-errors/error-ux-design.md` HAS NO CELL FOR THIS. The
  // nearest, S21, covers an empty / malformed / looping model response, which
  // this is not. The copy below is W41's draft for a cell product has yet to
  // write — replace the wording, not the routing, when they do.
  //
  // All four Runtime State issue codes (`strategies/od-next/protocol.ts:16-19`)
  // share the row: to the user they are one story — the reply came back without
  // the marker — and splitting them would only ask product for four wordings of
  // the same sentence.
  // The turn ran to the end and produced no openable file.
  //
  // Ladder rung 2. Distinct from the four Runtime State codes on purpose: to
  // the user those say "your reply went missing", and this one says "nothing
  // came out this round" — a different sentence, a different expectation, and
  // the only one of the two that is true when the project is empty. Since the
  // undeclared shape of this failure is now attributed here too
  // (`reattributeUndeclaredTurn`), it is the code a real empty-handed turn
  // lands on whether or not the agent wrote its machine block.
  //
  // Retry earns its place: the deliverable is missing because THIS turn wrote
  // nothing, and a re-run is exactly the thing that can write it. A turn whose
  // deliverable does exist never reaches a card at all — `providers/daemon.ts`
  // keeps it `succeeded` on `projectDeliverableValid`.
  //
  // ⚠️ Copy is engineering's, like the rows below it:
  // `docs/design/run-errors/error-ux-design.md` has no cell for it. S23 ("跑完
  // 没生成文件") is the nearest and is listed there as invisible in telemetry;
  // product should rewrite the wording, not the routing.
  od_next_canonical_deliverable_invalid: retryWithGuidance(
    'chat.runError.title.noDeliverable',
    'chat.runError.noDeliverableMessage',
  ),
  od_next_protocol_runtime_state_missing: agentReplyIncomplete(),
  od_next_protocol_runtime_state_duplicate: agentReplyIncomplete(),
  od_next_protocol_runtime_state_invalid_json: agentReplyIncomplete(),
  od_next_protocol_runtime_state_invalid_schema: agentReplyIncomplete(),
  // The user answered the clarification form, and the agent came back with
  // ANOTHER question instead of proceeding.
  //
  // DELIBERATELY NOT one of the four above, even though the daemon reaches this
  // code through the same block-less turn. To the user those are one story —
  // "the reply came back without its marker" — and this is a different one: "I
  // answered, and it is asking me again." Folding it into that row would tell
  // the user their reply went missing while a fresh question form sits on
  // screen in front of them.
  //
  // It is also NOT intermittent, which is why its copy must not promise that a
  // re-run fixes it. A task admits exactly ONE clarification round
  // (`coordinator.ts` beginStrategyClarification: "the task is not awaiting its
  // one allowed clarification answer"), and at `inputStage: 'clarification'`
  // the contract admits only `plan_ready` / `blocked` / `canceled`
  // ("Clarification cannot request another clarification round",
  // `contracts/src/plugins/strategy-v2.ts`). A properly DECLARED second
  // question is refused by the identical code, so nothing about this is a
  // dropped block.
  //
  // Retry still earns its place, for a different reason than rung 2's usual
  // one: Retry does not re-roll this turn, it opens a NEW task. `handleRetry`
  // sends no `strategyTaskExecutionId`, so `resolveClarificationContinuation`
  // returns `ordinary` and `createStrategyTaskExecution` starts a fresh chain
  // at `clarificationCount: 0` / `inputStage: 'request'` — where asking a
  // question is a legal outcome. The agent will likely ask again; that time it
  // renders as a normal round of questions instead of a failure card.
  //
  // ⚠️ `docs/design/run-errors/error-ux-design.md` HAS NO CELL FOR THIS either
  // — S01–S32 contain nothing about clarification or follow-up questions. The
  // copy is W41's draft; product should rewrite the wording, not the routing.
  od_next_clarification_repeated: retryWithGuidance(
    'chat.runError.title.clarificationRepeated',
    'chat.runError.clarificationRepeatedMessage',
  ),
};

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

// Failure causes keyed by the daemon's fine-grained `failure_detail`, for the
// cases where the coarse `error_code` alone is wrong or too vague. This layer
// can OVERRIDE a code mapping — e.g. `hard_quota` and a transient 429 share
// `error_code: RATE_LIMITED`, but only the transient one should offer Retry.
// Applied after Antigravity-specific handling (which owns its own quota/auth
// flow) and before the generic code branches.
const DETAIL_FAILURE_UI: Record<string, RunFailureUi> = {
  // Provider quota / billing hard-stop: retrying reproduces the failure and
  // topping it up isn't something we can do for the user.
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
 * S05 — a bad API key, recognised **only for a run whose key we store ourselves**.
 *
 * The detail alone is not the test: `authDetail()` reads the flattened stderr of
 * ANY agent, so a local CLI can report `invalid_api_key` as well, and its key
 * lives in the user's own terminal. Sending that user to Settings would show a
 * screen that cannot change that key, and would swallow the S02 "{agent} is not
 * signed in" card they should see. Other agents therefore get null and continue
 * down their normal path.
 *
 * The primary action goes to Settings → Execution, where the BYOK key field
 * renders — the same place the pre-send BYOK gate lands. No retry: until the key
 * changes a retry must produce the same result.
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
// codes, so without this the card would only show the raw stderr.
const AGENT_AGNOSTIC_DETAIL_FAILURE_UI: Record<string, RunFailureUi> = {
  stream_disconnected: retryWithGuidance(
    'chat.runError.title.connectionDropped',
    'chat.connectionDropped',
  ),
  // Hard wall-clock timeout for the run (daemon user_action: retry). A plain
  // retry — optionally with a smaller task — usually gets through.
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
  // Run terminated without producing any output (daemon user_action: retry);
  // usually transient, so name it and offer a straight retry.
  empty_output: retryWithGuidance(
    'chat.runError.title.emptyOutput',
    'chat.runError.emptyOutputMessage',
  ),
  // A resumed agent session id went stale; the daemon already cleared it so the
  // next run starts fresh (#3408). Name it as recoverable and offer Retry.
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
  // The agent binary needs a CPU instruction set (AVX2) this device doesn't have,
  // so it crashes on launch and retrying reproduces the crash. Show guidance copy
  // without a dead Retry button (ladder rung 3).
  cpu_unsupported: contactSupportOnly(
    'chat.runError.title.cpuUnsupported',
    'chat.runError.cpuUnsupportedMessage',
  ),
  // The bundled runtime cannot load on this Windows build (older than 10 1809 /
  // build 17763, Bun's floor). Deterministic like cpu_unsupported, so no Retry;
  // the copy names the OS version so the user updates Windows instead.
  // Rung 3 for the same reason as cpu_unsupported.
  os_unsupported: contactSupportOnly(
    'chat.runError.title.osUnsupported',
    'chat.runError.osUnsupportedMessage',
  ),
  // S19 · the agent exited and did not say why. Causes we CAN name resolve
  // earlier (cli missing, Git Bash, timeouts, stale session, CPU): these six are
  // the residue where the exit carries no reason. Ladder rung 2.
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
  // S10 · the service backing the agent failed at the protocol level and did not
  // come back. `fatal_rpc_error` is what the daemon writes when the ACP/JSON-RPC
  // channel to the agent reported a FATAL and the child closed. Why S10 and not
  // S19: S19's copy is "it didn't say why", and here it DID say, at the protocol
  // level, that the service side gave up.
  fatal_rpc_error: retryWithGuidance(
    'chat.runError.title.upstreamUnavailable',
    'chat.runError.upstreamUnavailableMessage',
  ),
  // S10 as well. The ACP/JSON-RPC path never emits `UPSTREAM_UNAVAILABLE`, so an
  // overloaded provider arrives here as the opaque code plus one of these two
  // details. Ladder rung 2: the wobble passes, so Retry is the honest button.
  //
  // `upstream_client_error` and `network_error` are deliberately NOT here: a 4xx
  // repeats identically and `network_error` means the endpoint was never reached,
  // so 「稍后再试通常就好」 would be a lie for both.
  upstream_5xx: retryWithGuidance(
    'chat.runError.title.upstreamUnavailable',
    'chat.runError.upstreamUnavailableMessage',
  ),
  provider_high_demand: retryWithGuidance(
    'chat.runError.title.upstreamUnavailable',
    'chat.runError.upstreamUnavailableMessage',
  ),
  // S18 · risk control suspended the account: contact support, no Retry.
  account_suspended: contactSupportOnly(
    'chat.runError.title.accountSuspended',
    'chat.runError.accountSuspendedMessage',
  ),
  // The `model_unavailable` family: the daemon reads the cause out of the
  // upstream sentence and rules the run `retryable: false` /
  // `user_action: 'switch_model'`. A BYOK agent's model problem arrives as the
  // opaque `AGENT_EXECUTION_FAILED` plus one of these details.
  //
  // Ladder rung 1, and NO retry: re-picking the model is the one act that changes
  // the outcome.
  //
  // `provider_routing_error` is deliberately NOT here: `upstreamDetail()` emits
  // the same string with `retryable: true`, and this module receives the detail
  // without the category, so one row would mis-card the upstream half.
  cli_version_incompatible: switchModelWithGuidance(
    'chat.runError.title.modelUnavailable',
    'chat.runError.modelUnavailableMessage',
  ),
  model_not_found: switchModelWithGuidance(
    'chat.runError.title.modelUnavailable',
    'chat.runError.modelUnavailableMessage',
  ),
  // S13 · 「模型能力不支持」 is a different sentence from S07's 「模型不可用」.
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
  //
  // Product-approved descriptions distinguish local/network causes from region restrictions.
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
//   - agent-agnostic root cause (cli missing, prompt too large, model
//     unavailable, tool loop, bad output, bad runtime def) → named type + fix
//   - agent-agnostic failure_detail (timeout, empty output, stale resumed
//     session) → named type + retry, for every agent
//   - missing Git Bash → retain failed-run status without an error card
//   - fine-grained failure_detail (hard quota, text-detected cli-missing)
//     → named type + fix, overriding a too-coarse code
//   - model/auth/quota error → plain retry + named copy
//   - generic failure → plain retry
export function resolveRunFailureUi(
  code: string | null | undefined,
  detail: string | null | undefined,
  agentId: string | null | undefined,
  rawMessage?: string | null,
  verdict?: RunFailureDaemonVerdict | null,
): RunFailureUi {
  const ui = resolveRunFailureUiFromTables(code, detail, agentId, rawMessage, verdict);
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

function resolveRunFailureUiFromTables(
  code: string | null | undefined,
  detail: string | null | undefined,
  agentId: string | null | undefined,
  rawMessage?: string | null,
  verdict?: RunFailureDaemonVerdict | null,
): RunFailureUi {
  // An ACP agent CLI that answered `initialize` and then refused to open a
  // session. Resolved before every other branch, and before the static
  // agent-agnostic table, because this code carries a prescription of its own
  // (change the CLI build, then retry) that the generic mappings would erase.
  // The daemon deliberately sends only the code plus the runtime identity as
  // data — a sentence composed there could never be translated (see
  // runtimes/acp-handshake-failure.ts).
  //
  // The copy names the installed build without quoting a version number. The
  // daemon does have a detected version, but reading the one THIS run started
  // with costs a pre-spawn probe on every launch, so naming it is deliberately
  // left to a follow-up rather than paid for on the failure path here.
  if (code === 'AGENT_CLI_SESSION_REFUSED') {
    return {
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.cliSessionRefused',
      messageKey: 'chat.runError.cliSessionRefusedMessage',
      secondaryRetry: false,
    };
  }
  // Agent-agnostic codes resolve first so an Antigravity run that hits one of them
  // still gets the specific guidance instead of the generic fallback.
  const agnostic = typeof code === 'string' ? AGENT_AGNOSTIC_FAILURE_UI[code] : undefined;
  if (agnostic) return agnostic;
  // A rolling per-model window resolves before every agent branch: the window is
  // the gateway's, not the agent's. The reset instant is read from the upstream
  // text through the shared contracts reader.
  if (detail === 'model_window_limit') {
    // The daemon already decided this IS a window limit, so read the instant
    // directly rather than re-deciding from the text — an upstream rewording
    // that the daemon still classified must not silently lose the card.
    const parsed = readModelWindowResetAt(rawMessage);
    const retryAt = parsed && Number.isFinite(Date.parse(parsed)) ? parsed : null;
    // The window rolls over on its own — as transient as a failure gets (rung 2).
    return failureCard(
      { transient: true },
      'chat.runError.title.modelWindowLimit',
      retryAt
        ? 'chat.runError.modelWindowLimitMessage'
        : 'chat.runError.modelWindowLimitMessageNoTime',
      retryAt ? { messageVars: { retryAt } } : {},
    );
  }
  // Membership concurrency is a temporary policy gate carried inside an ACP
  // fatal envelope. Keep the Retry button manual, name the wait explicitly,
  // and preserve the upstream reset instant when one is present.
  if (detail === 'membership_concurrency_limit') {
    const parsed = readMembershipConcurrencyResetAt(rawMessage);
    const retryAt = parsed && Number.isFinite(Date.parse(parsed)) ? parsed : null;
    return {
      primaryAction: 'retry',
      titleKey: 'chat.runError.title.membershipConcurrencyLimit',
      messageKey: retryAt
        ? 'chat.runError.membershipConcurrencyLimitMessage'
        : 'chat.runError.membershipConcurrencyLimitMessageNoTime',
      ...(retryAt ? { messageVars: { retryAt } } : {}),
      secondaryRetry: false,
    };
  }
  // Engine-neutral failure_detail (timeout, empty output, stale resumed session,
  // missing Git Bash) resolves before the agent branches so it applies to every
  // agent.
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
      // S02: Antigravity's login can only happen in a terminal.
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
  // S05 · a bad key, recognised only when we hold the key — see
  // `apiKeyInvalidCardFor`. Other agents continue down their normal path.
  if (detail === 'invalid_api_key') {
    const apiKeyCard = apiKeyInvalidCardFor(agentId);
    if (apiKeyCard) return apiKeyCard;
  }
  // Fine-grained daemon classification overrides a too-coarse code (e.g.
  // hard_quota vs a transient 429 both arriving as RATE_LIMITED). Placed after
  // the Antigravity branch so its bespoke quota/auth flow still wins, and before
  // the generic code branches so it can correct them.
  const detailUi = typeof detail === 'string' ? DETAIL_FAILURE_UI[detail] : undefined;
  if (detailUi) return detailUi;
  // Agent-neutral: a mid-response connection drop (any agent) gets a clear,
  // localized "lost connection — retry" message instead of the raw SDK string.
  // localized "lost connection — retry" message instead of the raw SDK string.
  if (code === 'AGENT_CONNECTION_DROPPED') {
    return retryWithGuidance(
      'chat.runError.title.connectionDropped',
      'chat.connectionDropped',
    );
  }
  // S02 · a local agent is not signed in, or its login expired. Its login lives in
  // the user's own terminal, which Open Design cannot do for them: the title names
  // the agent, the copy gives the next step, and the action is to retry.
  if (code === 'AGENT_AUTH_REQUIRED' || code === 'UNAUTHORIZED') {
    return failureCard(
      { transient: true },
      'chat.runError.title.signInRequired.other',
      'chat.runError.signInMessage.other',
    );
  }
  // Non-Antigravity rate limit / upstream outage: name the type and explain the
  // recovery. Antigravity's own RATE_LIMITED was handled above.
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
  // up here, and until now they shared one answer.
  //
  // (a) The daemon NAMED the cause and this table has no row for it. The old
  //     comment here read "Nothing named this failure", which was simply untrue
  //     of `certificate_failure` and forty-odd siblings: the daemon named them,
  //     ruled them non-retryable, and web handed out a Retry anyway. When its
  //     verdict is available it decides, because it read the run and this is a
  //     lookup table. Rung 3.
  //
  // (b) The daemon did not know either. Keep the retry — an unclassified
  //     failure really is usually a one-off.
  //
  // The `daemonNamedTheFailure` guard is load-bearing, not decoration: the
  // classifier's own last-resort row is `classification('unknown', 'unknown',
  // 'finalize', retryableHint ?? false, retryableHint ? 'retry' : 'none')`, so
  // a plain unknown failure carries `retryable: false` / `'none'` by DEFAULT.
  // Reading the verdict without this guard would therefore strip the Retry from
  // exactly the case that is supposed to keep it.
  if (daemonNamedTheFailure(detail) && daemonSaysRetryIsFutile(verdict)) {
    return failureCard({}, 'chat.runError.title.generic', null);
  }
  // Copy comes from RUN_FAILURE_FALLBACK_MESSAGE_KEY at render time, not from
  // the upstream string, which stays in the collapsible diagnostic area.
  return failureCard({ transient: true }, 'chat.runError.title.generic', null);
}
