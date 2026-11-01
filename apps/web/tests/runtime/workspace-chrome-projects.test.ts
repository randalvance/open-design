// The switcher names the open project; a deep-linked row the ambient list has
// not loaded yet is appended for its tab only.

import { describe, expect, it } from 'vitest';

import { projectsForWorkspaceChrome } from '../../src/runtime/workspace-chrome-projects';
import type { Project } from '../../src/types';

function project(overrides: Partial<Project>): Project {
  return {
    id: 'p-1',
    name: 'Local name',
    skillId: null,
    designSystemId: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('projectsForWorkspaceChrome', () => {

  it('returns the same array when the open project is already listed', () => {
    const projects = [project({ id: 'p-1' })];
    expect(
      projectsForWorkspaceChrome({
        projects,
        activeProject: projects[0]!,
      }),
    ).toBe(projects);
    expect(
      projectsForWorkspaceChrome({
        projects,
        activeProject: projects[0]!,
      }),
    ).toBe(projects);
  });

  it('appends a deep-linked project the ambient list has not loaded', () => {
    const deepLinked = project({ id: 'p-deep', name: 'Placeholder' });
    const rows = projectsForWorkspaceChrome({
      projects: [project({ id: 'p-1' })],
      activeProject: deepLinked,
    });
    expect(rows.map((row) => [row.id, row.name])).toEqual([
      ['p-1', 'Local name'],
      ['p-deep', 'Placeholder'],
    ]);
  });

});
