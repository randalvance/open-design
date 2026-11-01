import type { PreviewAnnotationStyle, PreviewCommentAnchorState, PreviewCommentAttachment, PreviewCommentMember, PreviewCommentPosition, PreviewCommentSelectionKind, PreviewCommentStatus } from './comments.js';

/**
 * The comment sync unit — a faithful serialization of the daemon's local
 * `preview_comments` row (see {@link PreviewComment}) so a pulled comment
 * reinserts locally without a parallel model. The anchoring payload
 * (`selector`/`label`/`position`/`htmlHint`/`selectionKind`/`podMembers`/
 * `slideIndex`) plus the drift-ladder fields (`anchorState`/`anchoredVersion`/
 * `lastGoodPosition`) ride along so a synced comment keeps pointing at the same
 * element on the receiver. The stream carries the comment's full lifecycle: a
 * create/edit is pushed with the current `updatedAt`, and a delete is pushed as
 * a tombstone (`deleted: true`) that removes the comment by `id` on every
 * receiver. Receivers order revisions of one comment by the cloud `seq` (a
 * replayed `seq` never overwrites a later one); `updatedAt` is the business
 * last-writer-wins check for a revision the receiver has not seen yet.
 */
export interface CollabCloudComment {
  /** Server-admitted immutable creator file lifetime, not a permission. */
  sourceFileId?: string;
  sourceFilePath?: string;
  /**
   * The author daemon's local comment id — the GLOBAL dedup key. A receiver
   * merges idempotently by this id, so a member's own comment pulled back is a
   * no-op and re-pulls never double-insert.
   */
  id: string;
  projectId: string;
  /**
   * The author's local conversation id the comment was filed under.
   * Informational on the wire: a receiver re-homes the comment onto one of its
   * OWN local conversations for the project (conversation ids do not cross
   * daemons), so this is not used as a foreign key on merge.
   */
  conversationId: string;
  /**
   * The AUTHOR's workspaceMemberId — who WROTE this comment, not whoever is
   * currently viewing it. The client resolves it against the member directory
   * to render the author's name + role on the card. Mirrors
   * {@link PreviewComment.authorMemberId}.
   */
  memberId: string;
  /**
   * Cloud-assigned monotonic sequence within a project's comment stream — the
   * pull cursor. Clients ignore it on push (send 0); the cloud assigns the real
   * value and returns it.
   */
  seq: number;
  note: string;
  filePath: string;
  /** Server-asserted alias identity for public-file relays; clients do not supply it. */
  publicationSlug?: string;
  elementId: string;
  selector: string;
  label: string;
  text: string;
  htmlHint: string;
  position: PreviewCommentPosition;
  style?: PreviewAnnotationStyle;
  selectionKind?: PreviewCommentSelectionKind;
  memberCount?: number;
  podMembers?: PreviewCommentMember[];
  slideIndex?: number;
  attachments?: PreviewCommentAttachment[];
  status: PreviewCommentStatus;
  /** Drift-ladder anchor state (see {@link PreviewCommentAnchorState}). */
  anchorState?: PreviewCommentAnchorState;
  /** Content version the comment was anchored to (drives the "based on older vN" badge). */
  anchoredVersion?: number;
  /** Last known-good bbox for the `lost` ghost pin. */
  lastGoodPosition?: PreviewCommentPosition;
  /** Original epoch milliseconds, or 0 when a legacy record's creation time is unknown.
   * Receivers must not replace missing/unknown time with their synchronization clock. */
  createdAt: number;
  updatedAt: number;
  /**
   * Tombstone marker. When `true`, this record is a delete: receivers remove the
   * comment with this `id` from their local store (delete wins regardless of
   * `updatedAt`). The remaining fields may be a best-effort snapshot of the
   * comment as it last existed and should not be re-materialized.
   */
  deleted?: boolean;
  /**
   * Which identity the author holds — see `ShareAuthorKind`. Absent means
   * `member`, which is what every comment written before the share page
   * existed is.
   *
   * ## Why this had to widen before anything else
   *
   * This interface is the WIRE between daemons of different versions. A daemon
   * that does not know a field drops it on receive, and `mergeSyncedComment`'s
   * update path does not rewrite authorship afterwards — so a comment that
   * round-trips through an older daemon loses these fields permanently, with
   * nothing to recover them from. Widening the wire first is what keeps that
   * from happening; the fields can then be populated at leisure.
   *
   * All three are optional for the same reason: an older daemon sends none of
   * them and must keep working.
   */
  authorKind?: 'member' | 'user';
  /**
   * The author's account id when `authorKind` is `user`. Carried alongside
   * `memberId` rather than replacing it: `memberId` stays required so an older
   * daemon still has something to render.
   */
  authorAppUserId?: string;
  /**
   * Server-stamped display name for the author.
   *
   * It travels WITH the comment on purpose. The alternative — resolving the
   * name from the team member directory at render time — would mean the share
   * page needs to read that directory, and the directory exposes real names
   * and roles. Sending the name with the comment keeps the two as separate
   * channels, so showing an author's name never requires opening the roster.
   */
  authorDisplayName?: string;
  /**
   * Avatar colour seed, keyed on the ACCOUNT rather than the membership so one
   * person is one colour whether they commented from the client or the share
   * page. Display only — never an identity assertion, and never the basis for
   * deciding whether a comment belongs to the viewer.
   */
  authorKey?: string;
}

