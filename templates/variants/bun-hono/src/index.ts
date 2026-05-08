import { Hono } from "hono";
import { AppError, createDefaultChatService, type ChatService } from "./chat/service";

export function createApp(service: ChatService) {
  const app = new Hono();

  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz", (context) => context.json({ status: "ok" }));
  app.get("/", (context) =>
    context.json({
      service: "{{SERVICE_NAME}}",
      domain: "chat",
      apiOrigin: "https://api.{{SERVICE_NAME}}.anmho.com",
    })
  );

  app.post("/v1/users", async (context) => {
    try {
      const body = await context.req.json();
      const user = await service.createUser({
        username: String(body.username ?? ""),
        displayName: body.display_name ?? body.displayName ?? null,
      });
      return context.json({ user }, 201);
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.get("/v1/users/:userId", async (context) => {
    try {
      return context.json({ user: await service.getUser(context.req.param("userId")) });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.get("/v1/users", async (context) => {
    try {
      const username = context.req.query("username") ?? "";
      return context.json({ user: await service.getUserByUsername(username) });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.post("/v1/conversations", async (context) => {
    try {
      const body = await context.req.json();
      const conversation = await service.createConversation({
        createdByUserId: String(body.created_by_user_id ?? body.createdByUserId ?? ""),
        title: body.title ?? null,
        participantUserIds: Array.isArray(body.participant_user_ids ?? body.participantUserIds)
          ? (body.participant_user_ids ?? body.participantUserIds).map(String)
          : [],
      });
      return context.json({ conversation }, 201);
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.get("/v1/conversations/:conversationId", async (context) => {
    try {
      return context.json({ conversation: await service.getConversation(context.req.param("conversationId")) });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.patch("/v1/conversations/:conversationId", async (context) => {
    try {
      const body = await context.req.json();
      return context.json({
        conversation: await service.updateConversation(context.req.param("conversationId"), {
          title: body.title ?? null,
        }),
      });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.delete("/v1/conversations/:conversationId", async (context) => {
    try {
      await service.deleteConversation(context.req.param("conversationId"));
      return context.body(null, 204);
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.post("/v1/conversations/:conversationId/participants", async (context) => {
    try {
      const body = await context.req.json();
      return context.json(
        {
          conversation: await service.addParticipant(
            context.req.param("conversationId"),
            String(body.user_id ?? body.userId ?? "")
          ),
        },
        201
      );
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.delete("/v1/conversations/:conversationId/participants/:userId", async (context) => {
    try {
      await service.removeParticipant(context.req.param("conversationId"), context.req.param("userId"));
      return context.body(null, 204);
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.get("/v1/conversations/:conversationId/messages", async (context) => {
    try {
      const limit = context.req.query("limit");
      const result = await service.listMessages(context.req.param("conversationId"), {
        cursor: context.req.query("cursor") ?? undefined,
        limit: limit == null ? undefined : Number(limit),
      });
      return context.json({
        messages: result.messages.map((message) => ({
          id: message.id,
          conversation_id: message.conversationId,
          user_id: message.userId,
          body: message.body,
          edited_at: message.editedAt,
          created_at: message.createdAt,
          updated_at: message.updatedAt,
          attachments: message.attachments.map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            content_type: attachment.contentType,
            byte_size: attachment.byteSize,
            status: attachment.status,
            public_url: attachment.publicUrl,
          })),
        })),
        ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
      });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.post("/v1/conversations/:conversationId/messages", async (context) => {
    try {
      const body = await context.req.json();
      return context.json(
        {
          message: await service.createMessage(context.req.param("conversationId"), {
            userId: String(body.user_id ?? body.userId ?? ""),
            body: String(body.body ?? ""),
          }),
        },
        201
      );
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.patch("/v1/conversations/:conversationId/messages/:messageId", async (context) => {
    try {
      const body = await context.req.json();
      return context.json({
        message: await service.updateMessage(
          context.req.param("conversationId"),
          context.req.param("messageId"),
          { body: String(body.body ?? "") }
        ),
      });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.delete("/v1/conversations/:conversationId/messages/:messageId", async (context) => {
    try {
      await service.deleteMessage(context.req.param("conversationId"), context.req.param("messageId"));
      return context.body(null, 204);
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.post("/v1/attachments/uploads", async (context) => {
    try {
      const body = await context.req.json();
      return context.json(
        {
          result: await service.createAttachmentUpload({
            conversationId: String(body.conversation_id ?? body.conversationId ?? ""),
            uploadedByUserId: String(body.user_id ?? body.userId ?? ""),
            filename: String(body.filename ?? ""),
            contentType: String(body.content_type ?? body.contentType ?? ""),
            byteSize: Number(body.byte_size ?? body.byteSize ?? 0),
          }),
        },
        201
      );
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.post("/v1/attachments/:attachmentId/finalize", async (context) => {
    try {
      const body = await context.req.json().catch(() => ({}));
      return context.json({
        attachment: await service.finalizeAttachment(context.req.param("attachmentId"), {
          messageId: body.message_id ?? body.messageId ?? null,
        }),
      });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.get("/v1/attachments/:attachmentId", async (context) => {
    try {
      return context.json({ attachment: await service.getAttachment(context.req.param("attachmentId")) });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.delete("/v1/attachments/:attachmentId", async (context) => {
    try {
      await service.deleteAttachment(context.req.param("attachmentId"));
      return context.body(null, 204);
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.post("/webhooks/:provider", async (context) => {
    try {
      const rawBody = await context.req.text();
      const result = await service.processWebhook(context.req.param("provider"), context.req.raw.headers, rawBody);
      return context.json(result, result.duplicate ? 200 : 202);
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.get("/webhooks/:provider/health", (context) => context.json({ status: "ok", provider: context.req.param("provider") }));

  return app;
}

function writeError(context: any, error: unknown) {
  if (error instanceof AppError) {
    return context.json({ error: error.message, code: error.code }, error.status);
  }
  return context.json({ error: error instanceof Error ? error.message : String(error) }, 500);
}

if (import.meta.main) {
  const app = createApp(createDefaultChatService());
  Bun.serve({
    port: Number(Bun.env.PORT ?? 8080),
    fetch: app.fetch,
  });
}
