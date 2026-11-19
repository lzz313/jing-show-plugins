# jing.show for Herdr

A Herdr pane for the jing.show timeline. It opens as a normal Herdr pane —
split it, drag it, zoom it, close it — reads the public `/api/feed` endpoint,
keeps the last response in Herdr's shared state, and summarizes the selected
item inline with the local fast model. No new tab, no agent session.

This is a Herdr **mod** (Herdr app 0.1.x), not the older `herdr-plugin.toml`
format:

```
mods/jing-show/
  main.js              # View subclass
  mod.json             # place none, 360 px, focusable
  logo.png             # colorful jing.show mark: pane header, "all" source
  logo-gray.png        # gray jing.show mark: tab-bar button
  logos/               # one brand logo per source, copied from web/public/logos
  lib/jing-client.mjs  # synced from shared/
```

## Install

The mod is also published in
[`lzz313/jing-show-plugins`](https://github.com/lzz313/jing-show-plugins)
under `herdr/jing-show/`. Herdr 0.1.x only sees real folders under `mods/`: a
symlinked mod directory is not listed by `tab.new --mod`, and per-file symlinks
fail with "resolves outside the application directory". Clone and copy the
folder instead:

```sh
git clone https://github.com/lzz313/jing-show-plugins.git
cd jing-show-plugins

rm -rf ~/.config/herdr-app/mods/jing-show
cp -R herdr/jing-show ~/.config/herdr-app/mods/jing-show
~/.local/bin/herdr-app check herdr/jing-show
~/.local/bin/herdr-app do tab.new --name "jing.show" --mod jing-show
```

From a checkout of the jingkan repository instead, copy
`plugins/herdr/jing-show` the same way and check that folder.

After editing the mod, copy it again; the installed folder is an independent
copy. `mod.json` says `"place": "none"`: Herdr does not create a permanent
right column.

To uninstall, close its pane/tab and remove the folder:

```sh
rm -rf ~/.config/herdr-app/mods/jing-show
```

If you added the optional tab-bar button or the colorful pane-header logo,
clean those patches up too; the jingkan repository's
`design/jing-show-install-uninstall.md` has the exact lines.

To open the pane once, without saving it in a layout:

```sh
~/.local/bin/herdr-app do pane.split '{"direction":"right","mod":"jing-show"}'
```

## Open and close it as a pane

`pane.split` creates a normal Herdr pane: it is saved with its tab, drags by
the top-center grip, and its header (hover the pane) offers split right,
split down, zoom and close. `mod.json` uses `"place": "none"`, so it never
becomes a permanent column.

```sh
~/.local/bin/herdr-app do pane.split '{"direction":"right","mod":"jing-show"}'
```

To get a toggle button in the tab bar, clone the shipped tabs mod under a
**new** name — Herdr hot-loads a brand-new mod folder immediately, while
reusing a name it has seen before falls back to the shipped tabs:

```sh
~/.local/bin/herdr-app do mod.clone '{"name":"tabs","as":"tabs-jing"}'
```

Point the layout's `tabs` block at the clone (`"content": {"mod": "tabs-jing"}`).
The clone hosts both the tab-bar button and the `Ctrl+Shift+J` toggle; a
command sent to `jing-show` itself cannot reopen a closed pane, because Herdr
delivers `<mod>.<command>` only to shown copies.

Import `checking`, `focused`, `nextCommand`, `notify`, `panes`, `run`, `setShared`,
`shared` and `spaces` from `herdr`, then add the command loop to `init` and
the shared toggle method. Hiding does not close the pane: `layout.resize` with
`px: 0` collapses its slot and leaves the split tree unchanged, so any sibling
shape — a full-height column, a pane in a grid, a sibling that is itself a
split of several panes — gives its space back and takes the same place again.
The pane remembers what was being read (view, source, selected item) in
`jing-show.session`, reports its content size in `jing-show.size` and its
exact extent (with the tab it belongs to) in `jing-show.extent`; the clone
keeps the hidden size per tab in `jing-show.hidden`. Records are keyed by tab,
not pane: pane ids change when the app restarts, while tab ids survive.

`layout.resize` runs `px` along the pane's parent split — a width in a row, a
height in a column. No API reports which, and a collapsed pane paints nothing,
so its own size report cannot tell while it is hidden either. Showing starts
from the axis learned last in that tab (`jing-show.axis`, a width by default,
since a new pane is split in from the right), then checks a fresh size report:
both remembered dimensions back means the guess was right; if not, the other
remembered size is tried and whichever dimension moves names the axis.

```js
const JING_SIZE_KEY = "jing-show.size";
const JING_EXTENT_KEY = "jing-show.extent";
const JING_HIDDEN_KEY = "jing-show.hidden";
// Which way the pane's parent split runs, by tab.
const JING_AXIS_KEY = "jing-show.axis";
// layout.resize sizes the pane slot; the mod reports its content box, which
// leaves out the pane border (1 px each side) and, when stacked, the header.
const PANE_CHROME_W = 2;
const PANE_CHROME_H = 32;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

init(_props, cx) {
  // ...existing init...
  this.lastToggle = 0;

  // `herdr-app check` runs init for real: render one frame, but do not wait
  // for a command no window will send.
  if (checking()) return;
  cx.spawn(async (cx) => {
    for (;;) {
      const command = await nextCommand();
      if (command === "toggle-jing-show") {
        this.toggleJing(cx);
        cx.notify();
      }
    }
  });
}

currentTabId() {
  return focused()?.tab ?? spaces().find(s => s.active)?.tabs.find(tab => tab.active)?.id;
}

// Tab-bar button and Ctrl+Shift+J share this: hide the jing.show pane in
// this tab (the focused one first), show the one hidden there, or split one
// in. Panes in other tabs are never touched.
toggleJing(cx) {
  const now = Date.now();
  if (now - this.lastToggle < 250) return;
  this.lastToggle = now;

  const tabId = this.currentTabId();
  if (!tabId) {
    notify({ title: "jing.show", body: "当前没有活动的标签页", level: "warning" });
    return;
  }

  const inTab = panes().filter(p => p.tab === tabId);
  const jing = inTab.find(p => p.mod === "jing-show" && p.focused)
    ?? inTab.find(p => p.mod === "jing-show");
  const hidden = this.hiddenPlaces();
  if (jing) {
    if (hidden[tabId]) this.showJing(cx, tabId, jing);
    else this.hideJing(cx, tabId, jing);
    return;
  }
  if (hidden[tabId]) {
    delete hidden[tabId];
    setShared(JING_HIDDEN_KEY, hidden);
  }
  this.createJing(cx, tabId, inTab);
}

// Hidden panes by tab, and the axis learned for each tab. Dead tabs are
// dropped; a tab's own record goes when it is shown again.
hiddenPlaces() {
  const value = shared(JING_HIDDEN_KEY);
  const hidden = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  const tabs = new Set(spaces().flatMap(s => s.tabs ?? []).map(t => t.id));
  for (const id of Object.keys(hidden)) {
    if (!tabs.has(id)) delete hidden[id];
  }
  return hidden;
}

axisPlaces() {
  const value = shared(JING_AXIS_KEY);
  const axes = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  const tabs = new Set(spaces().flatMap(s => s.tabs ?? []).map(t => t.id));
  for (const id of Object.keys(axes)) {
    if (!tabs.has(id)) delete axes[id];
  }
  return axes;
}

setAxis(tabId, axis) {
  const axes = this.axisPlaces();
  if (axes[tabId] === axis) return;
  axes[tabId] = axis;
  setShared(JING_AXIS_KEY, axes);
}

// The mod reports its exact content size; a readable one is what showing
// restores. Only this tab's report counts: several tabs can hold a copy.
paneExtent(tabId) {
  const extent = shared(JING_EXTENT_KEY);
  if (extent?.tab === tabId
    && typeof extent.width === "number" && typeof extent.height === "number"
    && extent.width >= 100 && extent.height >= 60) return extent;
  return null;
}

// pane.go walks the focus to a pane on that side; focus must leave a pane
// that is about to have no width, or the keys go nowhere visible.
focusNeighbor(cx, jing) {
  const directions = ["left", "right", "up", "down"];
  let i = 0;
  const step = () => {
    if (i >= directions.length) return;
    const direction = directions[i++];
    run("pane.go", { direction });
    cx.timer.after(30, () => {
      const pane = focused()?.pane;
      if (pane && pane !== jing.pane) return;
      step();
    });
  };
  step();
}

// Collapse the slot to 0 px: the pane keeps its place in the tree, and the
// other panes take the space. The mod re-reports its size on demand: a tab
// switch does not fire on_size_change, so the last report may be another
// tab's copy.
hideJing(cx, tabId, jing) {
  const inTab = panes().filter(p => p.tab === tabId);
  if (inTab.length < 2) return;
  run("jing-show.measure");
  cx.timer.after(120, () => {
    if (!panes().find(p => p.pane === jing.pane && p.tab === tabId)) return;
    this.collapseJing(cx, tabId, jing);
  });
}

collapseJing(cx, tabId, jing) {
  const size = this.paneExtent(tabId) ?? shared(JING_SIZE_KEY);
  const width = Math.round(size?.width ?? 0);
  const height = Math.round(size?.height ?? 0);
  if (focused()?.pane === jing.pane) this.focusNeighbor(cx, jing);
  run("layout.resize", { id: jing.pane, px: 0 });
  const hidden = this.hiddenPlaces();
  hidden[tabId] = { width, height, at: Date.now() };
  setShared(JING_HIDDEN_KEY, hidden);
}

// Show restores the slot along the split's axis: px is a width in a row and
// a height in a column. The axis starts from the one last learned here (a
// right split is how a pane is created), and is verified from a fresh size
// report: one that says the pane's fixed dimension came back is right.
showJing(cx, tabId, jing) {
  const hidden = this.hiddenPlaces();
  const record = hidden[tabId] ?? {};
  const size = shared(JING_SIZE_KEY);
  const width = Number.isFinite(record.width) && record.width > 0 ? record.width : size?.width;
  const height = Number.isFinite(record.height) && record.height > 0 ? record.height : size?.height;
  const px = (axis) => axis === "height"
    ? (Number.isFinite(height) ? Math.round(clamp(height + PANE_CHROME_H, 160, 2000)) : null)
    : (Number.isFinite(width) ? Math.round(clamp(width + PANE_CHROME_W, 160, 2000)) : null);
  const axis = this.axisPlaces()[tabId] === "height" ? "height" : "width";
  const value = px(axis);
  const before = shared(JING_EXTENT_KEY);
  if (value !== null) run("layout.resize", { id: jing.pane, px: value });
  delete hidden[tabId];
  setShared(JING_HIDDEN_KEY, hidden);
  // A split started from a key or a click is focused by the split, but the
  // event's own focus handling lands back on the old pane when it ends.
  // Focus here, after the event, or j/k go to the terminal until the pane
  // is clicked.
  cx.timer.after(60, () => {
    run("pane.focus", { pane: jing.pane });
    // The pane was focused, but its mod still has to take its own focus
    // handle: otherwise keys reach the pane and its view ignores them.
    run("jing-show.focus");
  });
  if (value !== null && Number.isFinite(width) && Number.isFinite(height)) {
    cx.timer.after(100, () => {
      run("jing-show.measure");
      this.checkAxis(cx, tabId, jing.pane, axis, value, width, height, before);
    });
  }
}

// A report that differs from the last one seen is this render: the pane is
// visible with its new size. Both remembered dimensions back means the
// guess was right. Otherwise the other remembered size is tried on the same
// axis; if the pane's other dimension lands on it, the split runs that way.
// If instead the guess's dimension moved, that px was on the right axis
// after all and the first size is put back. A collapsed pane's queued
// report can land late, so 0 reports are skipped and polling goes on.
checkAxis(cx, tabId, pane, axis, value, width, height, before) {
  const near = (a, b) => Math.abs(a - b) <= 6;
  const other = axis === "height" ? "width" : "height";
  const otherSize = other === "height" ? height : width;
  const otherPx = Math.round(clamp(
    otherSize + (other === "height" ? PANE_CHROME_H : PANE_CHROME_W), 160, 2000));
  // A hide (or a closed pane) while this runs ends the check: resizing a
  // collapsed pane would take it out of its slot without the record saying so.
  const live = () => !this.hiddenPlaces()[tabId]
    && Boolean(panes().find(p => p.pane === pane && p.tab === tabId));
  const poll = (prev, done) => {
    let attempts = 0;
    const look = () => {
      const extent = shared(JING_EXTENT_KEY);
      const fixed = axis === "height" ? extent?.height : extent?.width;
      // The mod bumps `seq` on every report, so a restore that lands on the
      // exact same size still counts as fresh instead of polling 20 times.
      const fresh = extent?.tab === tabId
        && Number.isFinite(extent.width) && Number.isFinite(extent.height)
        && Number.isFinite(fixed) && fixed > 0
        && ((extent.seq ?? 0) > (prev?.seq ?? 0)
          || extent.width !== prev?.width || extent.height !== prev?.height);
      if (fresh) {
        if (live()) done(extent);
        return;
      }
      if (++attempts <= 20) {
        cx.timer.after(100, () => { run("jing-show.measure"); look(); });
      }
    };
    look();
  };
  cx.timer.after(100, () => {
    if (!live()) return;
    poll(before, (first) => {
      if (near(first.width, width) && near(first.height, height)) {
        this.setAxis(tabId, axis);
        return;
      }
      if (!live()) return;
      run("layout.resize", { id: pane, px: otherPx });
      poll(first, (second) => {
        if (!live()) return;
        const landed = other === "height" ? second.height : second.width;
        if (near(landed, otherSize)) {
          this.setAxis(tabId, other);
          return;
        }
        run("layout.resize", { id: pane, px: value });
        this.setAxis(tabId, axis);
      });
    });
  });
}

// First open in this tab: split the focused pane to the right and give the
// new copy the width it last had. The pane can take a moment to appear in
// panes(), and the split's own layout pass can land after it does, so place
// it now and resize again once things settle.
createJing(cx, tabId, inTab) {
  const focusedId = focused()?.pane;
  const target = inTab.find(p => p.pane === focusedId)
    ?? inTab.find(p => p.focused)
    ?? inTab[0];
  if (!target) {
    notify({ title: "jing.show", body: "当前标签页没有可拆分的 pane", level: "warning" });
    return;
  }
  // Read the size before the split: the new pane reports its default half
  // width as soon as it renders, and that must not replace the remembered one.
  const size = shared(JING_SIZE_KEY);
  const px = Number.isFinite(size?.width)
    ? Math.round(clamp(size.width + PANE_CHROME_W, 160, 2000))
    : null;
  run("pane.split", { direction: "right", pane: target.pane, mod: "jing-show" });
  let placed = false;
  let attempts = 0;
  const resize = (jing) => {
    if (px !== null) run("layout.resize", { id: jing.pane, px });
  };
  const place = () => {
    const jing = panes().find(p => p.tab === tabId && p.mod === "jing-show");
    if (!jing) {
      if (++attempts <= 20) cx.timer.after(100, place);
      return;
    }
    if (!placed) {
      placed = true;
      run("pane.focus", { pane: jing.pane });
      run("jing-show.focus");
      // A fixed jing.show width must not size the tab: left without a
      // share, the sibling would give up its space and the whole tab would
      // shrink to the jing pane on every open.
      run("layout.resize", { id: target.pane, weight: 1 });
    }
    resize(jing);
  };
  place();
  if (px !== null) {
    cx.timer.after(150, () => {
      const jing = panes().find(p => p.tab === tabId && p.mod === "jing-show");
      if (jing) resize(jing);
    });
    cx.timer.after(700, () => {
      const jing = panes().find(p => p.tab === tabId && p.mod === "jing-show");
      if (jing) resize(jing);
    });
  }
}
```

The jing.show mod side is what makes the size exact: it reports its content
box from the root's `on_size_change` to `jing-show.size` and
`jing-show.extent` (with `focused()?.tab` and a monotonically increasing
`seq`), and its `measure` command re-asserts both keys, bumps `seq` and
renders once. The `seq` is what lets `checkAxis` treat a restore to the exact
same size as a fresh report. A size that has not changed since the last
report still has to reach the shared state before the collapse: another
tab's copy may have written it last. `herdr-app check` renders a throwaway
frame, so `rememberSize` returns early when `checking()`, and sizes too small
to read (a hidden or freshly split sliver) only update the extent, not the
size.

`layout.resize` takes the slot size, so the restored px adds the pane chrome
(2 px of side border; 32 px for a stacked pane's header and border) to the
content size. A remembered size larger than the split can hold is clamped by
Herdr; the axis check treats that as a mismatch and corrects from the report.
The first split in a tab gives the sibling `weight: 1` before the remembered
`px` goes on jing.show: with both sides fixed, the tab would size itself to
the panes instead of the window, and the main panel would shrink on every
open.

The two focus calls are what let `j`/`k` work straight after the hotkey: the
key event gives the pane focus and then hands it back to the terminal it came
from, and a focusable mod copy still has to take its own focus handle
(`jing-show`'s `focus` command). Without them the pane is open but the list
ignores keys until it is clicked. Hiding moves focus to a neighbour before
the collapse, so the keys do not stay on a pane with no width.

Then add this after the Files / Changes buttons, using the same method for the
button and the hotkey:

```js
const tabId = this.currentTabId();
const jingPane = panes().find(pane => pane.mod === "jing-show" && pane.tab === tabId);
const jingOn = Boolean(jingPane) && !shared(JING_HIDDEN_KEY)?.[tabId];
const jingButton = h_flex().id("pane-jing-show").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
  .text_size(12).bg(jingOn ? t.selected : t.chrome).text_color(jingOn ? t.foreground : t.muted)
  .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
  .on_click((_event, cx) => this.toggleJing(cx))
  .child(image("mods/jing-show/logo-gray.png").size(14)).child("jing.show");
```

Add `.child(jingButton)` to the bar, and bind the app-level key in
`~/.config/herdr-app/keys.json` under `"global"`:

```json
"ctrl-shift-j": "tabs-jing.toggle-jing-show"
```

The button highlights while the pane is in the current tab and not hidden; a
second click or `Ctrl+Shift+J` collapses it. Opening restores the same
slot and content size and moves keyboard focus into the pane, so the list's
`j`/`k` work at once; hiding moves focus to a neighbour. The focused copy is
handled first, and other tabs are untouched. The hotkey is taken from
terminal programs while Herdr has focus, and it only reaches a layout that
mounts `tabs-jing`; in other layouts the key is swallowed with no effect.

After editing an already-mounted `tabs-jing`, switch to another layout and
back (or restart Herdr) to load the new code; the clone does not always reload
in place.

## Name and colorful mark in the pane header

The pane header comes from the shipped `pane` mod, which titles a mod pane with
its folder name, so this one would read `jing-show`. Patch `mods/pane/main.js`
(the installed copy, not this repo) so the header shows the site's spelling:

```js
const name = p.mod === "jing-show"
  ? "jing.show"
  : ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
```

The same header normally shows the program icon, which a mod pane does not
have. For the colorful mark, patch its `pic` line too:

```js
const pic = p.mod === "jing-show" || p.title === "jing-show"
  ? image("mods/jing-show/logo.png").w(14).h(14).flex_none()
  : icon(p.program, 14, t.dim);
```

`image()` keeps the PNG's colors; `svg()` would use it as a tint mask. The
tab-bar button stays gray via `logo-gray.png`. An app update that replaces the
shipped `pane` mod also replaces these patches, so re-apply them after such an
update.

## Keys

| Key | Action |
| --- | --- |
| `j` / `↓`, `k` / `↑` | Move |
| `1` / `2` / `3` | Latest / Hot / Rising |
| `s` | Pick a source (list with counts; click, or `j`/`k` + `Enter`) |
| `m` | Pick the summary model and its reasoning level |
| `n` | Force the next page now (latest view only; usually automatic) |
| `r` | Refresh |
| `Enter` | Open the original link |
| `o` | Open the jing.show site in the browser at the current source filter |
| `y` | Copy the original link |
| `Shift+S` | Summarize the selected item in place with the local fast model |
| `?` | Show all shortcuts |

`j` / `k` stop at the last and first item instead of wrapping, and the source
and model pickers clamp the same way. At the last item `j` still asks for the
next latest page, so the list can grow downward but never jumps back to the
top.

`Ctrl+Shift+J` is app-level, not an in-pane key: it hides the jing.show pane
in the current tab, or opens one, from anywhere in Herdr. It is handled by the
optional `tabs-jing` clone described above, not by this mod. Hiding keeps the
list position (view, source, selected item) and the pane's slot size and place
in the split for the next open; the state lives in Herdr's shared state
(`~/.config/herdr-app/shared.json`), so it survives a Herdr restart.

The default view is **latest**; hot and rising are one key away. The pane
refreshes every 5 minutes, matching the feed's server cache. A refresh only
applies when `lastUpdated` or `dataVersion` changed; when pages have already
been auto-loaded, new items are merged on top and the older loaded pages stay
instead of snapping back to the first 30. `r` forces a fresh load.

`s` or a click on the source chip opens the source picker: every source, its
brand logo (or a letter tile when a logo is missing), and how many of the
loaded items it contributed. Click a row, or use `j`/`k` and
`Enter`; `Esc` or `s` closes it.

`m` opens the summary model picker. It lists the local router's models and,
for each, the reasoning levels it takes (`low` / `high` / `max`, and so on).
Choose a model, then a level; `默认（不指定）` leaves the level to the router.
A toast confirms the choice, and it applies to the next `Shift+S`. The picker and
the summary share one selection; `Esc` in the level list goes back to the
model list.

The feed header holds the view tabs, the source chip, refresh and a compact `↗`
button that opens jing.show itself; the pane header already names the mod.
English titles and summaries are kept, with the Chinese translation on the next
line. Title and summary lines share the same font size, and long text wraps to
as many lines as it needs instead of being cut at the pane's edge.

`↗` (or `o`) opens `https://jing.show/` for all sources, or
`https://jing.show/source/<id>` for the chosen one. The site has no per-item
page and no deep link for the view, so the selected item, latest/hot/rising and
the scroll position do not carry over; the site always opens on latest. `o`
does nothing while the source or model picker is open.

**latest** pages through the timeline 30 items at a time with the API's cursor.
There is no "load more" control: scrolling with the wheel or trackpad keeps
fetching the next page in the background, and so does moving the selection
within the last few items with `j`. The footer shows `· 加载中…` while a page
arrives, and paging stops on its own once the feed has no older page. `n` is
only a manual force. Hot and rising are single-page rankings and never page.
Changing the view, the source or refreshing starts again from the first page.

## Commands

```sh
~/.local/bin/herdr-app do jing-show.sources       # open the source picker
~/.local/bin/herdr-app do jing-show.source:v2ex   # pick a source
~/.local/bin/herdr-app do jing-show.view:hot      # latest | hot | rising
~/.local/bin/herdr-app do jing-show.model         # pick the summary model and level
~/.local/bin/herdr-app do jing-show.more          # load the next latest page
~/.local/bin/herdr-app do jing-show.refresh       # fetch again
~/.local/bin/herdr-app do jing-show.summarize     # summarize the selected item in place
~/.local/bin/herdr-app do tabs-jing.toggle-jing-show  # hide/show in this tab (tab-bar clone)
```

## Inline summary

`Shift+S` does not open another pane or agent tab. The selected item expands in
the current list, right under its content, and the answer streams into that
block. Only the model's text is rendered — no prompt, tool calls or agent
transcript. `Esc` collapses it, `Shift+S` summarizes again, and the rest of the
list keeps working (`j`/`k`, paging, refresh). A manual `r` or a view/source
change also clears the block.

The model call is local to Claude Code's model router:

- The picker lists the router's `GET /v1/models`: every model and the
  reasoning levels it takes.
- With no picker choice, the defaults come from `~/.claude/settings.json`:
  `env.ANTHROPIC_SMALL_FAST_MODEL` (the `[1m]` context suffix is stripped) and
  that model's `modelSettings.effortLevel`. This setup resolves to
  **auto/deepseek-v4.1-flash · high**.
- The selected level is posted as `output_config.effort` with adaptive
  thinking — the shape the router reads. The summary header and footer name
  both the model and the level; `默认（不指定）` sends no level.
- The choice is kept in Herdr's shared state, so it survives the pane
  reloading while the app runs.
- The prompt contains only the title, short summary, source, time and link. It
  marks the text as untrusted and tells the model not to execute instructions
  found in it.

The router must be running (Claude Code starts it locally at
`127.0.0.1:3425`); when it is not, the block shows a short connection error and
the feed itself keeps working.

## MCP

The same feed is available to local agents over the read-only MCP endpoint
`https://jing.show/mcp` (`codex mcp add jing --url https://jing.show/mcp`). The
Codex plugin is in [`codex/`](../../codex/); T3 Code reaches it through the
agents it runs ([`t3/README.md`](../../t3/README.md)). The pane and the MCP
server share the public
feed snapshot, not the pane's reading session.

## Development

```sh
node scripts/sync-plugin-shared.mjs   # from the repo root, after editing the client
~/.local/bin/herdr-app check herdr/jing-show
~/.local/bin/herdr-app shot /tmp/herdr-jing.png
~/.local/bin/herdr-app status          # shows mod load errors
```

`herdr-app check` runs `init()` for real. The mod imports `checking()` and stops
before starting its fetch, timer or command loop, so a check renders one frame
without touching the network.
