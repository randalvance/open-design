import { afterEach, describe, expect, it } from 'vitest';

import {
  markProjectDisplaySnapshotsDirty,
  patchProjectDisplaySnapshots,
  projectDisplaySnapshotKey,
  readProjectDisplaySnapshot,
  removeProjectFromDisplaySnapshots,
  resetProjectDisplaySnapshots,
  writeProjectDisplaySnapshot,
} from '../../src/state/project-display-cache';
import type { Project } from '../../src/types';

function project(id: string): Project {
  return {
    id,
    name: id,
    skillId: null,
    designSystemId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('project display snapshots', () => {
  afterEach(() => resetProjectDisplaySnapshots());

  it('partitions snapshots by view, with recent as the default', () => {
    const keys = new Set([
      projectDisplaySnapshotKey({ view: 'drafts' }),
      projectDisplaySnapshotKey({ view: 'all' }),
      projectDisplaySnapshotKey({ view: 'recent' }),
    ]);

    expect(keys.size).toBe(3);
    expect(projectDisplaySnapshotKey({ view: undefined }))
      .toBe(projectDisplaySnapshotKey({ view: 'recent' }));
  });

  it('marks every view dirty while retaining its last-good value', () => {
    const drafts = { view: 'drafts' as const };
    const all = { view: 'all' as const };
    writeProjectDisplaySnapshot(drafts, [project('project-a')]);
    writeProjectDisplaySnapshot(all, [project('project-b')]);

    markProjectDisplaySnapshotsDirty();

    expect(readProjectDisplaySnapshot(projectDisplaySnapshotKey(drafts))).toMatchObject({
      projects: [{ id: 'project-a' }],
      dirty: true,
    });
    expect(readProjectDisplaySnapshot(projectDisplaySnapshotKey(all))).toMatchObject({
      projects: [{ id: 'project-b' }],
      dirty: true,
    });
  });

  it('a fresh write clears the dirty flag', () => {
    const scope = { view: 'recent' as const };
    writeProjectDisplaySnapshot(scope, [project('project-a')]);
    markProjectDisplaySnapshotsDirty();
    writeProjectDisplaySnapshot(scope, [project('project-a'), project('project-b')]);

    expect(readProjectDisplaySnapshot(projectDisplaySnapshotKey(scope))).toMatchObject({
      projects: [{ id: 'project-a' }, { id: 'project-b' }],
      dirty: false,
    });
  });

  it('patches and removes a project across every view', () => {
    const drafts = { view: 'drafts' as const };
    const all = { view: 'all' as const };
    writeProjectDisplaySnapshot(drafts, [project('shared')]);
    writeProjectDisplaySnapshot(all, [project('shared'), project('other')]);

    patchProjectDisplaySnapshots({
      patch: (projects) => projects.map((item) =>
        item.id === 'shared' ? { ...item, name: 'renamed' } : item),
    });
    expect(readProjectDisplaySnapshot(projectDisplaySnapshotKey(drafts)))
      .toMatchObject({ projects: [{ name: 'renamed' }], dirty: true });
    expect(readProjectDisplaySnapshot(projectDisplaySnapshotKey(all)))
      .toMatchObject({ projects: [{ name: 'renamed' }, { name: 'other' }], dirty: true });

    removeProjectFromDisplaySnapshots({ projectId: 'shared' });
    expect(readProjectDisplaySnapshot(projectDisplaySnapshotKey(drafts))?.projects).toEqual([]);
    expect(readProjectDisplaySnapshot(projectDisplaySnapshotKey(all))?.projects)
      .toMatchObject([{ id: 'other' }]);
  });

  it('answers null for a view that was never written', () => {
    writeProjectDisplaySnapshot({ view: 'drafts' }, [project('project-a')]);
    expect(readProjectDisplaySnapshot(projectDisplaySnapshotKey({ view: 'all' }))).toBeNull();
  });
});
