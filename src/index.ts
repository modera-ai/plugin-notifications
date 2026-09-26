import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  declaredTools,
  type PluginModule,
  type PluginNotification,
  type PluginUiNode,
} from "@modera/plugin-sdk";
import manifest from "../plugin.json";

interface Notice extends PluginNotification {
  id: string;
  createdAt: string;
  read: boolean;
  projectId?: string;
  sessionId?: string;
  source: string;
}
export const activate: PluginModule["activate"] = async (host) => {
  await mkdir(host.storagePath, { recursive: true });
  const file = join(host.storagePath, "inbox.json");
  let inbox: Notice[] = [];
  try {
    inbox = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(inbox)) throw new Error("Invalid inbox");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let queue = Promise.resolve();
  function transact<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function save(next: Notice[]) {
    host.signal.throwIfAborted();
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next), "utf8");
    await rename(temporary, file);
    inbox = next;
    host.invalidateUi?.();
  }
  async function show(
    raw: unknown,
    source: string,
    scope: {
      projectId?: string;
      sessionId?: string;
      signal?: AbortSignal;
    } = {},
  ) {
    const input = raw as PluginNotification;
    if (
      !input ||
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 200 ||
      typeof input.body !== "string" ||
      input.body.length > 4000
    )
      throw new Error("Invalid notification text");
    scope.signal?.throwIfAborted();
    const item: Notice = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      read: false,
      title: input.title,
      body: input.body,
      source,
      projectId: scope.projectId,
      sessionId: scope.sessionId,
    };
    await transact(() => save([...inbox, item].slice(-500)));
    // Persist first: OS suppression/failure must not lose a notification.
    try {
      return {
        item,
        desktop: (await host.notifications?.show(input, scope)) ?? {
          supported: false,
        },
      };
    } catch (error) {
      return { item, desktop: { supported: false, error: String(error) } };
    }
  }
  return {
    ui: [
      {
        id: "modera.notifications.panel",
        slot: "panel",
        launcher: {
          title: "通知 / Notifications",
          description: "查看任务结果和未读通知",
          icon: "box",
        },
        requiredPermissions: ["storage.read", "storage.write"],
        actions: ["read", "refresh"],
        async act(action, context) {
          if (action.id === "read")
            await transact(async () => {
              const item = inbox.find(
                (item) =>
                  item.id === action.value &&
                  item.projectId === context.projectId,
              );
              if (!item) throw new Error("Notification not found");
              await save(
                inbox.map((notice) =>
                  notice === item ? { ...notice, read: true } : notice,
                ),
              );
            });
        },
        async render(request, context) {
          await queue;
          const zh = request.locale.startsWith("zh");
          const items = inbox
            .filter((item) => item.projectId === context.projectId)
            .slice()
            .reverse();
          const children: PluginUiNode[] = [
            {
              type: "button",
              action: "refresh",
              label: zh ? "刷新" : "Refresh",
            },
          ];
          for (const item of items.slice(0, 30)) {
            children.push({
              type: "document",
              text: item.body,
              label: item.title,
              meta: `${item.read ? (zh ? "已读" : "Read") : zh ? "未读" : "Unread"} · ${item.createdAt}`,
            });
            if (item.sessionId)
              children.push({
                type: "conversation-link",
                label: zh ? "查看对话" : "Open conversation",
                sessionId: item.sessionId,
              });
            if (!item.read)
              children.push({
                type: "button",
                label: zh ? "标记已读" : "Mark read",
                action: "read",
                value: item.id,
                quiet: true,
              });
          }
          if (!items.length)
            children.push({
              type: "text",
              text: zh ? "暂无通知" : "No notifications",
            });
          return {
            title: zh ? "通知" : "Notifications",
            badge: String(items.filter((item) => !item.read).length),
            live: true,
            scroll: true,
            children,
          };
        },
      },
    ],
    services: {
      "modera.notifications.delivery": {
        contract: "modera.notification-delivery",
        apiVersion: 1,
        methods: {
          show: {
            requiredPermissions: ["notifications.show"],
            call: (input, context) => show(input, context.caller, context),
          },
        },
      },
    },
    runCompleted: async (event, services) => {
      const config = await host.config?.read(event.projectId);
      if (config?.values.onCompletion === false) return;
      await queue;
      const source = `run:${event.runId}`;
      if (
        inbox.some(
          (item) =>
            item.source === source &&
            item.projectId === event.projectId &&
            item.sessionId === event.sessionId,
        )
      )
        return;
      await show(
        {
          title:
            event.outcome === "failed"
              ? "Modera · 任务失败"
              : event.outcome === "cancelled"
                ? "Modera · 任务已取消"
                : "Modera · 任务已结束",
          body:
            event.messages
              .filter((message) => message.role === "assistant")
              .at(-1)
              ?.text.slice(0, 500) || "任务已结束，可以返回查看结果。",
        },
        source,
        { ...event, signal: services.signal },
      );
    },
    sessionDeleted: async (event) => {
      await transact(() =>
        save(
          inbox.filter(
            (item) =>
              item.sessionId !== event.sessionId ||
              item.projectId !== event.projectId,
          ),
        ),
      );
    },
    tools: declaredTools(manifest).map((definition) => ({
      definition,
      async execute(raw, context) {
        const input = raw as {
          action: string;
          title: string;
          body: string;
          id: string;
        };
        if (input.action === "show") return show(input, "user", context);
        if (input.action === "list") {
          await queue;
          return {
            items: inbox
              .filter((item) => item.projectId === context.projectId)
              .slice()
              .reverse(),
          };
        }
        if (input.action === "read")
          return transact(async () => {
            const target = inbox.find(
              (item) =>
                item.id === input.id && item.projectId === context.projectId,
            );
            if (!target) throw new Error("Notification not found");
            await save(
              inbox.map((item) =>
                item === target ? { ...item, read: true } : item,
              ),
            );
            return { id: target.id, read: true };
          });
        throw new Error("Unknown notification action");
      },
    })),
  };
};
