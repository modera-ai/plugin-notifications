import { expect, test, vi } from "vitest";
import { activate } from "../src/index";
import type { PluginContext } from "@modera/plugin-sdk";
test("optional plugin only publishes to the system; it owns no inbox or completion observer", async () => {
  const publish = vi.fn(async () => ({ id: "notice" }));
  const host = {
    notifications: { publish },
    signal: new AbortController().signal,
  } as unknown as PluginContext;
  const contribution = await activate(host);
  const context = {
    projectId: "project",
    sessionId: "session",
    runId: "run",
    signal: host.signal,
  };
  await contribution!.tools![0]!.execute(
    { title: "Ready", body: "Report" },
    context,
  );
  expect(publish).toHaveBeenCalledWith(
    {
      title: "Ready",
      body: "Report",
      target: { type: "conversation", sessionId: "session" },
    },
    context,
  );
  expect(contribution!.ui).toBeUndefined();
  expect(contribution!.runCompleted).toBeUndefined();
});
