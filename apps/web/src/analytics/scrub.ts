// Rewrite absolute filesystem paths in exception stack traces. Packaged
// builds expose `file:///Applications/Open Design.app/Contents/Resources/…`
// which leaks both the install root and the user's home dir in homebrew /
// custom installs. Reduce to the repo-relative tail.
export function scrubFilePath(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  // file:///abs/path/.../apps/web/src/foo.tsx → app://apps/web/src/foo.tsx
  // /Users/<user>/.../apps/web/src/foo.tsx    → app://apps/web/src/foo.tsx
  //
  // The prefix uses `[^()\n]*?` (non-greedy, no parens/newlines) so paths
  // that contain spaces — most notably the packaged macOS layout
  // `/Applications/Open Design.app/Contents/Resources/...` — get fully
  // rewritten instead of partially leaking the install directory. The
  // tail stops at whitespace or a closing paren so stack frames of shape
  // `at fn (file:///.../foo.tsx:1:2)` lose only the path portion.
  return value.replace(
    /(?:file:\/\/)?[^()\n]*?\/((?:apps|packages|tools)\/[^\s)]+)/g,
    'app://$1',
  );
}
