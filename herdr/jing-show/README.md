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

Herdr 0.1.x only sees real folders under `mods/`: a symlinked mod directory is
not listed by `tab.new --mod`, and per-file symlinks fail with "resolves
outside the application directory". Copy the folder instead:

```sh
rm -rf ~/.config/herdr-app/mods/jing-show
cp -R "$PWD/herdr/jing-show" ~/.config/herdr-app/mods/jing-show
~/.local/bin/herdr-app check herdr/jing-show
~/.local/bin/herdr-app do tab.new --name "jing.show" --mod jing-show
```

After editing the mod, copy it again; the installed folder is an independent
copy. `mod.json` says `"place": "none"`: Herdr does not create a permanent
right column.

To uninstall, close its pane/tab and remove the folder:

```sh
rm -rf ~/.config/herdr-app/mods/jing-show
```

If you added the optional tab-bar button or the colorful pane-header logo,
clean those patches up too; see the notes below.

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

Point the layout's `tabs` block at the clone (`"content": {"mod": "tabs-jing"}`),
import `focused` from `herdr`, and add this after the Files / Changes buttons
in `mods/tabs-jing/main.js`:

```js
const tabId = focused()?.tab ?? spaces().find(s => s.active)?.tabs.find(tab => tab.active)?.id;
const jingPane = panes().find(pane => pane.mod === "jing-show" && pane.tab === tabId);
const jingButton = h_flex().id("pane-jing-show").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
  .text_size(12).bg(jingPane ? t.selected : t.chrome).text_color(jingPane ? t.foreground : t.muted)
  .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
  .on_click(() => {
    if (jingPane) run("pane.close", { pane: jingPane.pane });
    else run("pane.split", { direction: "right", mod: "jing-show" });
  })
  .child(image("mods/jing-show/logo-gray.png").size(14)).child("jing.show");
```

Then add `.child(jingButton)` to the bar. The button highlights while the pane
is in the current tab; a second click closes it.

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
~/.local/bin/herdr-app do jing-show.model         # pick the summary model and level
~/.local/bin/herdr-app do jing-show.more          # load the next latest page
~/.local/bin/herdr-app do jing-show.refresh       # fetch again
~/.local/bin/herdr-app do jing-show.summarize     # summarize the selected item in place
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
