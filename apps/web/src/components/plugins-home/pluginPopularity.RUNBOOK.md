# Template popularity ordering (OPEND-449)

The plugin/example grid and the Home rail used to order every category with
hand-curated pins + a static visual-appeal heuristic — no usage signal. This
mechanism leads the **non-prototype** facets (Slides, Image, Video, …) by **how
often users actually reach for a template**, while keeping the **Prototype**
facet on its editorial/curated order (it is the showcase). The plain default
mode-seeds (Web Prototype, Simple Deck) and any no-preview tiles sink to the
bottom of their facet rather than topping it by default-usage.

## Files (this folder)

| File | Owner | What |
|---|---|---|
| `pluginPopularity.generated.ts` | **frozen snapshot** | `id → blended popularity score [0,1]` snapshot + build metadata |
| `pluginPopularity.ts` | source | accessor + the `comparePluginGalleryOrder` comparator + the policy knobs |
| `usePluginFacets.ts` → `filtered` | source | grid: master/All keeps visual order; a selected facet re-sorts via the comparator |
| `visualScore.ts` → `sortByVisualAppeal` | source | master / All browse order (visual appeal), unchanged |
| `HomeHero.tsx` → `comparePluginPresetOrder` | source | Home rail sort (per-chip) — calls the comparator |

Both sort sites call `comparePluginGalleryOrder(aId, bId, aCurationGoverned, bCurationGoverned)`
first, then fall back to their existing keys (curated priority → featured →
visual score → title). The comparator applies, in order:

1. **`ALWAYS_PINNED`** — curator force-front (empty by default).
2. **Sink** — the default mode-seeds (`ALWAYS_LAST` = Web Prototype, Simple Deck)
   plus the no-preview tiles (`PLUGIN_NO_PREVIEW`) drop to the bottom of their
   facet. They stay visible (facet counts match production), just last.
3. **Usage popularity** — for tiles **not** governed by curation. The caller
   passes `curationGoverned = true` for the **Prototype** facet, so it keeps its
   editorial/curated order; every other facet (Slides, Image, Video, …) leads by
   real usage.

The grid's master / **All** view keeps its original visual-appeal order — a
prototype-led editorial showcase — except the sunk tiles (`sinkToBottom` in
`usePluginFacets`) drop to the very bottom, matching the per-facet behavior. (No
cross-facet usage reshuffle: the Slides card aspect ratio differs from Prototype,
so interleaving them read as visually inconsistent.) When a facet is *selected*,
`usePluginFacets` re-sorts that slice through the comparator — so every
sub-category (Creative decks, Engineering talks, …) inherits the facet's rule
with no per-sub-facet code. The Home rail is inherently per-chip, so it calls the
comparator directly.

## Score

```
score = 0.6 · norm(log1p(distinctUsers)) + 0.4 · norm(log1p(runs))
```

- **distinct users** is the anti-gaming signal (a few power users hammering one
  template can't inflate it); **runs** add engagement depth. Weights live in the
  generated metadata and are robust — 0.5–0.7 barely move the order.
- `log1p` tames the head-template scale gap; min-max normalized over the live
  template set so both metrics land in `[0,1]`.
- Window: trailing **28 days** of `run_finished` events keyed by `plugin_id`
  (PostHog OD project `420348`), so the order follows template rotation.
- **Retired** templates (absent from the live catalog) are dropped and get no
  score.
- Templates below **20 distinct users** get no score → they keep their
  curated/visual fallback order (thin-sample tail stays stable).

## Sinking — `ALWAYS_LAST` + `PLUGIN_NO_PREVIEW`

Two id lists in the generated/source files drop tiles to the bottom of their
facet (they stay visible, so facet counts match production):

- **`ALWAYS_LAST`** (`pluginPopularity.ts`) — the generic default mode-seeds
  (`example-web-prototype`, `example-simple-deck`). They top usage only because
  they are the blank default for a mode, so in the curated showcase they read as
  filler. Edit this list to add/remove seeds.
- **`PLUGIN_NO_PREVIEW`** (generated) — templates that render no real preview: no
  baked thumbnail **and** no on-disk `od.preview` entry (some declare an entry
  file that does not exist, so the daemon serves a 404 and the tile falls back to
  a plain letter card). Repo-derived (filesystem-checked), refreshed with the
  scores. These generic mode-seeds also reach users through the composer's
  icon-based mode picker (`RailGroup group="create"`), which needs no preview.

## Policy knob — `POPULARITY_LEADS_CURATION`

`pluginPopularity.ts` exports `POPULARITY_LEADS_CURATION` (default **true**).

- **true**: usage popularity orders the non-prototype facets (the Prototype
  facet is always curation-governed).
- **false**: usage has no effect anywhere; the whole gallery falls back to the
  curated/visual order.

Which facets are curation-governed is decided by the caller, not this knob:
`visualScore.ts` marks `byMode('prototype')` tiles (minus the Live Artifact
picks) as governed, and `HomeHero.tsx` marks the `prototype` chip. Extend that
if another facet should also stay editorially curated.

## Curator override — `ALWAYS_PINNED`

`pluginPopularity.ts` also exports `ALWAYS_PINNED` (default **empty**): an
ordered id allowlist that ALWAYS leads, regardless of usage. It is the safety
valve for freshly launched or strategically promoted templates that have not
accrued usage yet (they would otherwise sink below the min-sample threshold).
Add an id and it jumps to the front; keep the list short.

## Refresh

The scores no longer refresh. They came from a weekly PostHog query, and telemetry
is removed, so `pluginPopularity.generated.ts` is a frozen snapshot of the last run.
The comparator and its policy knobs still apply to it.
