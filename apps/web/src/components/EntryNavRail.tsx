// Entry nav rail — the left column of the entry shell.
//
// Destinations (首页 / 社区 / 项目 / 设计系统 / 插件 / 设置), the 最近浏览过
// disclosure under them, and a footer dock with the community links and the
// local identity row. The GitHub star chip and the update-ready rocket ride
// the tabs chrome's top-right actions host through `EntryTopRightCluster`,
// which the project route mounts on its own (see `WorkspaceTopRightAccountCluster`).
import { compareRecentProjects } from '../lib/project-order';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { GITHUB_STARS_FALLBACK_LABEL, formatStars, useGithubStars } from './useGithubStars';
import {
  RailRecentRow,
} from './entry-nav-rail/RailRecentRow';
import { ProjectDeleteConfirmDialog } from './project-actions/ProjectDeleteConfirmDialog';
import { useProjectDeleteFlow } from './project-actions/useProjectDeleteFlow';
import { useProjectDuplicateFlow } from './project-actions/useProjectDuplicateFlow';
import { acknowledgeProjectCompletion, useProjectRunStatuses } from '../hooks/useProjectRunStatuses';
import type { EntrySettingsSection } from './EntrySettingsMenu';
import type { Project } from '../types';
import { isRtlLocale, useI18n } from '../i18n';
import { communityForLocale } from '../lib/community-links';
import { FeishuIcon } from './chat/support-brand-icons';
import type { EntryHomeView } from '../router';
import type {
  AccountMenuClickProps,
  TrackingProjectCollectionPage,
  TrackingWorkspacePage,
} from '@open-design/contracts/analytics';
import { useAnalytics } from '../analytics/provider';
import { trackAccountMenuClick, trackEntryNavigationClick } from '../analytics/events';
import { entryViewToTracking } from '../analytics/workspace';
import { workspaceChromeActionsHost } from './entryRailBridge';

const REPO_URL = 'https://github.com/nexu-io/open-design';
const X_URL = 'https://x.com/OpenDesignHQ';
const CONTACT_EMAIL_URL = 'mailto:support@open-design.ai';
const externalLinkProps = { target: '_blank', rel: 'noreferrer noopener' } as const;

// The rail's destination ids are the entry-shell home views (kept in sync with
// the router so `navigate({ kind: 'home', view })` type-checks for every item).
export type EntryView = EntryHomeView;

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
  onNewProject: () => void;
  /** Opens the project search palette (blurred modal over all projects). */
  onOpenSearch?: () => void;
  newProjectDisabled?: boolean;
  /** When false the rail is collapsed (hidden off-canvas) on the entry view. */
  open: boolean;
  /** Open the app settings dialog (optionally on a specific section). */
  onOpenSettings?: (section?: EntrySettingsSection) => void;
  /**
   * The update-ready host (`UpdaterPopup`), which renders nothing until the
   * updater reports a downloaded, unopened installer. It is an independent
   * control in the top-right chrome cluster (`.entry-nav-rail__account-updater`).
   */
  updaterSlot?: ReactNode;
  /** Optional notice shown above the footer controls. */
  footerNotice?: ReactNode;
  /** Projects for the rail's 最近浏览过 section — the SAME catalog and the SAME
   *  order 全部项目's 最近浏览过 tab shows; EntryShell hands over the one it
   *  already feeds that grid, so the two can never drift. Empty (or absent)
   *  hides the section entirely. */
  recentProjects?: Project[];
  /** Row actions for the 最近项目 list's ⋮ menu (重命名 / 复制 / 删除). Omit one
   *  to drop its item. They are the SAME handlers the project cards drive their
   *  menu with, so an action from the rail lands in exactly one place. */
  onRenameRecentProject?: (id: string, name: string) => void;
  onDeleteRecentProject?: (id: string) => Promise<boolean | void> | boolean | void;
  onDuplicateRecentProject?: (id: string) => Promise<void> | void;
  /** Opens one of those projects. */
  onOpenRecentProject?: (id: string) => void | Promise<unknown>;
}

interface NavButtonProps {
  active?: boolean;
  ariaLabel: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  /** Rail items that own a popup surface expose the button so the surface can
   *  return focus here on close, and advertise the popup's kind + open state. */
  buttonRef?: Ref<HTMLButtonElement>;
  ariaHasPopup?: 'dialog' | 'menu';
  ariaExpanded?: boolean;
  children: ReactNode;
}

// No `data-tooltip` here: every nav item renders its label inline, so the
// rail's hover bubble (entry-layout.css) would only duplicate visible text.
// That bubble stays reserved for the rail's icon-only controls (updater).
function NavButton({
  active,
  ariaLabel,
  label,
  onClick,
  disabled,
  testId,
  buttonRef,
  ariaHasPopup,
  ariaExpanded,
  children,
}: NavButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`entry-nav-rail__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaHasPopup ? Boolean(ariaExpanded) : undefined}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <span className="entry-nav-rail__btn-icon" aria-hidden>{children}</span>
      <span className="entry-nav-rail__btn-label">{label}</span>
    </button>
  );
}

/** Remembers the section's open/closed state across launches, next to the
 *  rail's own `od.entry.railOpen`. A disclosure the user closed should stay
 *  closed — re-opening it on every boot is the whole reason to have the
 *  control. */
const RECENT_SECTION_STORAGE_KEY = 'od.entry.railRecentOpen';

/**
 * How many rows the 最近项目 list shows before it scrolls — 11 × 38px rows on a
 * desktop window (see `.entry-nav-rail__recent-list`). The head of the list
 * whose status is asked for before the scroll observer has reported.
 */
const RECENT_STATUS_HEAD_ROWS = 11;

function readStoredRecentOpen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    // Default OPEN: the section is new and a collapsed-by-default disclosure
    // reads as a missing feature.
    return window.localStorage.getItem(RECENT_SECTION_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/**
 * 最近浏览过 — a collapsible list of the projects the 全部项目 view's own
 * 最近浏览过 tab would show, sitting under 设置 in the rail (per product).
 *
 * It takes the catalog EntryShell already feeds that grid and shows the head of
 * it in the same order (most recently touched first), so the rail and the grid
 * can never disagree about what "recent" means. Rows open the project through
 * the same opener the grid uses.
 */
function RailRecentSection({
  projects,
  onOpen,
  onRename,
  onDelete,
  onDuplicate,
  analyticsPage,
  label,
}: {
  projects: Project[];
  onOpen?: (id: string) => void | Promise<unknown>;
  onRename?: (id: string, name: string) => void;
  onDelete?: (id: string) => Promise<boolean | void> | boolean | void;
  onDuplicate?: (id: string) => Promise<void> | void;
  analyticsPage: TrackingWorkspacePage;
  label: string;
}) {
  const [open, setOpen] = useState(readStoredRecentOpen);
  // The row actions report under the project-collection page the rail is
  // standing on; every other entry view files under Home, where the rail's
  // list is the recent-projects surface.
  const collectionPage: TrackingProjectCollectionPage =
    analyticsPage === 'drafts' || analyticsPage === 'all_projects' ? analyticsPage : 'home';
  // 删除 confirms through the shared project delete dialog (OPEND-2797) — one
  // component for the rail and the project cards.
  const deleteFlow = useProjectDeleteFlow({
    onDelete,
    analyticsPage: collectionPage,
  });
  const duplicateFlow = useProjectDuplicateFlow({
    onDuplicate,
    analyticsPage: collectionPage,
  });
  // Every recent project, newest first (OPEND-2757: the old 8-row cap hid the
  // rest from the rail entirely). The LIST scrolls past ~11 rows, not the rail
  // — see `.entry-nav-rail__recent-list` in entry-layout.css.
  const items = useMemo(
    () => [...projects].sort(compareRecentProjects),
    [projects],
  );
  // Run status for the rows' leading glyph — the same feed, with the same
  // display mapping (✓-spending included), that the workspace tab dropdown
  // reads, which is what keeps the two glyph columns telling one story about a
  // project (OPEND-2795).
  const recentListRef = useRef<HTMLUListElement>(null);
  // Keep the full catalog navigable, but poll only rows intersecting its
  // scrollport. The list's existing height cap bounds the status request set.
  // Visibility belongs to a particular catalog. An empty catalog removes the
  // list DOM without unmounting this component, so an observer callback cannot
  // be relied on to retire the previous catalog's IDs.
  const visibilityScope = JSON.stringify(items.map((project) => project.id).sort());
  const [visibleProjects, setVisibleProjects] = useState<{
    scope: string;
    ids: string[];
  } | null>(null);
  useEffect(() => {
    const list = recentListRef.current;
    if (!open || !list || typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      if (!active) return;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.projectId;
        if (!id) continue;
        if (entry.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
      const next = [...visible].sort();
      setVisibleProjects((prev) =>
        prev?.scope === visibilityScope
          && prev.ids.length === next.length
          && prev.ids.every((id, index) => id === next[index])
          ? prev
          : { scope: visibilityScope, ids: next });
    }, { root: list });
    for (const row of list.children) observer.observe(row);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [items, open, visibilityScope]);
  // Until the observer has spoken, ask for the head of the list — the rows the
  // cap shows on a desktop window — in the same commit that paints them
  // (OPEND-2762). The observer's first report lands a frame later, and waiting
  // for it is what left the rows a round trip ahead of their glyphs.
  const runStatusProjectIds = useMemo(
    () => visibleProjects?.scope === visibilityScope
      ? visibleProjects.ids
      : items.slice(0, RECENT_STATUS_HEAD_ROWS).map((project) => project.id),
    [visibleProjects, visibilityScope, items],
  );
  const runStatusByProjectId = useProjectRunStatuses(runStatusProjectIds, {
    enabled: open,
  });

  // Opening a project is what spends its ✓ (per product): the finished run on
  // screen is recorded as seen — in the shared feed, so the tab switcher drops
  // the mark in the same moment.
  const openProject = useCallback(
    (id: string) => {
      acknowledgeProjectCompletion(id);
      return onOpen?.(id);
    },
    [onOpen],
  );

  function toggle() {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      try {
        window.localStorage.setItem(RECENT_SECTION_STORAGE_KEY, String(next));
      } catch {
        // Private mode / storage disabled: the section still toggles, it just
        // forgets. Never let a storage failure swallow the interaction.
      }
      return next;
    });
  }

  // Nothing to list is not an empty state worth a row: a shell with no projects
  // yet should see the rail it had before this section existed.
  if (items.length === 0) return null;

  return (
    <div className="entry-nav-rail__recent">
      <button
        type="button"
        className="entry-nav-rail__recent-head"
        onClick={toggle}
        aria-expanded={open}
        data-testid="entry-nav-recent-toggle"
      >
        {/* Title first, chevron trailing (per product: 展开和收起的按钮在最右侧).
            DOM order follows the visual one rather than an `order` swap, so the
            reading order matches too. */}
        <span className="entry-nav-rail__recent-title">{label}</span>
        <span className="entry-nav-rail__recent-chevron" aria-hidden>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        </span>
      </button>
      {/* The canonical disclosure pair (index.css / composio.css): the outer
          grid animates 0fr → 1fr, the inner box carries the clip. `hidden` on
          the wrapper would skip the transition entirely. */}
      <div className={`accordion-collapsible${open ? ' open' : ''}`}>
        <div className="accordion-collapsible-inner">
          <ul ref={recentListRef} className="entry-nav-rail__recent-list">
            {items.map((project) => {
              return (
                <li key={project.id} data-project-id={project.id}>
                  <RailRecentRow
                    project={project}
                    runStatus={runStatusByProjectId.get(project.id)}
                    runId={project.status?.runId}
                    onOpen={openProject}
                    onRename={onRename}
                    onDuplicate={onDuplicate ? (target) => { void duplicateFlow.duplicate(target); } : undefined}
                    onDelete={onDelete ? deleteFlow.request : undefined}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      {deleteFlow.target ? (
        <ProjectDeleteConfirmDialog
          projectName={deleteFlow.target.name}
          pending={deleteFlow.pending}
          failed={deleteFlow.failed}
          onCancel={deleteFlow.cancel}
          onConfirm={() => void deleteFlow.commit()}
        />
      ) : null}
    </div>
  );
}

interface EntryTopRightClusterProps {
  /** Analytics page the cluster reports from: the entry views map through
   *  `entryViewToTracking`, the workspace mount reports 'project'. */
  page: TrackingWorkspacePage;
  /** Update-ready host; rides the cluster right after the GitHub chip. */
  updaterSlot?: ReactNode;
}

/**
 * Top-right chrome cluster: the GitHub star chip and the update-ready rocket —
 * one flex row riding the workbench top-right corner.
 *
 * Extracted from `EntryNavRail` so the WORKSPACE view (an open project tab)
 * can mount the same cluster in the same position even though the entry shell
 * — and its rail — is unmounted there. Exactly one instance is on screen at a
 * time: `EntryNavRail` renders it on the entry views, `App.tsx` (via
 * `WorkspaceTopRightAccountCluster`) on the project route — those routes are
 * mutually exclusive.
 */
export function EntryTopRightCluster({ page, updaterSlot }: EntryTopRightClusterProps) {
  const analytics = useAnalytics();
  const [chromeActionsHost, setChromeActionsHost] = useState<HTMLElement | null>(
    workspaceChromeActionsHost,
  );

  // On the initial App render the tabs chrome and this cluster are committed
  // in the same pass, so the host does not exist while this component renders.
  // A layout effect finds it after the DOM commit and moves the controls before
  // paint. Electron can then build its first draggable-region hit map with the
  // no-drag controls as real descendants of the drag header.
  useLayoutEffect(() => {
    // Isolated component harnesses do not mount the application chrome. Keep
    // those public component tests usable without re-creating the whole App;
    // the real shell always supplies the dedicated host above.
    setChromeActionsHost(workspaceChromeActionsHost() ?? document.body);
  }, []);

  const updaterSlotHostRef = useRef<HTMLDivElement | null>(null);
  const [updaterControlVisible, setUpdaterControlVisible] = useState(false);
  // ReactNode truthiness cannot tell whether UpdaterPopup rendered its control;
  // observe the stable host so the chrome follows actual rendered content.
  useLayoutEffect(() => {
    const host = updaterSlotHostRef.current;
    if (!host) {
      setUpdaterControlVisible(false);
      return;
    }
    const syncVisibility = () => setUpdaterControlVisible(host.hasChildNodes());
    syncVisibility();
    const observer = new MutationObserver(syncVisibility);
    observer.observe(host, { childList: true });
    return () => observer.disconnect();
  }, [chromeActionsHost, updaterSlot]);

  const githubStars = useGithubStars();
  const starsLabel = githubStars == null ? GITHUB_STARS_FALLBACK_LABEL : formatStars(githubStars);

  if (typeof document === 'undefined' || !chromeActionsHost) return null;

  return createPortal(
    <div className="entry-top-right-cluster">
      {/* GitHub star chip: its own option in the cluster (per product) — it
          used to live in the account menu's social row. */}
      <a
        className="entry-top-right-github"
        href={REPO_URL}
        {...externalLinkProps}
        aria-label={`GitHub · ${starsLabel} stars`}
        title={`GitHub · ${starsLabel} stars`}
        data-testid="entry-top-right-github"
        onClick={() =>
          trackAccountMenuClick(analytics.track, {
            page_name: page,
            area: 'account_menu',
            element: 'github',
          })}
      >
        {/* 15: the octocat only fills 81% of its 24-unit viewBox, so 15 puts
            the drawn glyph on the same ~12.5px height as its neighbours. */}
        <Icon name="github-filled" size={15} />
        <span>{starsLabel}</span>
      </a>
      {/* Update-ready rocket. The slot stays mounted so `:empty { display:
          none }` can remove it until an installer has downloaded. */}
      <div
        ref={updaterSlotHostRef}
        className={updaterControlVisible ? 'entry-nav-rail__account-updater' : undefined}
        data-testid={updaterControlVisible ? 'entry-nav-account-updater' : undefined}
      >
        {updaterSlot}
      </div>
    </div>,
    chromeActionsHost,
  );
}

/**
 * The project route's mount of the top-right cluster (GitHub chip + updater
 * rocket). Keeps the project-detail chrome on the same updater surface as Home.
 */
export function WorkspaceTopRightAccountCluster({
  updaterSlot,
}: {
  updaterSlot?: ReactNode;
}) {
  return <EntryTopRightCluster page="project" updaterSlot={updaterSlot} />;
}

/** X's own mark (inline SVG — it is not in the Remix set the Icon component
 *  draws from). Sized like its Discord / mail neighbours; the colour rides
 *  the link so hover moves all three together. */
function XMark({ size }: { size: number }) {
  return (
    <svg
      className="entry-nav-rail__menu-x"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M10.4883 14.651L15.25 21H22.25L14.3917 10.5223L20.9308 3H18.2808L13.1643 8.88578L8.75 3H1.75L9.26086 13.0145L2.31915 21H4.96917L10.4883 14.651ZM16.25 19L5.75 5H7.75L18.25 19H16.25Z" />
    </svg>
  );
}

/**
 * Community / contact links (Discord / X / mail), icon only (OPEND-3180),
 * stacked directly above the identity row in the rail's footer dock. The glyph
 * is all a sighted user sees — the name lives on `aria-label` and rides the
 * shared `.od-tooltip` layer on hover, so the icon still explains itself
 * without a label beside it. Analytics keeps reporting these under
 * `area: 'account_menu'` so the existing funnel stays comparable across the
 * move out of that menu.
 */
function RailSocialRow({ page }: { page: TrackingWorkspacePage }) {
  const { t, locale } = useI18n();
  const analytics = useAnalytics();
  // The rail sits on the leading edge, so tooltips open away from it —
  // right in LTR, left once RTL moves the whole rail to the right edge.
  // Without the flip the bubble would be clamped against the viewport
  // and land back on top of the icons it describes.
  const tooltipPlacement = isRtlLocale(locale) ? 'left' : 'right';
  // One string per link doubles as the accessible name and the hover
  // tooltip: the bubble is the only place the icons say what they do.
  const community = communityForLocale(locale);
  const communityLabel = t('entry.communityAria');
  const xLabel = t('entry.xAria');
  const mailLabel = t('entry.mailAria');
  const btnClass = 'entry-nav-rail__menu-social-btn od-tooltip';
  const hint = (label: string) => ({
    'data-tooltip': label,
    'data-tooltip-placement': tooltipPlacement,
  });
  const glyph = 16;

  function track(element: AccountMenuClickProps['element']) {
    trackAccountMenuClick(analytics.track, {
      page_name: page,
      area: 'account_menu',
      element,
    });
  }

  return (
    <div className="entry-nav-rail__menu-social" data-testid="entry-nav-rail-social">
      <a
        className={btnClass}
        href={community.href}
        {...externalLinkProps}
        aria-label={communityLabel}
        {...hint(communityLabel)}
        data-testid="entry-nav-rail-discord"
        data-community-platform={community.platform}
        onClick={() => track(community.platform)}
      >
        {community.platform === 'feishu'
          ? <FeishuIcon monochrome width={glyph} height={glyph} />
          : <Icon name="discord" size={glyph} />}
      </a>
      <a
        className={btnClass}
        href={X_URL}
        {...externalLinkProps}
        aria-label={xLabel}
        {...hint(xLabel)}
        onClick={() => track('twitter')}
      >
        <XMark size={glyph} />
      </a>
      <a
        className={btnClass}
        href={CONTACT_EMAIL_URL}
        aria-label={mailLabel}
        {...hint(mailLabel)}
        onClick={() => track('email')}
      >
        <Icon name="mail" size={glyph} />
      </a>
    </div>
  );
}

export function EntryNavRail({
  view,
  onViewChange,
  open,
  onOpenSettings,
  updaterSlot,
  footerNotice,
  recentProjects,
  onOpenRecentProject,
  onRenameRecentProject,
  onDeleteRecentProject,
  onDuplicateRecentProject,
}: Props) {
  const { t } = useI18n();
  const analytics = useAnalytics();
  const analyticsPage = entryViewToTracking(view);
  const communityLabel = t('pluginsHome.title');
  // #5517 renamed the rail's first item from 最近 (Recents) to 首页 (Home) —
  // the key keeps its historical name, the VALUE now reads Home in every
  // locale (polish round 2, ref 1db2d00c2).
  const homeLabel = t('entry.navRecents');
  const isHome = view === 'home';

  const selectView = (next: EntryView) => {
    trackEntryNavigationClick(analytics.track, {
      page_name: analyticsPage,
      area: 'entry_nav',
      element: 'nav_item',
      target: entryViewToTracking(next),
      entry_from: 'sidebar',
    });
    onViewChange(next);
  };

  const openSettings = () => {
    trackAccountMenuClick(analytics.track, {
      page_name: analyticsPage,
      area: 'account_menu',
      element: 'settings',
    });
    onOpenSettings?.();
  };

  // While collapsed the rail is visually hidden but its controls stay mounted;
  // mark it `inert` so they leave the tab order and pointer flow entirely.
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = railRef.current;
    if (!node) return;
    if (open) {
      node.removeAttribute('inert');
    } else {
      node.setAttribute('inert', '');
    }
  }, [open]);

  return (
    <nav
      ref={railRef}
      className={`entry-nav-rail${open ? ' is-open' : ''}`}
      aria-label={t('entry.primaryNavAria')}
      aria-hidden={open ? undefined : true}
    >
      <div className="entry-nav-rail__panel">
      <div className="entry-nav-rail__group">
        {/* No search row here (per product: 搜索和收起跟 home icon 一起放在顶部):
            the search button and the rail toggle sit in the chrome row above
            (WorkspaceTabsBar's `.workspace-tabs-rail-actions`), and reach
            EntryShell through window events (entryRailBridge). */}
        <NavButton
          active={isHome}
          ariaLabel={homeLabel}
          label={homeLabel}
          onClick={() => selectView('home')}
          testId="entry-nav-home"
        >
          <Icon name="home" size={16} />
        </NavButton>
        <NavButton
          active={view === 'community'}
          ariaLabel={communityLabel}
          label={communityLabel}
          onClick={() => selectView('community')}
          testId="entry-nav-community"
        >
          <Icon name="globe" size={16} />
        </NavButton>

        {/* The section wrapper draws the divider under 社区 and carries the
            collapse stagger. The name is historical — nothing in it is
            team-specific. */}
        <div className="entry-nav-rail__team-section">
          {/* 项目 is the ONE project destination (OPEND-3108): the whole local
              catalog, on the page the legacy `all-projects` deep link also opens. */}
          <NavButton
            active={view === 'drafts' || view === 'all-projects'}
            ariaLabel={t('entry.navDrafts')}
            label={t('workspaceSwitcher.draftsTooltip')}
            onClick={() => selectView('drafts')}
            testId="entry-nav-drafts"
          >
            <Icon name="file" size={16} />
          </NavButton>
          <NavButton
            active={view === 'design-systems'}
            ariaLabel={t('entry.navDesignSystems')}
            label={t('entry.navDesignSystems')}
            onClick={() => selectView('design-systems')}
            testId="entry-nav-design-systems"
          >
            <Icon name="palette" size={16} />
          </NavButton>
          <NavButton
            active={view === 'plugins'}
            ariaLabel={t('entry.navPlugins')}
            label={t('entry.navPlugins')}
            onClick={() => selectView('plugins')}
            testId="entry-nav-plugins"
          >
            <Icon name="puzzle" size={16} />
          </NavButton>
          {/* 设置 is a rail destination (product: 设置的按钮在插件下边), directly
              under 插件 and above 最近项目 (content, not a place to go). The
              testId `entry-settings-button` is the e2e contract and stays UNIQUE. */}
          <NavButton
            ariaLabel={t('entry.accountSettings')}
            label={t('entry.accountSettings')}
            onClick={openSettings}
            testId="entry-settings-button"
          >
            <Icon name="settings" size={16} />
          </NavButton>
          {/* 最近项目 sits under 设置 (per product) — the last thing in the
              destination list, because it is a list of CONTENT rather than a
              place to go. The row menu offers 重命名 / 复制 / 删除. */}
          <RailRecentSection
            projects={recentProjects ?? []}
            onOpen={onOpenRecentProject}
            onRename={onRenameRecentProject}
            onDelete={onDeleteRecentProject}
            onDuplicate={onDuplicateRecentProject}
            analyticsPage={analyticsPage}
            label={t('recentProjects.title')}
          />
        </div>
      </div>
      <div className="entry-nav-rail__footer">
        {footerNotice}
        {/* Local dock (OPEND-3140): social links above an identity row. The
            identity is the local mode itself (there is no account to name),
            and opening it lands in Settings, where the local CLI / BYOK
            configuration lives. It is the rail's last line. */}
        <div
          className="entry-nav-rail__account-dock entry-nav-rail__account-dock--local"
          data-testid="entry-nav-local-account-dock"
        >
          <RailSocialRow page={analyticsPage} />
          <div className="entry-nav-rail__account">
            <button
              type="button"
              className="entry-nav-rail__account-trigger"
              aria-label={t('entry.accountSettings')}
              title={t('entry.accountSettings')}
              data-testid="entry-nav-local-account"
              onClick={openSettings}
            >
              <span
                className="entry-nav-rail__account-avatar entry-nav-rail__account-avatar--local"
                aria-hidden
              >
                <Icon name="terminal" size={14} />
              </span>
              <span className="entry-nav-rail__account-name">{t('entry.localAccountName')}</span>
            </button>
          </div>
        </div>
      </div>
      </div>

      {/* Top-right chrome cluster: GitHub chip + update-ready rocket, mounted
          into the tabs chrome's no-drag actions host so Electron includes it
          in the first native hit map. Extracted so the project route can mount
          the same cluster without the rail (see `EntryTopRightCluster`). */}
      <EntryTopRightCluster page={analyticsPage} updaterSlot={updaterSlot} />
    </nav>
  );
}
