import { reportProjectFailure } from '../observability/experience-diagnostics';
// Horizontal "Recent projects" rail for the Home view.
//
// Mirrors the strip Lovart shows under its hero: a small set of
// recent project cards with a "View all" link that switches to the
// full Projects view. We keep the data shape narrow (Project[] +
// onOpen / onViewAll) so the strip can be reused later by other
// surfaces (e.g. an in-project quick-switcher pane).

import type { CSSProperties } from 'react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from '@open-design/components';

import { useT } from '../i18n';
import {
  fetchProjectFiles,
  invalidateProjectFilesCache,
} from '../providers/registry';
import type { DesignSystemSummary, Project } from '../types';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { RemixIcon } from './RemixIcon';
import { ProjectDeleteConfirmDialog } from './project-actions/ProjectDeleteConfirmDialog';
import { useProjectDeleteFlow } from './project-actions/useProjectDeleteFlow';
import { useProjectDuplicateFlow } from './project-actions/useProjectDuplicateFlow';
import { isDesignSystemProject } from './design-system-project';
import {
  THUMBNAIL_OVERSCAN_MARGIN,
  resumeThumbnailLoads,
  suspendThumbnailLoads,
  useThumbnailLoadSlot,
} from '../lib/thumbnail-load-gate';
import {
  getProjectCoverSnapshot,
  projectCoverSnapshotKey,
  setProjectCoverSnapshot,
} from '../lib/project-cover-cache';
import {
  DECK_PREVIEW_HEIGHT,
  DECK_PREVIEW_WIDTH,
  getCachedDeckCover,
  loadDeckCover,
  resolveProjectCover,
} from '../lib/project-cover-pipeline';
// The deck cover parser moved to the pipeline with the rest of the cover
// decision; re-exported so its existing importers keep resolving.
export { deckPreviewSrcDoc } from '../lib/project-cover-pipeline';
import { useInView } from './plugins-home/useInView';
import { mutedMotionCoverUrl } from '../lib/muted-motion-cover-url';
import { useAnalytics } from '../analytics/provider';
import {
  trackProjectCollectionClick,
  trackWorkspaceProjectActionResult,
} from '../analytics/events';
import { countBucket } from '../analytics/workspace';
import type { ProjectCollectionClickProps } from '@open-design/contracts/analytics';

/** Which project space this strip renders: 'recent' = the home strip,
 *  'drafts' = the full 全部项目 grid. */
export type SpaceKind = 'recent' | 'drafts';
import { projectCoverUrl, type ProjectCoverOverride } from './project-cover';

interface Props {
  projects: Project[];
  /** Retained for existing callers; the collection card no longer renders a publishing badge. */
  designSystems?: DesignSystemSummary[];
  /** Retained for call-site compatibility; the strip skips rendering
   *  while the list is loading so we never need a loading state. */
  loading?: boolean;
  /** Full-page project grids render their own title + controls. The Home strip
   *  omits this and keeps the compact "最近项目 / 查看全部" header. */
  heading?: string;
  description?: string;
  /** Return false when opening failed and the grid stayed mounted, so aborted
   * background cover work can resume after the foreground attempt finishes. */
  onOpen: (id: string) => boolean | void | Promise<boolean | void>;
  onViewAll?: () => void;
  onDelete?: (id: string) => Promise<boolean | void> | boolean | void;
  onDuplicate?: (id: string) => Promise<void> | void;
  onRename?: (id: string, name: string) => void;
  limit?: number;
  /** Which space this strip renders (see {@link SpaceKind}). Defaults to
   *  'recent' (home). */
  space?: SpaceKind;
  /** Whether this mounted strip is visible. EntryShell keeps Home mounted while
   * other views are active, so hidden strips must not occupy browser connection
   * slots with background cover probes. */
  isActive?: boolean;
}

/** The chip a design-system project wears on its card. Product name, not a
 *  translated string. The type filter names the same type through the
 *  localized `dsManager.tabDesignSystem` noun (设计体系), per OPEND-3107. */
const DESIGN_SYSTEM_TAG_LABEL = 'Design System';

type DictKey = Parameters<ReturnType<typeof useT>>[0];

/** The type filter lists every creation type on its own (OPEND-3107, 2026-09-16
 *  定稿), resolved per project by {@link projectKindFilterCategory} from the
 *  creation metadata the Home chips stamp — so a project files under the type
 *  the user picked to create it, not under the storage kind it happens to use
 *  (a HyperFrames project is stored as a video, a WebGL one as a prototype). */
type ProjectKindFilter = 'all' | ProjectKindFilterCategory;
type ProjectSort = 'updatedDesc' | 'updatedAsc' | 'nameAsc';

type KindFilterOption =
  | { id: ProjectKindFilter; labelKey: DictKey; label?: undefined }
  | { id: ProjectKindFilter; label: string; labelKey?: undefined };

// The twelve entries, in the order product specified (OPEND-3107, 2026-09-16):
// 任何类型、原型、幻灯片、文档、图片、HyperFrames、网站克隆、视频、音频、实时产物、
// WebGL、设计体系. Every creation type reuses the Home type chip's own label key
// (home-hero/chip-labels.ts) so the filter names a type exactly the way the
// user picked it; Design system is the same noun the project page's type
// label uses. Media (the merged video / audio bucket) is gone: video, audio
// and HyperFrames are listed on their own.
const KIND_FILTER_OPTIONS: KindFilterOption[] = [
  { id: 'all', labelKey: 'recentProjects.kindAll' },
  { id: 'prototype', labelKey: 'homeHero.chip.prototype' },
  { id: 'slide', labelKey: 'homeHero.chip.deck' },
  { id: 'document', labelKey: 'homeHero.chip.document' },
  { id: 'image', labelKey: 'homeHero.chip.image' },
  { id: 'hyperframes', labelKey: 'homeHero.chip.hyperframes' },
  { id: 'web-clone', labelKey: 'homeHero.chip.webClone' },
  { id: 'video', labelKey: 'homeHero.chip.video' },
  { id: 'audio', labelKey: 'homeHero.chip.audio' },
  { id: 'live-artifact', labelKey: 'homeHero.chip.liveArtifact' },
  { id: 'webgl', labelKey: 'homeHero.chip.webgl' },
  { id: 'design-system', labelKey: 'dsManager.tabDesignSystem' },
];

function kindFilterLabel(option: KindFilterOption, t: ReturnType<typeof useT>): string {
  return option.labelKey === undefined ? option.label : t(option.labelKey);
}

const SORT_OPTIONS: Array<{ id: ProjectSort; labelKey: Parameters<ReturnType<typeof useT>>[0] }> = [
  { id: 'updatedDesc', labelKey: 'recentProjects.sortNewest' },
  { id: 'updatedAsc', labelKey: 'recentProjects.sortOldest' },
  { id: 'nameAsc', labelKey: 'recentProjects.sortName' },
];

const VIEW_OPTIONS: Array<{ id: 'grid' | 'list'; labelKey: DictKey }> = [
  { id: 'grid', labelKey: 'designs.viewGrid' },
  { id: 'list', labelKey: 'recentProjects.viewList' },
];


const DEFAULT_RECENT_PROJECT_LIMIT = 6;
const WIDE_RECENT_PROJECT_LIMIT = 7;
const PROJECT_MENU_GAP = 6;
const PROJECT_MENU_VIEWPORT_MARGIN = 24;
// Card covers are background decoration. Browsers commonly allow only six
// concurrent connections per origin, so an unbounded All Projects scan can
// occupy every slot and queue the project file list/preview the user just
// opened. Two cover probes keep the grid moving while reserving capacity for
// foreground reads.
const MAX_BACKGROUND_COVER_REQUESTS = 2;
// 7 * 180px cards + 6 * 12px gaps, matching recent-projects.css.
const WIDE_RECENT_PROJECT_MIN_ROW_WIDTH = 1332;

type BackgroundTask<T> = {
  controller: AbortController;
  run: () => Promise<T>;
  resolve: (value: T | undefined) => void;
  reject: (reason: unknown) => void;
  started: boolean;
  released: boolean;
  settled: boolean;
};

class BackgroundTaskQueue {
  private active = 0;
  private readonly pending: BackgroundTask<unknown>[] = [];
  private pauseDepth = 0;

  constructor(private readonly concurrency: number) {}

  schedule<T>(
    controller: AbortController,
    run: () => Promise<T>,
    priority = false,
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      const task: BackgroundTask<T> = {
        controller,
        run,
        resolve,
        reject,
        started: false,
        released: false,
        settled: false,
      };
      const abort = () => {
        if (task.settled) return;
        task.settled = true;
        task.resolve(undefined);
        this.release(task);
        this.drain();
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      // Store listener cleanup on the promise path without expanding the
      // queue's public contract. A settled task's one-shot abort listener is
      // harmless, but removing it avoids retaining component closures.
      task.run = async () => {
        try {
          return await run();
        } finally {
          controller.signal.removeEventListener('abort', abort);
        }
      };
      if (priority) {
        this.pending.unshift(task as BackgroundTask<unknown>);
      } else {
        this.pending.push(task as BackgroundTask<unknown>);
      }
      this.drain();
    });
  }

  withoutDraining(run: () => void): void {
    this.pauseDepth += 1;
    try {
      run();
    } finally {
      this.pauseDepth -= 1;
      this.drain();
    }
  }

  private release<T>(task: BackgroundTask<T>): void {
    if (task.started && !task.released) {
      task.released = true;
      this.active -= 1;
      return;
    }
    if (!task.started) {
      const index = this.pending.indexOf(task as BackgroundTask<unknown>);
      if (index >= 0) this.pending.splice(index, 1);
    }
  }

  private drain(): void {
    if (this.pauseDepth > 0) return;
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()!;
      if (task.settled || task.controller.signal.aborted) continue;
      task.started = true;
      this.active += 1;
      void task.run().then(
        (value) => {
          if (task.settled) return;
          task.settled = true;
          task.resolve(value);
          this.release(task);
          this.drain();
        },
        (error) => {
          if (task.settled) return;
          task.settled = true;
          task.reject(error);
          this.release(task);
          this.drain();
        },
      );
    }
  }
}

export function RecentProjectsStrip({
  projects,
  heading,
  description,
  onOpen,
  onViewAll,
  onDelete,
  onDuplicate,
  onRename,
  limit,
  space = 'recent',
  isActive = true,
}: Props) {
  const t = useT();
  const analytics = useAnalytics();
  const analyticsPage = space === 'drafts' ? 'drafts' : 'home';
  const rowRef = useRef<HTMLDivElement | null>(null);
  function trackCollection(
    element: ProjectCollectionClickProps['element'],
    properties: Partial<Omit<ProjectCollectionClickProps, 'page_name' | 'area' | 'element'>> = {},
    requestId?: string,
  ) {
    trackProjectCollectionClick(analytics.track, {
      page_name: analyticsPage,
      area: 'project_collection',
      element,
      ...properties,
    }, requestId ? { requestId } : undefined);
  }
  const [responsiveLimit, setResponsiveLimit] = useState(DEFAULT_RECENT_PROJECT_LIMIT);
  const resolvedLimit = limit ?? responsiveLimit;
  const hasRecentProjects = projects.length > 0;
  const fullPageGrid = heading !== undefined || description !== undefined || space !== 'recent';
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [kindFilter, setKindFilter] = useState<ProjectKindFilter>('all');
  const [sort, setSort] = useState<ProjectSort>('updatedDesc');
  // recvqbipG9QDTt: this component mounts once per host view (Home, Drafts,
  // All projects) and stays alive across EntryShell tab switches — Home's
  // instance in particular is only ever hidden via `content-visibility`, not
  // unmounted (see EntryShell's `inactiveViewProps`) — so a filter picked
  // here keeps narrowing the grid on every later visit. The cue is the
  // filter trigger itself, which prints the picked value (Image rather than
  // Any type); resetting goes back through that menu. OPEND-3107 keeps the
  // row at the Demo's three controls, so there is no separate clear chip.
  const [openHeaderMenu, setOpenHeaderMenu] = useState<
    'kind' | 'display' | null
  >(null);
  const displayTriggerRef = useRef<HTMLButtonElement>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(() => new Set());
  // Batch delete always confirms (it is irreversible and spans N projects),
  // mirroring the projects grid's own batch delete.
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  useEffect(() => {
    if (limit !== undefined) return;

    const update = () => {
      const rowWidth = rowRef.current?.getBoundingClientRect().width;
      if (rowWidth === undefined) {
        setResponsiveLimit(DEFAULT_RECENT_PROJECT_LIMIT);
        return;
      }
      setResponsiveLimit(
        rowWidth >= WIDE_RECENT_PROJECT_MIN_ROW_WIDTH
          ? WIDE_RECENT_PROJECT_LIMIT
          : DEFAULT_RECENT_PROJECT_LIMIT,
      );
    };

    update();
    const node = rowRef.current;
    if (node && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(update);
      observer.observe(node);
      return () => observer.disconnect();
    }

    if (typeof window === 'undefined') return;

    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [hasRecentProjects, limit]);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => {
      if (sort === 'updatedAsc') return a.updatedAt - b.updatedAt;
      if (sort === 'nameAsc') return a.name.localeCompare(b.name);
      return b.updatedAt - a.updatedAt;
    }),
    [projects, sort],
  );
  const [coverByProject, setCoverByProject] = useState<
    Record<string, ProjectCoverOverride | null>
  >({});
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<'down' | 'up'>('down');
  const [renameTarget, setRenameTarget] = useState<{ id: string; original: string } | null>(null);
  const [renameInput, setRenameInput] = useState('');
  // Delete confirm → request → settle, shared with the rail's 最近项目 rows
  // (OPEND-2797) so both entry points open the very same dialog. A failed
  // request keeps that dialog open with a visible reason (recvqbh189zBY6).
  const deleteFlow = useProjectDeleteFlow({ onDelete, analyticsPage });
  const duplicateFlow = useProjectDuplicateFlow({ onDuplicate, analyticsPage });
  // The card's "{creator}创建" line. Every local project belongs to the one
  // local user, so the line always names them.
  const creator = useMemo(() => {
    const name = t('recentProjects.selfCreator');
    return { name, initial: Array.from(name.trim())[0]?.toUpperCase() ?? 'M' };
  }, [t]);
  const visibleProjects = useMemo(
    () => sortedProjects
      .filter((project) => kindFilter === 'all' || projectKindFilterCategory(project) === kindFilter)
      .map((project) => ({ project }))
      .slice(0, resolvedLimit),
    [kindFilter, resolvedLimit, sortedProjects],
  );

  useEffect(() => {
    for (const { project } of visibleProjects) reportProjectFailure(project, 'recent_projects');
  }, [visibleProjects]);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameTitleId = useId();
  const bulkDeleteTitleId = useId();
  const actionsAvailable = Boolean(onDelete || onDuplicate || onRename);

  // Bulk-action state for the 多选 bar. Delete is the batch form of an action
  // the per-card ⋯ menu already offers; nothing new is exposed here that a
  // single card cannot do.
  const selectedProjects = visibleProjects.filter(({ project }) => selectedProjectIds.has(project.id));
  const selectedCount = selectedProjectIds.size;
  const bulkMutationDisabled = selectedCount === 0;
  const bulkMutationTitle =
    selectedProjects.map(({ project }) => project.name).join('、') || undefined;

  useEffect(() => {
    setSelectedProjectIds((current) => {
      if (current.size === 0) return current;
      const visibleIds = new Set(visibleProjects.map(({ project }) => project.id));
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleProjects]);

  useEffect(() => {
    if (!menuOpenId) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && menuContainerRef.current?.contains(target)) return;
      setMenuOpenId(null);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [menuOpenId]);

  useLayoutEffect(() => {
    if (!menuOpenId) return;
    const anchor = menuContainerRef.current;
    const menu = menuRef.current;
    const trigger = anchor?.querySelector<HTMLElement>('.recent-projects__card-more');
    if (!anchor || !menu || !trigger) return;

    const measureMenuPlacement = () => {
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 720;
      const scrollBoundary = anchor.closest<HTMLElement>('.entry-main--scroll');
      const scrollRect = scrollBoundary?.getBoundingClientRect();
      const visibleTop = Math.max(0, scrollRect?.top ?? 0);
      const visibleBottom = Math.min(viewportHeight, scrollRect?.bottom ?? viewportHeight);
      const triggerRect = trigger.getBoundingClientRect();
      const menuHeight = menu.getBoundingClientRect().height;
      const spaceBelow =
        visibleBottom - triggerRect.bottom - PROJECT_MENU_GAP - PROJECT_MENU_VIEWPORT_MARGIN;
      const spaceAbove =
        triggerRect.top - visibleTop - PROJECT_MENU_GAP - PROJECT_MENU_VIEWPORT_MARGIN;
      const nextPlacement =
        spaceBelow < menuHeight && spaceAbove > spaceBelow ? 'up' : 'down';

      setMenuPlacement((current) => (current === nextPlacement ? current : nextPlacement));
    };

    measureMenuPlacement();
    window.addEventListener('resize', measureMenuPlacement);
    window.addEventListener('scroll', measureMenuPlacement, true);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measureMenuPlacement);
    if (observer) {
      observer.observe(anchor);
      observer.observe(menu);
    }
    return () => {
      window.removeEventListener('resize', measureMenuPlacement);
      window.removeEventListener('scroll', measureMenuPlacement, true);
      observer?.disconnect();
    };
  }, [menuOpenId]);

  // Cover fetching must key off the *set of project ids and their readiness*, not the
  // `visibleProjects` array reference. That reference changes on every render
  // (upstream props/derived lists are recreated, and a 2s poll re-renders the
  // shell), and depending on it re-ran this effect — and re-fetched every
  // project's files — on every render (observed ~23× per project in a trace).
  const coverFetchKey = visibleProjects.map(({ project }) => project.id).join('|');
  const visibleProjectsRef = useRef(new Map<string, Project>());
  visibleProjectsRef.current = new Map(
    visibleProjects.map(({ project }) => [project.id, project]),
  );
  const coverGenerationRef = useRef(new Map<string, number>());
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  const coverQueueRef = useRef<BackgroundTaskQueue | null>(null);
  if (!coverQueueRef.current) {
    coverQueueRef.current = new BackgroundTaskQueue(MAX_BACKGROUND_COVER_REQUESTS);
  }
  const coverQueue = coverQueueRef.current;
  const coverInFlightRef = useRef(
    new Map<string, {
      controller: AbortController;
      generation: number;
      promise: Promise<void>;
    }>(),
  );
  // The decision itself lives in `lib/project-cover-pipeline`
  // (`resolveProjectCover`), shared with the rail's hover preview
  // (OPEND-2766); this wrapper only keeps the grid's call sites stable.
  const loadProjectCover = useCallback(async (
    project: Project,
    signal: AbortSignal,
    freshFiles = false,
  ): Promise<ProjectCoverOverride | null | undefined> =>
    resolveProjectCover(project, signal, freshFiles), []);

  const requestProjectCover = useCallback((
    project: Project,
    options: { force?: boolean } = {},
  ): Promise<void> => {
    if (!activeRef.current) return Promise.resolve();
    const snapshotKey = projectCoverSnapshotKey(null, project.id, project.updatedAt);
    if (!options.force) {
      // Serve the last successful decision for this exact project/version
      // instead of re-running the files scan + probe on every remount. Stale
      // versions miss the key (Batch A §4.2).
      const snapshot = getProjectCoverSnapshot(snapshotKey);
      if (snapshot !== undefined) {
        if (visibleProjectsRef.current.has(project.id)) {
          setCoverByProject((current) =>
            current[project.id] === snapshot.cover
              ? current
              : { ...current, [project.id]: snapshot.cover },
          );
        }
        return Promise.resolve();
      }
    }
    const existing = coverInFlightRef.current.get(project.id);
    if (existing && !options.force) return existing.promise;
    const generation = (coverGenerationRef.current.get(project.id) ?? 0) + 1;
    coverGenerationRef.current.set(project.id, generation);
    const controller = new AbortController();
    const promise = coverQueue.schedule(
      controller,
      () => loadProjectCover(project, controller.signal, options.force === true),
      options.force,
    )
      .then((cover) => {
        if (controller.signal.aborted) return;
        if (cover === undefined) return;
        if (coverGenerationRef.current.get(project.id) !== generation) return;
        setProjectCoverSnapshot(snapshotKey, cover);
        if (!visibleProjectsRef.current.has(project.id)) return;
        setCoverByProject((current) => ({ ...current, [project.id]: cover }));
      })
      .finally(() => {
        // Generation values can be reused after a StrictMode synthetic cleanup
        // clears the maps. Only the exact request that installed this entry may
        // remove it; otherwise late settlement from replay A can erase replay
        // B, leaving the real unmount with no controller to abort.
        if (coverInFlightRef.current.get(project.id)?.controller === controller) {
          coverInFlightRef.current.delete(project.id);
        }
      });
    coverInFlightRef.current.set(project.id, { controller, generation, promise });
    // Install the replacement first so a force-refresh enters the front of the
    // queue before aborting its stale predecessor releases a slot.
    existing?.controller.abort();
    return promise;
  }, [coverQueue, loadProjectCover]);

  const abortBackgroundCoverRequests = useCallback(() => {
    coverQueue.withoutDraining(() => {
      for (const request of coverInFlightRef.current.values()) {
        request.controller.abort();
      }
    });
    coverInFlightRef.current.clear();
  }, [coverQueue]);

  // Cards report themselves through a per-card viewport sentinel; only cards
  // that have actually been near the viewport ever start cover work
  // (Batch A §4.2). The set is per-mount on purpose: a fresh strip instance
  // re-discovers visibility, while resolved decisions come from the snapshot
  // cache.
  const coverSentinelSeenRef = useRef(new Set<string>());
  useEffect(() => {
    abortBackgroundCoverRequests();
    setCoverByProject({});
    for (const project of visibleProjectsRef.current.values()) {
      if (!coverSentinelSeenRef.current.has(project.id)) continue;
      void requestProjectCover(project);
    }
  }, [abortBackgroundCoverRequests, requestProjectCover]);
  const handleCoverCardVisible = useCallback((projectId: string) => {
    if (coverSentinelSeenRef.current.has(projectId)) return;
    coverSentinelSeenRef.current.add(projectId);
    const project = visibleProjectsRef.current.get(projectId);
    if (!project) return;
    void requestProjectCover(project);
  }, [requestProjectCover]);

  const resumeBackgroundCoverRequests = useCallback(() => {
    if (!activeRef.current) return;
    resumeThumbnailLoads();
    for (const project of visibleProjectsRef.current.values()) {
      if (!coverSentinelSeenRef.current.has(project.id)) continue;
      void requestProjectCover(project);
    }
  }, [requestProjectCover]);

  useEffect(() => {
    return () => {
      // Cover probes are background-only. Do not let them survive navigation
      // away from Home and occupy the connections needed by the reopened
      // project's file list and preview source.
      abortBackgroundCoverRequests();
      coverGenerationRef.current.clear();
    };
  }, [abortBackgroundCoverRequests]);

  useEffect(() => {
    const visibleIds = new Set(visibleProjects.map(({ project }) => project.id));
    if (!isActive) {
      abortBackgroundCoverRequests();
      return;
    }
    const staleRequests = [...coverInFlightRef.current.entries()]
      .filter(([projectId]) => !visibleIds.has(projectId));
    coverQueue.withoutDraining(() => {
      for (const [projectId, request] of staleRequests) {
        request.controller.abort();
        coverInFlightRef.current.delete(projectId);
        coverGenerationRef.current.delete(projectId);
      }
    });
    if (visibleProjects.length === 0) {
      setCoverByProject({});
      return;
    }
    setCoverByProject((current) => {
      const entries = Object.entries(current).filter(([projectId]) => visibleIds.has(projectId));
      return entries.length === Object.keys(current).length
        ? current
        : Object.fromEntries(entries);
    });
    for (const { project } of visibleProjects) {
      if (!coverSentinelSeenRef.current.has(project.id)) continue;
      void requestProjectCover(project);
    }
    // Intentionally keyed on the id set (coverFetchKey), not visibleProjects,
    // so re-renders that don't change which projects are shown don't re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abortBackgroundCoverRequests, coverFetchKey, coverQueue, isActive, requestProjectCover]);

  // First-run home shouldn't reserve space for an empty "Recent
  // projects" rail — the dashed empty box just adds visual noise
  // above the plugin gallery. We also skip rendering during the
  // load window so the section doesn't pop in and then collapse;
  // the prompt hero is enough chrome on its own.
  // Home rail only: an empty rail is dropped entirely (dashed empty chrome is
  // noise over the plugin gallery). The FULL-PAGE grids (drafts/all-projects)
  // must keep their header + filter toolbar even when the current owner/type
  // filter matches nothing — collapsing them stranded the user with no way to
  // change the filter back.
  if (visibleProjects.length === 0 && !fullPageGrid) {
    return null;
  }

  function startRename(project: Project) {
    trackCollection('rename', {
      project_key: project.id,
      project_relation: 'self',
    });
    setMenuOpenId(null);
    setRenameTarget({ id: project.id, original: project.name });
    setRenameInput(project.name);
  }

  function cancelRename() {
    setRenameTarget(null);
    setRenameInput('');
  }

  function commitRename() {
    if (!renameTarget || !onRename) return;
    const trimmed = renameInput.trim();
    if (trimmed && trimmed !== renameTarget.original) {
      onRename(renameTarget.id, trimmed);
    }
    cancelRename();
  }

  function requestDelete(project: Project) {
    trackCollection('delete', {
      project_key: project.id,
      project_relation: 'self',
    });
    setMenuOpenId(null);
    deleteFlow.request(project);
  }

  function requestDuplicate(project: Project) {
    if (!onDuplicate) return;
    trackCollection('duplicate', {
      project_key: project.id,
      project_relation: 'self',
    });
    setMenuOpenId(null);
    void duplicateFlow.duplicate(project);
  }

  function toggleSelection(projectId: string) {
    setSelectedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedProjectIds(new Set());
  }

  async function commitBulkDelete() {
    const ids = selectedProjects.map(({ project }) => project.id);
    const startedAt = performance.now();
    setBulkDeleteOpen(false);
    exitSelectionMode();
    if (!onDelete || ids.length === 0) return;
    const deleted = await Promise.all(
      ids.map(async (id) => {
        try {
          const result = await onDelete(id);
          return result === false ? null : id;
        } catch (err) {
          console.warn('[RecentProjectsStrip] bulk delete project failed:', err);
          return null;
        }
      }),
    );
    const succeededCount = deleted.filter((id): id is string => id !== null).length;
    const failedCount = ids.length - succeededCount;
    trackWorkspaceProjectActionResult(analytics.track, {
      page_name: analyticsPage,
      area: 'project_collection',
      action: 'bulk_delete',
      result: failedCount === 0 ? 'success' : succeededCount > 0 ? 'partial_success' : 'failed',
      requested_count: ids.length,
      succeeded_count: succeededCount,
      failed_count: failedCount,
      duration_ms: Math.round(performance.now() - startedAt),
      ...(failedCount > 0 ? { error_code: 'one_or_more_failed' } : {}),
    });
  }

  return (
    <section className="recent-projects" data-testid="recent-projects-strip">
      {fullPageGrid ? (
        <header className="recent-projects__head">
          <div className="recent-projects__title-block">
            <h2 className="recent-projects__heading">{heading ?? t('recentProjects.title')}</h2>
            {description ? (
              <p className="recent-projects__description">{description}</p>
            ) : null}
          </div>
          <div className="recent-projects__controls">
            <button
              type="button"
              className={`recent-projects__select-toggle${selectionMode ? ' is-active' : ''}`}
              aria-pressed={selectionMode}
              onClick={() => {
                trackCollection('multi_select_toggle', {
                  selection_count_bucket: countBucket(selectedCount),
                });
                setSelectionMode((current) => !current);
                setSelectedProjectIds(new Set());
                setMenuOpenId(null);
              }}
            >
              {t('recentProjects.multiSelect')}
            </button>
            <div className="recent-projects__filter-wrap">
              <button
                type="button"
                className="recent-projects__filter"
                aria-haspopup="menu"
                aria-expanded={openHeaderMenu === 'kind'}
                onClick={() => setOpenHeaderMenu((current) => current === 'kind' ? null : 'kind')}
              >
                {kindFilterLabel(
                  KIND_FILTER_OPTIONS.find((option) => option.id === kindFilter) ?? KIND_FILTER_OPTIONS[0]!,
                  t,
                )}
                <Icon name="chevron-down" size={13} />
              </button>
              {openHeaderMenu === 'kind' ? (
                <div className="recent-projects__filter-menu" role="menu">
                  {KIND_FILTER_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={kindFilter === option.id ? 'is-active' : undefined}
                      onClick={() => {
                        trackCollection('filter', {
                          filter_type: 'project_type',
                          filter_value: option.id,
                        });
                        setKindFilter(option.id);
                        setOpenHeaderMenu(null);
                      }}
                    >
                      {kindFilterLabel(option, t)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div
              className="recent-projects__filter-wrap"
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || openHeaderMenu !== 'display') return;
                event.preventDefault();
                event.stopPropagation();
                setOpenHeaderMenu(null);
                displayTriggerRef.current?.focus();
              }}
            >
              <button
                ref={displayTriggerRef}
                type="button"
                className="recent-projects__view-btn"
                aria-label={`${t('recentProjects.sortAria')} · ${t('designs.viewToggleAria')}`}
                aria-haspopup="menu"
                aria-expanded={openHeaderMenu === 'display'}
                onClick={() =>
                  setOpenHeaderMenu((current) => current === 'display' ? null : 'display')
                }
              >
                <RemixIcon name="more-2-line" size={16} />
              </button>
              {openHeaderMenu === 'display' ? (
                <div
                  className="recent-projects__filter-menu recent-projects__filter-menu--display"
                  role="menu"
                >
                  <div
                    className="recent-projects__filter-menu-group"
                    role="group"
                    aria-label={t('recentProjects.sortAria')}
                  >
                    <span className="recent-projects__filter-menu-label" aria-hidden="true">
                      {t('recentProjects.sortAria')}
                    </span>
                    {SORT_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={sort === option.id}
                        className={sort === option.id ? 'is-active' : undefined}
                        onClick={() => {
                          trackCollection('sort', {
                            sort_value:
                              option.id === 'updatedAsc'
                                ? 'updated_asc'
                                : option.id === 'nameAsc'
                                  ? 'name_asc'
                                  : 'updated_desc',
                          });
                          setSort(option.id);
                          setOpenHeaderMenu(null);
                        }}
                      >
                        <span>{t(option.labelKey)}</span>
                        <span className="recent-projects__filter-menu-check" aria-hidden="true">
                          {sort === option.id ? <Icon name="check" size={13} /> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div
                    className="recent-projects__filter-menu-group"
                    role="group"
                    aria-label={t('designs.viewToggleAria')}
                  >
                    <span className="recent-projects__filter-menu-label" aria-hidden="true">
                      {t('designs.viewToggleAria')}
                    </span>
                    {VIEW_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={view === option.id}
                        className={view === option.id ? 'is-active' : undefined}
                        onClick={() => {
                          if (view !== option.id) {
                            trackCollection('view_toggle', { view_value: option.id });
                            setView(option.id);
                          }
                          setOpenHeaderMenu(null);
                        }}
                      >
                        <span>{t(option.labelKey)}</span>
                        <span className="recent-projects__filter-menu-check" aria-hidden="true">
                          {view === option.id ? <Icon name="check" size={13} /> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </header>
      ) : (
        <header className="recent-projects__head">
          <h2 className="recent-projects__title">{t('recentProjects.title')}</h2>
          {onViewAll ? (
            <button
              type="button"
              className="recent-projects__view-all"
              onClick={onViewAll}
              data-testid="recent-projects-view-all"
            >
              <span>{t('recentProjects.viewAll')}</span>
              <Icon name="chevron-right" size={12} />
            </button>
          ) : null}
        </header>
      )}
      {selectionMode ? (
        <div
          className="recent-projects__bulkbar"
          role="toolbar"
          aria-label={t('recentProjects.multiSelect')}
        >
          <span className="recent-projects__bulkbar-count">
            {t('designs.selectedCount', { n: selectedCount })}
          </span>
          <div className="recent-projects__bulkbar-actions">
            {onDelete ? (
              <button
                type="button"
                className="danger"
                disabled={bulkMutationDisabled}
                title={bulkMutationTitle}
                onClick={() => {
                  trackCollection('bulk_delete', {
                    selection_count_bucket: countBucket(selectedCount),
                  });
                  setBulkDeleteOpen(true);
                }}
              >
                <Icon name="trash" size={14} /> {t('designs.deleteSelected')}
              </button>
            ) : null}
            <button type="button" className="ghost" onClick={exitSelectionMode}>
              {t('designs.cancelSelect')}
            </button>
          </div>
        </div>
      ) : null}
      <div
        ref={rowRef}
        className={`recent-projects__row${fullPageGrid ? ` recent-projects__row--${view}` : ''}${menuOpenId ? ' recent-projects__row--menu-open' : ''}${selectionMode ? ' is-selecting' : ''}`}
        role="list"
      >
        {visibleProjects.map(({ project }) => {
          const cover = projectCover(project, coverByProject[project.id] ?? null);
          const designSystemProject = isDesignSystemProject(project);
          const selected = selectedProjectIds.has(project.id);
          return (
            <div
              key={project.id}
              role="listitem"
              className={`recent-projects__card${designSystemProject ? ' is-design-system-project' : ''}${menuOpenId === project.id ? ' is-menu-open' : ''}${selected ? ' is-selected' : ''}`}
              data-project-id={project.id}
            >
              {selectionMode ? (
                <button
                  type="button"
                  className="recent-projects__select-check"
                  aria-pressed={selected}
                  aria-label={project.name}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSelection(project.id);
                  }}
                >
                  <span aria-hidden>
                    {selected ? (
                      <svg
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        width={16}
                        height={16}
                        style={{ display: 'block' }}
                      >
                        <path d="M9.9997 15.1709L19.1921 5.97852L20.6063 7.39273L9.9997 17.9993L3.63574 11.6354L5.04996 10.2212L9.9997 15.1709Z" />
                      </svg>
                    ) : null}
                  </span>
                </button>
              ) : null}
              <button
                type="button"
                className="recent-projects__card-main"
                onClick={() => {
                  if (selectionMode) {
                    toggleSelection(project.id);
                    return;
                  }
                  trackCollection('project_open', {
                    project_key: project.id,
                    project_relation: 'self',
                  }, analytics.newRequestId());
                  // Release every background cover slot before the project view
                  // starts its foreground files/content reads. Waiting for the
                  // entry shell to unmount is too late: navigation itself needs
                  // those same browser connections. Suspending the thumbnail
                  // gate also unmounts still-loading preview iframes so their
                  // document loads stop competing immediately (Batch A §4.2);
                  // already-loaded frames stay rendered.
                  abortBackgroundCoverRequests();
                  suspendThumbnailLoads();
                  try {
                    const result = onOpen(project.id);
                    if (result && typeof result === 'object' && 'then' in result) {
                      void Promise.resolve(result).then(
                        (opened) => {
                          if (opened === false) resumeBackgroundCoverRequests();
                        },
                        () => {
                          resumeBackgroundCoverRequests();
                        },
                      );
                    } else if (result === false) {
                      resumeBackgroundCoverRequests();
                    }
                  } catch {
                    resumeBackgroundCoverRequests();
                  }
                }}
                title={project.name}
              >
                <div
                  className={`recent-projects__card-thumb recent-projects__card-thumb-${cover.kind}`}
                  style={cover.style}
                  aria-hidden
                >
                  <CoverVisibilitySentinel
                    projectId={project.id}
                    onVisible={handleCoverCardVisible}
                  />
                  {(cover.kind === 'image' || cover.kind === 'logo') && cover.src ? (
                    <img
                      className="recent-projects__thumb-media"
                      src={cover.src}
                      alt=""
                      loading="lazy"
                    />
                  ) : cover.kind === 'video' && cover.src ? (
                    <video
                      className="recent-projects__thumb-media"
                      src={cover.src}
                      muted
                      preload="metadata"
                      playsInline
                    />
                  ) : cover.kind === 'html' && cover.src ? (
                    <RecentProjectHtmlThumb
                      src={cover.src}
                      initial={cover.initial}
                      diagnostic={`${project.id}:${cover.name ?? 'unknown'}`}
                      deckCoverOnly={project.metadata?.kind === 'deck'}
                    />
                  ) : (
                    <span className="recent-projects__card-glyph">{cover.initial}</span>
                  )}
                </div>
                <div className="recent-projects__card-meta">
                  <div className="recent-projects__card-name-row">
                    <span className="recent-projects__card-name">{project.name}</span>
                  </div>
                  <div className="recent-projects__card-footer">
                    <div className="recent-projects__card-time">
                      <span className="recent-projects__card-owner" aria-hidden>
                        {creator.initial}
                      </span>
                      {/* OPEND-3201: the creator is the part that gives way
                          when the row is short of room; the time keeps its
                          own non-shrinking box so it is never clipped by the
                          kind chip on the right. */}
                      <span className="recent-projects__card-creator">
                        {t('recentProjects.creatorLine', { name: creator.name })}
                      </span>
                      <span className="recent-projects__card-sep" aria-hidden>·</span>
                      <span className="recent-projects__card-when">
                        {relativeTime(project.updatedAt, t)}
                      </span>
                    </div>
                    <div className="design-card-tag-row">
                      {designSystemProject ? (
                        <DesignSystemProjectTag />
                      ) : (
                        <ProjectTag category={projectCategory(project)} />
                      )}
                    </div>
                  </div>
                </div>
              </button>
              {actionsAvailable && !selectionMode ? (
                <div
                  className="recent-projects__card-menu-anchor"
                  ref={menuOpenId === project.id ? menuContainerRef : undefined}
                >
                  <button
                    type="button"
                  className="recent-projects__card-more"
                  aria-label={t('designs.menuMore')}
                  aria-haspopup="menu"
                  aria-expanded={menuOpenId === project.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      trackCollection('more_menu', {
                        project_key: project.id,
                        project_relation: 'self',
                      });
                      setMenuOpenId((current) => current === project.id ? null : project.id);
                    }}
                  >
                    <Icon name="more-horizontal" size={14} />
                  </button>
                  {menuOpenId === project.id ? (
                    <div
                      className="recent-projects__card-menu"
                      data-placement={menuPlacement}
                      ref={menuRef}
                      role="menu"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {onRename ? (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => startRename(project)}
                        >
                          <Icon name="pencil" size={14} />
                          <span>{t('designs.menuRename')}</span>
                        </button>
                      ) : null}
                      {onDuplicate ? (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => requestDuplicate(project)}
                        >
                          <Icon name="copy" size={14} />
                          <span>{t('designs.menuDuplicate')}</span>
                        </button>
                      ) : null}
                      {onDelete ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={() => requestDelete(project)}
                        >
                          <Icon name="close" size={14} />
                          <span>{t('designs.menuDelete')}</span>
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {renameTarget ? (
        <Dialog
          as="form"
          className="modal-rename"
          onClose={cancelRename}
          closeOnEscape
          ariaLabelledBy={renameTitleId}
          onSubmit={(event) => {
            event.preventDefault();
            commitRename();
          }}
        >
          <DialogTitle id={renameTitleId}>{t('designs.renameTitle')}</DialogTitle>
          <label>
            {t('designs.renamePrompt', { name: renameTarget.original })}
            <input
              type="text"
              value={renameInput}
              autoFocus
              onChange={(event) => setRenameInput(event.target.value)}
            />
          </label>
          <DialogFooter className="row">
            <button type="button" onClick={cancelRename}>
              {t('designs.renameCancel')}
            </button>
            <button
              type="submit"
              className="primary"
              disabled={!renameInput.trim() || renameInput.trim() === renameTarget.original}
            >
              {t('designs.renameSave')}
            </button>
          </DialogFooter>
        </Dialog>
      ) : null}
      {deleteFlow.target ? (
        <ProjectDeleteConfirmDialog
          projectName={deleteFlow.target.name}
          pending={deleteFlow.pending}
          failed={deleteFlow.failed}
          errorMessage={deleteFlow.errorMessage}
          onCancel={deleteFlow.cancel}
          onConfirm={() => void deleteFlow.commit()}
        />
      ) : null}
      {bulkDeleteOpen ? (
        <Dialog
          className="modal-confirm"
          role="alertdialog"
          onClose={() => setBulkDeleteOpen(false)}
          closeOnEscape
          ariaLabelledBy={bulkDeleteTitleId}
        >
          <DialogTitle id={bulkDeleteTitleId}>{t('designs.deleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('designs.deleteSelectedConfirm', { n: selectedCount })}
          </DialogDescription>
          <DialogFooter className="row">
            <button type="button" onClick={() => setBulkDeleteOpen(false)}>
              {t('designs.renameCancel')}
            </button>
            <button
              type="button"
              className="primary danger"
              onClick={() => void commitBulkDelete()}
            >
              {t('designs.deleteSelected')}
            </button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </section>
  );
}

// Card thumbnails for HTML projects render the real artifact, not a
// placeholder: a plain prototype page loads straight into a lazy sandboxed
// iframe, while a deck collapses to its first slide (`DeckCoverThumb`) so the
// card shows a cover instead of whichever slide the deck script last left on
// screen.
function RecentProjectHtmlThumb({
  src,
  initial,
  diagnostic,
  deckCoverOnly,
}: {
  src: string;
  initial: string;
  diagnostic: string;
  deckCoverOnly: boolean;
}) {
  // Plain HTML goes through the shared cover frame (#5762): it HEAD-probes the
  // cover URL in the parent cover queue first and falls back to the initial
  // glyph when the entry file has gone missing. Keeping verification in that
  // queue is what prevents an All Projects grid from launching one HEAD per
  // card at once.
  if (!deckCoverOnly) {
    return (
      <VerifiedHtmlCoverFrame
        src={src}
        initial={initial}
        diagnostic={diagnostic}
      />
    );
  }

  return <DeckCoverThumb src={src} />;
}

function VerifiedHtmlCoverFrame({
  src,
  initial,
  diagnostic,
}: {
  src: string;
  initial: string;
  diagnostic: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  // The iframe document load is deferred until the card is near the viewport
  // and one of the shared thumbnail load slots is free, so a large grid
  // cannot flood the daemon with background document loads (Batch A §4.2).
  const { ref: inViewRef, inView } = useInView<HTMLSpanElement>({
    rootMargin: THUMBNAIL_OVERSCAN_MARGIN,
  });
  const { canLoad, settle } = useThumbnailLoadSlot(inView && !failed);
  if (failed) {
    return <span className="recent-projects__card-glyph">{initial}</span>;
  }
  if (!canLoad) {
    return (
      <span ref={inViewRef} className="recent-projects__card-glyph">
        {initial}
      </span>
    );
  }
  return (
    <iframe
      className="recent-projects__thumb-iframe"
      src={mutedMotionCoverUrl(src)}
      title=""
      loading="lazy"
      sandbox="allow-scripts"
      tabIndex={-1}
      onLoad={settle}
      onError={() => {
        settle();
        console.warn('[project-cover] failed to load HTML cover:', diagnostic);
        setFailed(true);
      }}
    />
  );
}

// Zero-interaction marker that tells the strip when a card's thumbnail area
// first comes near the viewport. Cover probes (files scan + HEAD) start only
// after this fires, so offscreen cards in a 100+ project grid cost nothing
// until scrolled toward (Batch A §4.2).
function CoverVisibilitySentinel({
  projectId,
  onVisible,
}: {
  projectId: string;
  onVisible: (projectId: string) => void;
}) {
  const { ref, inView } = useInView<HTMLSpanElement>({
    rootMargin: THUMBNAIL_OVERSCAN_MARGIN,
  });
  const seenRef = useRef(false);
  useEffect(() => {
    if (!inView || seenRef.current) return;
    seenRef.current = true;
    onVisible(projectId);
  }, [inView, onVisible, projectId]);
  return (
    <span
      ref={ref}
      aria-hidden
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', visibility: 'hidden' }}
    />
  );
}

function DeckCoverThumb({ src }: { src: string }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const { ref: inViewRef, inView } = useInView<HTMLDivElement>({
    rootMargin: THUMBNAIL_OVERSCAN_MARGIN,
  });
  const setFrameRef = useCallback(
    (node: HTMLDivElement | null) => {
      frameRef.current = node;
      inViewRef.current = node;
    },
    [inViewRef],
  );
  const [srcDoc, setSrcDoc] = useState<string | null>(() => getCachedDeckCover(src) ?? null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedDeckCover(src);
    if (cached) {
      setSrcDoc(cached);
      return;
    }
    setSrcDoc(null);
    // Deck covers fetch the full document text; defer that until the card is
    // actually near the viewport (Batch A §4.2).
    if (!inView) return;
    loadDeckCover(src)
      .then((next) => {
        if (!cancelled) setSrcDoc(next);
      })
      .catch(() => {
        if (cancelled) return;
        setSrcDoc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [src, inView]);

  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setScale(Math.min(rect.width / DECK_PREVIEW_WIDTH, rect.height / DECK_PREVIEW_HEIGHT));
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={setFrameRef}
      className="recent-projects__deck-frame"
      style={{ '--recent-deck-scale': scale } as CSSProperties}
      aria-hidden
    >
      {srcDoc ? (
        <iframe
          className="recent-projects__deck-iframe"
          srcDoc={srcDoc}
          title=""
          loading="lazy"
          sandbox=""
          tabIndex={-1}
        />
      ) : (
        <span className="recent-projects__deck-cover-loading" aria-hidden />
      )}
    </div>
  );
}

function relativeTime(ts: number, t: ReturnType<typeof useT>): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return t('common.justNow');
  if (diff < hr) return t('common.minutesAgo', { n: Math.floor(diff / min) });
  if (diff < day) return t('common.hoursAgo', { n: Math.floor(diff / hr) });
  if (diff < 7 * day) return t('common.daysAgo', { n: Math.floor(diff / day) });
  return new Date(ts).toLocaleDateString();
}

export function projectCover(
  project: Project,
  override: ProjectCoverOverride | null,
): {
  kind: 'image' | 'video' | 'html' | 'logo' | 'fallback';
  src?: string;
  style: CSSProperties;
  initial: string;
  name?: string;
} {
  let h = 0;
  for (let i = 0; i < project.id.length; i += 1) {
    h = (h * 31 + project.id.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  const hue2 = (hue + 38) % 360;
  const style: CSSProperties = {
    background: `radial-gradient(circle at 30% 28%, hsl(${hue} 70% 78% / 0.55), transparent 42%), linear-gradient(135deg, hsl(${hue} 65% 88%), hsl(${hue2} 70% 90%))`,
  };
  const trimmed = project.name.trim();
  const initial = (trimmed ? Array.from(trimmed)[0]! : '?').toUpperCase();
  if (override) {
    return {
      kind: override.kind,
      src: projectCoverUrl(project.id, override.name, override.mtime),
      style,
      initial,
      name: override.name,
    };
  }
  const meta = project.metadata;
  const entry = meta?.entryFile;
  if (entry) {
    const src = projectCoverUrl(project.id, entry, project.updatedAt);
    if (meta?.kind === 'image') return { kind: 'image', src, style, initial };
    if (meta?.kind === 'video') return { kind: 'video', src, style, initial };
    if (/\.html?$/i.test(entry)) return { kind: 'html', src, style, initial, name: entry };
  }
  return { kind: 'fallback', style, initial };
}

export type ProjectCategory =
  | 'prototype'
  | 'live-artifact'
  | 'web-clone'
  | 'slide'
  | 'media'
  | 'brand';

/** Every chip a project card can wear, `ProjectCategory` plus the
 *  design-system tag the card substitutes for it. */
export type ProjectCardCategory = ProjectCategory | 'design-system';

/**
 * The type a card actually advertises — the single source of truth behind both
 * the chip in the card footer and the header's type filter. It mirrors the
 * card's own branch: a design-system project wears the Design System tag,
 * everything else falls through to {@link projectCategory}. Filtering must go
 * through this, never through the raw `metadata.kind`, or the dropdown starts
 * offering types no chip displays.
 */
export function projectCardCategory(project: Project): ProjectCardCategory {
  return isDesignSystemProject(project) ? 'design-system' : projectCategory(project);
}

/** The eleven creation types the project list's type filter offers
 *  (OPEND-3107), in the product order. */
export type ProjectKindFilterCategory =
  | 'prototype'
  | 'slide'
  | 'document'
  | 'image'
  | 'hyperframes'
  | 'web-clone'
  | 'video'
  | 'audio'
  | 'live-artifact'
  | 'webgl'
  | 'design-system';

/**
 * The type-filter bucket a project falls into: the type the user picked to
 * create it. Every project resolves to exactly one bucket. The creation
 * `intent` the Home chips stamp (home-hero/chips.ts) outranks the storage
 * `kind`, because two intents share a kind with something else — HyperFrames
 * is stored as a video, WebGL and Document as prototypes — and a bare kind
 * then names the four media / deck / design-system buckets; whatever is left
 * is a blank prototype. This deliberately differs from the card chip
 * ({@link projectCardCategory}), which still folds video / audio into one
 * Media chip and shows no Document, HyperFrames or WebGL chip at all.
 */
export function projectKindFilterCategory(project: Project): ProjectKindFilterCategory {
  if (isDesignSystemProject(project) || project.metadata?.kind === 'brand') return 'design-system';
  switch (project.metadata?.intent) {
    case 'document':
      return 'document';
    case 'hyperframes':
      return 'hyperframes';
    case 'web-clone':
      return 'web-clone';
    case 'webgl-experience':
      return 'webgl';
    case 'live-artifact':
      return 'live-artifact';
    default:
      break;
  }
  if (project.skillId === 'live-artifact') return 'live-artifact';
  switch (project.metadata?.kind) {
    case 'deck':
      return 'slide';
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    default:
      return 'prototype';
  }
}

export function projectCategory(project: Project): ProjectCategory {
  const meta = project.metadata;
  if (meta?.intent === 'live-artifact' || project.skillId === 'live-artifact') {
    return 'live-artifact';
  }
  // Website clone projects still store `kind: 'prototype'` (see
  // home-hero/chips.ts's 'web-clone' chip) so preview behavior stays
  // identical to a blank prototype; only `intent: 'web-clone'` marks the
  // scenario. Without this branch every clone fell through to the default
  // 'prototype' bucket and had no way to be filtered separately (recvpZbvupSr1o).
  if (meta?.intent === 'web-clone') return 'web-clone';
  if (meta?.kind === 'deck') return 'slide';
  if (meta?.kind === 'brand') return 'brand';
  if (meta?.kind === 'image' || meta?.kind === 'video' || meta?.kind === 'audio') {
    return 'media';
  }
  return 'prototype';
}

/** The glyph each kind chip leads with — the same icon that kind wears in the
 *  Home type rail, so a card and the rail name the same thing the same way. */
const PROJECT_TAG_ICON: Record<ProjectCardCategory, IconName> = {
  prototype: 'artboard',
  'live-artifact': 'bar-chart-box',
  'web-clone': 'globe',
  slide: 'present',
  media: 'image',
  brand: 'swatchbook',
  'design-system': 'sliders',
};

function projectTagLabel(category: ProjectCategory, t: ReturnType<typeof useT>): string {
  return category === 'live-artifact'
    ? t('designs.tagLiveArtifact')
    : category === 'web-clone'
      ? t('designs.tagWebClone')
      : category === 'slide'
        ? t('designs.tagSlide')
        : category === 'brand'
          ? 'Brand'
        : category === 'media'
          ? t('designs.tagMedia')
          : t('designs.tagPrototype');
}

export function ProjectTag({ category }: { category: ProjectCategory }) {
  const t = useT();
  const label = projectTagLabel(category, t);
  return (
    <span className={`design-card-tag tag-${category}`}>
      <Icon name={PROJECT_TAG_ICON[category]} size={12} className="design-card-tag__icon" />
      {label}
    </span>
  );
}

function DesignSystemProjectTag() {
  return (
    <span className="design-card-tag tag-design-system">
      <Icon name={PROJECT_TAG_ICON['design-system']} size={12} className="design-card-tag__icon" />
      {DESIGN_SYSTEM_TAG_LABEL}
    </span>
  );
}
