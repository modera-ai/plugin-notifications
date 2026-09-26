import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate } from "../src/index";
import type { PluginContext } from "@modera/plugin-sdk";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
test("persists notifications despite unavailable desktop delivery and isolates projects", async () => {
  const storagePath = await mkdtemp(join(tmpdir(), "modera-notice-test-")); directories.push(storagePath);
  const signal = new AbortController().signal;
  const host = { pluginId: "modera.notifications", storagePath, grantedPermissions: new Set(), signal, notifications: { show: vi.fn().mockRejectedValue(new Error("OS disabled")) } } as unknown as PluginContext;
  const contribution = await activate(host);
  const tool = contribution!.tools![0]!;
  const context = { projectId: "one", sessionId: "session", runId: "run", signal };
  const result = await tool.execute({ action: "show", title: "Finished", body: "Result" }, context) as any;
  expect(result.desktop.supported).toBe(false);
  expect(await tool.execute({ action: "list" }, { ...context, projectId: "two" })).toEqual({ items: [] });
  await expect(tool.execute({ action: "read", id: result.item.id }, { ...context, projectId: "two" })).rejects.toThrow();
  await tool.execute({ action: "read", id: result.item.id }, context);
  const reloaded = await activate(host);
  const list = await reloaded!.tools![0]!.execute({ action: "list" }, context) as any;
  expect(list.items).toHaveLength(1); expect(list.items[0].read).toBe(true);
  await expect(tool.execute({ action: "show", title: "", body: "bad" }, context)).rejects.toThrow();
});
