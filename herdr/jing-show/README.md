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
  lib/jing-client.mjs  # synced from plugins/shared/
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

From a checkout of this repository instead, use
`cp -R "$PWD/plugins/herdr/jing-show" ~/.config/herdr-app/mods/jing-show` and
check `plugins/herdr/jing-show`.

After editing the mod, copy it again; the installed folder is an independent
copy. `mod.json` says `"place": "none"`: Herdr does not create a permanent
right column.

To uninstall, close its pane/tab and remove the folder:

```sh
rm -rf ~/.config/herdr-app/mods/jing-show
```

If you added the optional tab-bar button or the colorful pane-header logo,
clean those patches up too; `design/jing-show-install-uninstall.md` has the
exact lines.

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
`shared` and `spaces` from `herdr`, then add the command loop to `init` and the
shared toggle method. The pane remembers what was being read (view, source,
selected item) in `jing-show.session` and reports its own content size in
`jing-show.size`; the clone keeps the neighbour and side in
`jing-show.position`. Reopening restores all three:

```js
const JING_SIZE_KEY = "jing-show.size";
const JING_POS_KEY = "jing-show.position";
// layout.resize sizes the pane slot; the mod reports its content box, which
// leaves out the pane border (1 px each side) and, when stacked, the header.
const PANE_CHROME_W = 2;
const PANE_CHROME_H = 32;

init(_props, cx) {
  // ...existing init...
  this.lastToggle = 0;
  this.closing = null;

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

// Tab-bar button and Ctrl+Shift+J share this: close the jing.show pane in
// this tab (the focused one first), else split one in beside the pane it
// last sat next to — or the focused pane the first time. Panes in other
// tabs are never touched.
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
  const jingPanes = inTab.filter(p => p.mod === "jing-show");
  if (jingPanes.length) {
    if (this.closing) return;
    const focusedId = focused()?.pane;
    const pane = jingPanes.find(p => p.pane === focusedId)
      ?? jingPanes.find(p => p.focused)
      ?? jingPanes[0];
    this.closeJing(cx, pane);
    return;
  }

  const focusedId = focused()?.pane;
  const saved = shared(JING_POS_KEY);
  const savedTarget = typeof saved?.targetId === "string"
    ? inTab.find(p => p.pane === saved.targetId)
    : null;
  const target = savedTarget
    ?? inTab.find(p => p.pane === focusedId)
    ?? inTab.find(p => p.focused)
    ?? inTab[0];
  if (!target) {
    notify({ title: "jing.show", body: "当前标签页没有可拆分的 pane", level: "warning" });
    return;
  }

  const side = ["left", "right", "top", "bottom"].includes(saved?.side)
    ? saved.side
    : "right";
  // Read the size before the split: the new pane reports its default half
  // size as soon as it renders, and that must not replace the remembered one.
  const rememberedSize = shared(JING_SIZE_KEY);
  run("pane.split", {
    direction: side === "left" || side === "right" ? "right" : "down",
    pane: target.pane,
    mod: "jing-show",
  });
  this.restoreJingPlace(cx, tabId, target.pane, side, rememberedSize);
}

// The pane list can put a pane from the row above next to this one, and a
// pane beside a wide neighbour is nearly square, so neither the list order
// nor the pane's shape alone says which side it was split on. Stepping the
// keyboard focus one way names the pane actually there; focus comes back,
// then the pane closes. A clearly tall or wide pane only probes one axis; a
// nearly square one probes both.
closeJing(cx, jing) {
  this.closing = jing.pane;
  const before = focused()?.pane ?? null;
  const size = shared(JING_SIZE_KEY);
  let horizontalFirst;
  if (typeof size?.width === "number" && typeof size?.height === "number") {
    if (size.height >= size.width * 1.6) horizontalFirst = true;
    else if (size.width >= size.height * 1.6) horizontalFirst = false;
  }
  const directions = horizontalFirst === false
    ? ["up", "down", "left", "right"]
    : ["left", "right", "up", "down"];
  const around = {};
  let i = 0;
  const step = () => {
    const firstAxis = i >= 2 && (around[directions[0]] || around[directions[1]]);
    if (firstAxis || i >= directions.length) {
      if (before) run("pane.focus", { pane: before });
      this.saveJingPlace(jing, around);
      this.closing = null;
      run("pane.close", { pane: jing.pane });
      return;
    }
    const direction = directions[i++];
    run("pane.focus", { pane: jing.pane });
    cx.timer.after(40, () => {
      run("pane.go", { direction });
      cx.timer.after(40, () => {
        around[direction] = focused()?.pane ?? null;
        step();
      });
    });
  };
  step();
}

// The probes name the pane on each side of the one closing. The remembered
// side picks between two neighbours on the chosen axis; the pane's shape
// picks that axis, and an axis with no neighbour falls back to the other.
saveJingPlace(jing, around) {
  const neighbor = (id) => (typeof id === "string" && id !== jing.pane ? id : null);
  const left = neighbor(around.left);
  const right = neighbor(around.right);
  const up = neighbor(around.up);
  const down = neighbor(around.down);
  const previous = shared(JING_POS_KEY);
  const last = ["left", "right", "top", "bottom"].includes(previous?.side) ? previous.side : null;

  const horizontal = () => {
    if (left && right) return last === "left" ? ["left", right] : ["right", left];
    if (left) return ["right", left];
    if (right) return ["left", right];
    return null;
  };
  const vertical = () => {
    if (up && down) return last === "top" ? ["top", down] : ["bottom", up];
    if (up) return ["bottom", up];
    if (down) return ["top", down];
    return null;
  };

  const size = shared(JING_SIZE_KEY);
  let horizontalFirst;
  if (typeof size?.width === "number" && typeof size?.height === "number") {
    if (size.height >= size.width * 1.6) horizontalFirst = true;
    else if (size.width >= size.height * 1.6) horizontalFirst = false;
  }
  if (horizontalFirst === undefined) horizontalFirst = last !== "top" && last !== "bottom";
  const chosen = horizontalFirst ? horizontal() ?? vertical() : vertical() ?? horizontal();
  if (chosen) setShared(JING_POS_KEY, { targetId: chosen[1], side: chosen[0] });
}

// pane.split only adds a right/bottom child, and a new split starts at half
// the space. A pane that was closed on the left/top comes back beside the
// target and swaps places with it; then layout.resize (which takes a pane id
// too) restores the dimension the reader had dragged it to. The pane can take
// a moment to appear in panes(), and the split's own layout pass can land
// after it does, so place it now and resize again once things settle.
restoreJingPlace(cx, tabId, targetId, side, size) {
  const stacked = side === "top" || side === "bottom";
  const raw = stacked ? size?.height : size?.width;
  const px = Number.isFinite(raw)
    ? Math.round(Math.min(2000, Math.max(160, raw + (stacked ? PANE_CHROME_H : PANE_CHROME_W))))
    : null;
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
      if (side === "left" || side === "top") {
        run("pane.swap", { pane: jing.pane, target: targetId });
      }
      // A split started from a key or a click is focused by the split, but
      // the event's own focus handling lands back on the old pane when it
      // ends. Focus here, after the event, and tell the focusable copy to
      // take its focus handle, or j/k go to the terminal (or nowhere) until
      // the pane is clicked.
      run("pane.focus", { pane: jing.pane });
      run("jing-show.focus");
    }
    resize(jing);
  };

  place();
  if (px !== null) {
    cx.timer.after(150, () => { const j = panes().find(p => p.tab === tabId && p.mod === "jing-show"); if (j) resize(j); });
    cx.timer.after(700, () => { const j = panes().find(p => p.tab === tabId && p.mod === "jing-show"); if (j) resize(j); });
  }
}
```

`restoreJingPlace` is best-effort in a tab with several nested splits: a
remembered size larger than the split it lands in is clamped by Herdr, and a
pane beside a wide neighbour can land on the other axis. The list position
always restores. The two focus calls are what let `j`/`k` work straight after
the hotkey: the key event gives the pane focus and then hands it back to the
terminal it came from, and a focusable mod copy still has to take its own
focus handle (`jing-show`'s `focus` command). Without them the pane is open
but the list ignores keys until it is clicked. Closing walks the keyboard
focus through the neighbouring panes for a moment to learn the side; focus
comes back before the pane closes.

Then add this after the Files / Changes buttons, using the same method for the
button and the hotkey:

```js
const tabId = this.currentTabId();
const jingPane = panes().find(pane => pane.mod === "jing-show" && pane.tab === tabId);
const jingButton = h_flex().id("pane-jing-show").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
  .text_size(12).bg(jingPane ? t.selected : t.chrome).text_color(jingPane ? t.foreground : t.muted)
  .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
  .on_click(() => this.toggleJing())
  .child(image("mods/jing-show/logo-gray.png").size(14)).child("jing.show");
```

Add `.child(jingButton)` to the bar, and bind the app-level key in
`~/.config/herdr-app/keys.json` under `"global"`:

```json
"ctrl-shift-j": "tabs-jing.toggle-jing-show"
```

The button highlights while the pane is in the current tab; a second click or
`Ctrl+Shift+J` closes it. Opening moves keyboard focus into the pane, so the
list's `j`/`k` work at once; closing returns focus to the pane it came from.
Focused copy first, other tabs untouched. Closing also stores the
side/neighbour and the pane's own size, so the next open lands on the same
item, at the same size, beside the same pane. The hotkey is taken from
terminal programs while Herdr has focus, and it only reaches a layout that
mounts `tabs-jing`; in other layouts the key is swallowed with no effect.

After editing an already-mounted `tabs-jing`, switch to another layout and
back (or restart Herdr) to load the new code; the clone does not always reload
in place.

## Colorful mark in the pane header

The pane header comes from the shipped `pane` mod, whose icon slot normally
shows the program icon. Give the jing.show pane the colorful mark by editing
`mods/pane/main.js` (the installed copy, not this repo):

```js
const pic = p.mod === "jing-show" || p.title === "jing-show"
  ? image("mods/jing-show/logo.png").w(14).h(14).flex_none()
  : icon(p.program, 14, t.dim);
```

`image()` keeps the PNG's colors; `svg()` would use it as a tint mask. The
tab-bar button stays gray via `logo-gray.png`. An app update that replaces the
shipped `pane` mod also replaces this patch, so re-apply it after such an
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
list position (view, source, selected item) and the pane's size and side for
the next open; the state lives in Herdr's shared state
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

The feed header holds only the view tabs, the source chip and refresh; the
pane header already names the mod. English titles and summaries are kept, with
the Chinese translation on the next line. Title and summary lines share the
same font size.

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
Codex plugin is in `plugins/codex/`; T3 Code reaches it through the agents it
runs (`plugins/t3/README.md`). The pane and the MCP server share the public
feed snapshot, not the pane's reading session.

## Development

```sh
node scripts/sync-plugin-shared.mjs   # from the repo root, after editing the client
~/.local/bin/herdr-app check plugins/herdr/jing-show
~/.local/bin/herdr-app shot /tmp/herdr-jing.png
~/.local/bin/herdr-app status          # shows mod load errors
```

`herdr-app check` runs `init()` for real. The mod imports `checking()` and stops
before starting its fetch, timer or command loop, so a check renders one frame
without touching the network.
