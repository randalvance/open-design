// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectDeleteConfirmDialog } from '../../../src/components/project-actions/ProjectDeleteConfirmDialog';

afterEach(cleanup);

it('names the project, confirms on delete, and cancel never deletes', () => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(<ProjectDeleteConfirmDialog projectName="Example" pending={false} failed={false} onCancel={onCancel} onConfirm={onConfirm} />);
  expect(screen.getByTestId('project-delete-confirm-dialog')).toHaveTextContent('Example');
  fireEvent.click(screen.getByTestId('project-delete-confirm-cancel'));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('project-delete-confirm-accept'));
  expect(onConfirm).toHaveBeenCalledOnce();
});

it('locks both buttons while the request is in flight and surfaces a failure', () => {
  const view = render(<ProjectDeleteConfirmDialog projectName="Example" pending failed={false} onCancel={vi.fn()} onConfirm={vi.fn()} />);
  expect(screen.getByTestId('project-delete-confirm-cancel')).toBeDisabled();
  expect(screen.getByTestId('project-delete-confirm-accept')).toBeDisabled();
  view.rerender(<ProjectDeleteConfirmDialog projectName="Example" pending={false} failed errorMessage="boom" onCancel={vi.fn()} onConfirm={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent('boom');
  expect(screen.getByTestId('project-delete-confirm-accept')).toBeEnabled();
});
