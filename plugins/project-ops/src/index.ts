import { Type } from "typebox";
import {
  definePluginEntry,
  type OpenClawPluginToolContext,
  type PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { callBroker, type Actor } from "./client.js";

const WECHAT_CHANNEL = "openclaw-weixin";

function trustedActor(context: OpenClawPluginToolContext): Actor {
  const route = context.deliveryContext;
  const requesterSenderId = context.requesterSenderId?.trim();
  if (context.messageChannel !== WECHAT_CHANNEL || !context.senderIsOwner) {
    throw new Error("project operations are available only to the bound owner in a private WeChat conversation");
  }
  // The Weixin adapter can authorize the owner from the direct-message `From`
  // field without projecting it as requesterSenderId. In that case, accept only
  // the matching private delivery route; the broker still independently checks
  // the resulting senderId against its owner credential.
  if (route?.channel !== WECHAT_CHANNEL || !route.to || route.threadId !== undefined) {
    throw new Error("project operations are available only to the bound owner in a private WeChat conversation");
  }
  if (requesterSenderId && requesterSenderId !== route.to) {
    throw new Error("project operation requester does not match the private delivery route");
  }
  return {
    senderId: requesterSenderId ?? route.to,
    channel: context.messageChannel,
    senderIsOwner: true,
  };
}

function commandActor(context: PluginCommandContext): Actor {
  if (context.channel !== WECHAT_CHANNEL || !context.isAuthorizedSender || !context.senderIsOwner || !context.senderId) {
    throw new Error("/approve is available only to the bound WeChat owner");
  }
  return { senderId: context.senderId, channel: context.channel, senderIsOwner: true };
}

function result(details: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

const ProjectId = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]*$" });
const ApprovalId = Type.String({ minLength: 36, maxLength: 96, pattern: "^[a-zA-Z0-9._-]+$" });

export default definePluginEntry({
  id: "project-ops",
  name: "Project Operations",
  description: "Approval-gated operations for a fixed server project allowlist",
  register(api) {
    api.registerTool((context) => ({
      name: "project_list",
      label: "List managed projects",
      description: "List explicitly allowed server projects and their supported actions.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return result(await callBroker("/v1/projects/list", { actor: trustedActor(context) }));
      },
    }), { name: "project_list" });

    api.registerTool((context) => ({
      name: "project_status",
      label: "Inspect project status",
      description: "Read service, Git, health, and source fingerprint status without changing the project.",
      parameters: Type.Object({ projectId: ProjectId }, { additionalProperties: false }),
      async execute(_id, params) {
        return result(await callBroker("/v1/projects/status", { ...(params as Record<string, unknown>), actor: trustedActor(context) }));
      },
    }), { name: "project_status" });

    api.registerTool((context) => ({
      name: "project_change_prepare",
      label: "Prepare a project change",
      description: "Freeze a development, apply, service lifecycle, deployment, or rollback preview. Never executes the change.",
      parameters: Type.Object({
        projectId: ProjectId,
        kind: Type.Union([
          Type.Literal("develop"), Type.Literal("apply"), Type.Literal("start"), Type.Literal("stop"),
          Type.Literal("restart"), Type.Literal("deploy"), Type.Literal("rollback"),
        ]),
        request: Type.String({ minLength: 1, maxLength: 4096 }),
        stageId: Type.Optional(ApprovalId),
        snapshotId: Type.Optional(ApprovalId),
      }, { additionalProperties: false }),
      async execute(_id, params) {
        return result(await callBroker("/v1/approvals/prepare", { ...(params as Record<string, unknown>), actor: trustedActor(context) }));
      },
    }), { name: "project_change_prepare" });

    api.registerTool((context) => ({
      name: "project_change_apply",
      label: "Apply an approved change",
      description: "Execute a frozen approval only after the owner has allowed it with /approve. Replays and changed sources fail closed.",
      parameters: Type.Object({ approvalId: ApprovalId }, { additionalProperties: false }),
      async execute(_id, params) {
        return result(await callBroker("/v1/approvals/execute", { ...(params as Record<string, unknown>), actor: trustedActor(context) }));
      },
      executionMode: "sequential",
    }), { name: "project_change_apply" });

    api.registerTool((context) => ({
      name: "project_change_result",
      label: "Read a failed project change result",
      description: "Read the bounded, redacted failure result for one owner-bound approval without changing its state.",
      parameters: Type.Object({ approvalId: ApprovalId }, { additionalProperties: false }),
      async execute(_id, params) {
        return result(await callBroker("/v1/approvals/result", {
          ...(params as Record<string, unknown>),
          actor: trustedActor(context),
        }));
      },
    }), { name: "project_change_result" });

    api.registerTool((context) => ({
      name: "project_rollback",
      label: "Prepare rollback",
      description: "Prepare (but do not execute) an owner approval for a registered rollback snapshot.",
      parameters: Type.Object({
        projectId: ProjectId,
        snapshotId: ApprovalId,
        request: Type.Optional(Type.String({ maxLength: 1024 })),
      }, { additionalProperties: false }),
      async execute(_id, rawParams) {
        const params = rawParams as { projectId: string; snapshotId: string; request?: string };
        return result(await callBroker("/v1/approvals/prepare", {
          projectId: params.projectId,
          kind: "rollback",
          snapshotId: params.snapshotId,
          request: params.request ?? `Rollback snapshot ${params.snapshotId}`,
          actor: trustedActor(context),
        }));
      },
    }), { name: "project_rollback" });

    api.registerCommand({
      name: "approve",
      description: "Approve or deny one frozen project operation: /approve <id> allow|deny",
      acceptsArgs: true,
      requireAuth: true,
      requiredScopes: ["operator.approvals"],
      channels: [WECHAT_CHANNEL],
      async handler(context) {
        const match = context.args?.trim().match(/^([a-zA-Z0-9._-]{1,96})\s+(allow|deny)$/);
        if (!match) return { text: "用法：/approve <id> allow|deny" };
        const actor = commandActor(context);
        const approvalId = match[1]!;
        const decision = match[2]!;
        const decided = await callBroker<Record<string, unknown>>("/v1/approvals/decide", { approvalId, decision, actor });
        if (decision === "deny") return { text: `已拒绝审批 ${approvalId}` };
        const accepted = await callBroker<Record<string, unknown>>("/v1/approvals/execute", { approvalId, actor });
        return { text: `审批已进入异步执行：\n${JSON.stringify(accepted, null, 2)}` };
      },
    });
  },
});
