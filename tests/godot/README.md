# Actual-engine signal regressions

Copy `project.godot`, `bridge.gd`, `signals.gd` from this directory and
`src/scripts/mcp_interaction_server.gd` into one disposable directory. Run your
verified Godot4 executable with `--headless --path <directory> --script signals.gd`.
The process must exit0 with `SIGNAL_REGRESSIONS_PASS`; parse errors or a timeout
are failures. No MCP listener, product project or running game is used.

The fixture overrides only transport/ready callbacks and executes the real signal
handler. It checks zero/one/four/nine arguments, Unicode/nested/vector payloads,
actual timeout, malformed timeout, missing node/signal, source deletion, connection
cleanup, game time-scale independence and suppression after request replacement or
disconnect. Live proxy-route testing still needs a separate disposable game/session.
