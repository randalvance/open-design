import { describe, expect, it } from 'vitest';
import type { CommentFileFact, CommentFileState } from '@open-design/contracts';
import { parseCommentFileState } from '../src/projects/comment-file-facts.js';

const f1 = '11111111-1111-4111-8111-111111111111';
const f2 = '22222222-2222-4222-8222-222222222222';
const fact: CommentFileFact = { sourceFileId: f1, sourceFilePath: 'pages/a.html', entryPath: 'index.html', resourceId: 'selected', versionId: 'v1', retired: false };
const state = (files = [fact], revision = 1): CommentFileState => ({ schemaVersion: 1, revision, files });

describe('parseCommentFileState', () => {
  it('rejects mutation-as-state and malformed identities', () => {
    expect(parseCommentFileState({ schemaVersion: 1, baseRevision: 0, resourceId: 'root', versionId: 'v', files: [fact] })).toBeNull();
    expect(parseCommentFileState(state([{ ...fact, sourceFilePath: '../a.html' }]))).toBeNull();
    expect(parseCommentFileState(state([fact, { ...fact, sourceFileId: f2 }]))).toBeNull();
  });
});
