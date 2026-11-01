import { describe, expect, it } from 'vitest';
import { scrubFilePath } from '../src/analytics/scrub';

describe('scrubFilePath', () => {
  it('rewrites a packaged-app file URL with spaces to the repo-relative tail', () => {
    expect(
      scrubFilePath(
        'file:///Applications/Open Design.app/Contents/Resources/apps/web/src/FileViewer.tsx',
      ),
    ).toBe('app://apps/web/src/FileViewer.tsx');
  });

  it('rewrites an absolute path under a home directory', () => {
    expect(scrubFilePath('/Users/jane/dev/checkout/apps/web/src/index.tsx')).toBe(
      'app://apps/web/src/index.tsx',
    );
  });

  it('strips only the path portion of a stack frame', () => {
    const scrubbed = scrubFilePath(
      'at handleClick (file:///Applications/Open Design.app/Contents/Resources/apps/web/src/FileViewer.tsx:147:23)',
    );
    expect(scrubbed).toBe('at handleClick (app://apps/web/src/FileViewer.tsx:147:23)');
  });

  it('leaves non-string input untouched', () => {
    expect(scrubFilePath(42)).toBe(42);
    expect(scrubFilePath(null)).toBeNull();
  });
});
