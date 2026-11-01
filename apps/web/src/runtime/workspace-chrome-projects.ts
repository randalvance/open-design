import type { Project } from '../types';

/**
 * The rows the workspace tabs chrome names its project tabs from.
 *
 * A deep-linked project the ambient list has not loaded yet is appended so its
 * tab has a name — never inserted into the ambient Home catalogue.
 */
export function projectsForWorkspaceChrome(input: {
  projects: Project[];
  activeProject: Project | null;
}): Project[] {
  const { projects, activeProject } = input;
  return activeProject && !projects.some((project) => project.id === activeProject.id)
    ? [...projects, activeProject]
    : projects;
}
