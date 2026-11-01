'use client';

import dynamic from 'next/dynamic';

import { MatrixLoader } from '../../src/components/MatrixLoader';
import { installWebObservability } from '../../src/observability/install';
import { installChatScrollExperiments } from '../../src/runtime/chat-scroll-experiments';
import { installChatScrollTakeover } from '../../src/runtime/chat-scroll-takeover';

// Install the browser observers. Nothing they report leaves the page, but the
// scroll-freeze probe's verdict drives the takeover installed below.
installWebObservability();

// The consumer of the scroll-freeze probe's verdict that acts on it: when the
// chat log's compositor-side scroll extent goes stale, kick the compositor for
// one frame, watch the next wheel, and if that did not help answer the wheel
// and the keyboard from JavaScript. Deliberately NOT part of
// `installWebObservability()` — that entry point is for observers, and this
// changes behaviour. On by default (product decision, 2026-09-17); setting
// `open-design:chat-scroll-takeover` to `'0'` makes this call read one storage
// key and return without registering anything.
installChatScrollTakeover();

// 滚动冻结的两个未证伪假设(H2 自观察 / H3 msg-enter 的 fill:both)各有一个
// localStorage 开关,好让同一个包能做 A/B。两个都不设时这一调用读两个键就返回,
// 根节点上不留任何痕迹 —— 行为和没有这行时一模一样。
// 必须在 React 挂载**之前**跑:H3 是入场动画,类名晚一帧到就会先闪一次动画。
// 操作说明(怎么开、怎么关、开了会失去什么)写在模块顶部的 docblock 里。
installChatScrollExperiments();

// The product is a fully client-driven SPA — every component reads
// localStorage, window.location, etc. — so we opt out of static-time
// rendering for the entire tree. This keeps `next build --output export`
// from trying to evaluate browser-only code while still emitting a real
// shell HTML the daemon can serve as the SPA fallback.
const App = dynamic(() => import('../../src/App').then((m) => m.App), {
  ssr: false,
  // Keeps the `od-loading-shell` class on the outer node: the white-screen
  // detector filters this whole subtree out by that class when deciding
  // whether the app really mounted (`src/observability/white-screen.ts`).
  loading: () => (
    <div className="od-loading-shell">
      <MatrixLoader />
      <span>Loading OpenDesign…</span>
    </div>
  ),
});

export function ClientApp() {
  return <App />;
}
