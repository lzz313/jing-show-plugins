# jing.show in T3 Code

T3 Code is a control surface for coding agents, not an agent itself. It runs
the Claude Code, Codex and other CLIs already installed on the machine. As of
T3 Code 0.1.x it has no third-party plugin marketplace, so jing.show is not a
T3 plugin: it is an MCP server that the agents T3 runs connect to. Nothing in
this folder installs into T3; the setup is one config line in the agent.

T3's own MCP server (Settings → "Use T3 Code in another app") is unrelated: it
lets other tools drive T3. This page is about the other direction — T3's
agents reading jing.show.

## Claude Code inside T3

User-wide:

```sh
claude mcp add --transport http jing https://jing.show/mcp
claude mcp list
```

Or commit a project-level `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "jing": {
      "type": "http",
      "url": "https://jing.show/mcp"
    }
  }
}
```

Remove the user-wide entry with `claude mcp remove jing`.

## Codex inside T3

```sh
codex mcp add jing --url https://jing.show/mcp
codex mcp list
```

Or add it to the project's `.codex/config.toml`:

```toml
[mcp_servers.jing]
url = "https://jing.show/mcp"
```

Remove it with `codex mcp remove jing`. The Codex marketplace plugin in
[`../codex/`](../codex/) adds a `jing-news` skill on top of the same server,
but it is optional; the MCP tools work without it.

## Use it

Start a T3 thread with either agent and ask:

- `总结一下 jing.show 今天的热点`
- `jing.show 上 V2EX 今天有什么值得看的？`
- `查一下这条 HN 讨论的背景：<链接>`

The tools are read-only: `list_sources`, `get_feed`, `get_item`,
`get_items`, `get_context`, `get_meta`, `get_daily_digest`. The agent decides
which to call; the Codex skill (`codex/skills/jing-news/SKILL.md`) and
the endpoint's `initialize` instructions spell out the workflow and the
untrusted-content rule.

`get_context` is limited to 60 calls per IP per day; `get_feed` and the other
read tools reuse the public snapshot.

## When T3 ships a plugin host

T3 upstream has been prototyping a plugin system. If it lands, jing.show can
reuse the same MCP server and add a native panel later; nothing in the current
setup depends on T3 internals, so the agent configuration keeps working either
way.
