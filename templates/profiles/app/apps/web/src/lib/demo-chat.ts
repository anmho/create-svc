import { createChatClient } from "./rpc";

export async function createDemoChat() {
  const client = createChatClient();
  const suffix = Date.now().toString(36);
  const userResponse = await client.createUser({
    username: `web-${suffix}`,
    displayName: "Web Demo",
  });
  if (!userResponse.user) {
    throw new Error("CreateUser returned no user");
  }

  const conversationResponse = await client.createConversation({
    createdByUserId: userResponse.user.id,
    title: "Agent-first workspace",
    participantUserIds: [userResponse.user.id],
  });
  if (!conversationResponse.conversation) {
    throw new Error("CreateConversation returned no conversation");
  }

  const messageResponse = await client.createMessage({
    conversationId: conversationResponse.conversation.id,
    userId: userResponse.user.id,
    body: "Hello from ConnectRPC.",
  });
  if (!messageResponse.message) {
    throw new Error("CreateMessage returned no message");
  }

  return {
    user: userResponse.user,
    conversation: conversationResponse.conversation,
    message: messageResponse.message,
  };
}
