# jing.show for Codex

A Codex plugin for the jing.show tech timeline. It bundles:

```
codex/
  plugin.json                 # portable plugin manifest
  mcp.json                    # the read-only jing MCP server
  skills/jing-news/SKILL.md   # when and how to use the tools
```

The MCP server lives in the jingkan Worker at `https://jing.show/mcp` — a
stateless Streamable HTTP endpoint that answers plain JSON responses. It has
no authentication and exposes only read tools.

## Install the MCP server only (simplest)

The plugin adds a skill; the server alone is enough for ad-hoc questions:

```sh
codex mcp add jing --url https://jing.show/mcp
codex mcp list
```

Then ask Codex something like `总结一下 jing.show 今天的热点`. Remove it with
`codex mcp remove jing`.

## Install as a plugin

This repository is a Codex marketplace (`.agents/plugins/marketplace.json`):

```sh
codex plugin marketplace add lzz313/jing-show-plugins
codex plugin list
```

Install or enable `jing-show` from `/plugins` in Codex CLI (or the ChatGPT
Plugins tab). The marketplace key is `jing-show@jing-show-plugins`; a project
can enable it in `.codex/config.toml`:

```toml
[plugins."jing-show@jing-show-plugins"]
enabled = true
```

## Install from a local checkout (development)

```sh
cd jing-show-plugins
codex plugin marketplace add .
codex plugin add jing-show@jing-show-plugins
```

Remove the marketplace with `codex plugin marketplace remove jing-show-plugins`.

## Tools

| Tool | Returns |
| --- | --- |
| `list_sources` | 11 sources: id, name, home, `latestOnly`, update status |
| `get_feed` | compact latest / hot / rising items, counts, `nextCursor` |
| `get_item` | one item with body and Chinese translation (clipped) |
| `get_items` | up to 100 compact items, plus missing and removed ids |
| `get_context` | original text and discussion, budgeted to 12000 chars by default |
| `get_meta` | snapshot version, update time, source health |
| `get_daily_digest` | daily digest for a Beijing date, or the latest |

`get_context` is limited to 60 calls per IP per day. Everything else reuses the
public snapshot and is cheap.

## Notes

- The endpoint is stateless: no session id, no SSE stream, no `MCP-Session-Id`
  round trip. Clients that require SSE-only transport are not supported.
- Browser requests are origin-checked: `https://jing.show`, `www`, and
  `localhost` / `127.0.0.1` are allowed; CLIs send no Origin and are allowed.
- The skill tells the model to treat article text as untrusted and to cite the
  original URL.
- T3 Code has no plugin host of its own; see [`../t3/README.md`](../t3/README.md)
  for wiring the same MCP endpoint into the agents T3 runs.
