#!/opt/homebrew/bin/bun
// Stand-in for `claude -p --output-format stream-json` in test/chat.test.ts.
// Never calls a model. Behaviour depends on the prompt read from stdin:
//   "colgar" → prints init, ignores SIGINT and hangs (stop escalation test)
//   anything else → init, one text delta echoing the prompt, a result whose
//   `result` field carries argv and stdin so the test can inspect them.
const argv = process.argv.slice(2);
const stdin = await new Response(Bun.stdin.stream()).text();
const out = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
const resumed = argv.includes("--resume");

out({ type: "system", subtype: "init", session_id: "s-fake", model: "fake-sonnet", permissionMode: "dontAsk",
  mcp_servers: [{ name: "cerebro", status: "connected" }], tools: ["mcp__cerebro__search", "mcp__cerebro__get_page"] });

if (stdin === "colgar") {
  process.on("SIGINT", () => { /* ignore: the panel must escalate to SIGTERM */ });
  setInterval(() => {}, 1000);
} else {
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "eco: " + stdin } } });
  out({ type: "assistant", message: { id: "m1", model: "fake-sonnet", content: [{ type: "text", text: "eco: " + stdin }] } });
  // Cumulative like claude 2.1.308: a resumed session carries the earlier total.
  out({ type: "result", subtype: "success", session_id: "s-fake", duration_ms: 5, total_cost_usd: resumed ? 0.03 : 0.01,
    permission_denials: [], result: JSON.stringify({ argv, stdin, envKeys: Object.keys(process.env).sort() }) });
}
