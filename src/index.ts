import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { declaredTools, type PluginModule, type PluginNotification } from "@modera/plugin-sdk";
import manifest from "../plugin.json";

interface Notice extends PluginNotification {
  id: string; createdAt: string; read: boolean; projectId?: string; sessionId?: string; source: string;
}
export const activate: PluginModule["activate"] = async (host) => {
  await mkdir(host.storagePath, { recursive: true });
  const file = join(host.storagePath, "inbox.json");
  let inbox: Notice[] = [];
  try { inbox = JSON.parse(await readFile(file, "utf8")); if (!Array.isArray(inbox)) throw new Error("Invalid inbox"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let queue = Promise.resolve();
  function transact<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation); queue = result.then(() => {}, () => {}); return result;
  }
  async function save(next: Notice[]) {
    host.signal.throwIfAborted();
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next), "utf8");
    await rename(temporary, file); inbox = next;
    host.invalidateUi?.();
  }
  async function show(raw: unknown, source: string, scope: { projectId?: string; sessionId?: string; signal?: AbortSignal } = {}) {
    const input = raw as PluginNotification;
    if (!input || typeof input.title !== "string" || !input.title.trim() || input.title.length > 200 || typeof input.body !== "string" || input.body.length > 4000) throw new Error("Invalid notification text");
    scope.signal?.throwIfAborted();
    const item: Notice = { id: randomUUID(), createdAt: new Date().toISOString(), read: false, title: input.title, body: input.body, source, projectId: scope.projectId, sessionId: scope.sessionId };
    await transact(() => save([...inbox, item].slice(-500)));
    // Persist first: OS suppression/failure must not lose a notification.
    try { return { item, desktop: await host.notifications?.show(input, scope) ?? { supported: false } }; }
    catch (error) { return { item, desktop: { supported: false, error: String(error) } }; }
  }
  return {
    services: { "modera.notifications.delivery": { contract: "modera.notification-delivery", apiVersion: 1, methods: {
      show: { requiredPermissions: ["notifications.show"], call: (input, context) => show(input, context.caller, context) },
    } } },
    runCompleted: async (event, services) => {
      const config = await host.config?.read(event.projectId);
      if (config?.values.onCompletion === false) return;
      await show({ title: "Modera · 任务已结束", body: event.messages.filter((message) => message.role === "assistant").at(-1)?.text.slice(0, 500) || "任务已结束，可以返回查看结果。" }, "run", { ...event, signal: services.signal });
    },
    tools: declaredTools(manifest).map((definition) => ({ definition, async execute(raw, context) {
      const input = raw as { action: string; title: string; body: string; id: string };
      if (input.action === "show") return show(input, "user", context);
      if (input.action === "list") { await queue; return { items: inbox.filter((item) => item.projectId === context.projectId).slice().reverse() }; }
      if (input.action === "read") return transact(async () => {
        const target = inbox.find((item) => item.id === input.id && item.projectId === context.projectId);
        if (!target) throw new Error("Notification not found");
        await save(inbox.map((item) => item === target ? { ...item, read: true } : item));
        return { id: target.id, read: true };
      });
      throw new Error("Unknown notification action");
    } })),
  };
};
