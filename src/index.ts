import {
  declaredTools,
  type PluginModule,
  type NotificationInput,
} from "@modera/plugin-sdk";
import manifest from "../plugin.json";

/** Optional model-facing publisher; the system owns all inboxes and run reminders. */
export const activate: PluginModule["activate"] = async (host) => {
  const publish = (
    input: NotificationInput,
    context: { projectId?: string; sessionId?: string; signal: AbortSignal },
  ) => {
    if (!host.notifications) throw Error("System notifications unavailable");
    return host.notifications.publish(
      {
        ...input,
        ...(context.sessionId
          ? {
              target: {
                type: "conversation" as const,
                sessionId: context.sessionId,
              },
            }
          : {}),
      },
      context,
    );
  };
  return {
    services: {
      "modera.notifications.delivery": {
        contract: "modera.notification-delivery",
        apiVersion: 1,
        methods: {
          show: {
            requiredPermissions: ["notifications.show"],
            async call(raw, context) {
              return publish(raw as NotificationInput, context);
            },
          },
        },
      },
    },
    tools: declaredTools(manifest).map((definition) => ({
      definition,
      async execute(raw, context) {
        const input = raw as { title: string; body: string };
        return publish({ title: input.title, body: input.body }, context);
      },
    })),
  };
};
