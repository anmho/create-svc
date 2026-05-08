package connectapi

import (
	"context"
	"net/http"

	"connectrpc.com/connect"

	chatv1 "{{MODULE_PATH}}/gen/chat/v1"
	chatv1connect "{{MODULE_PATH}}/gen/chat/v1/chatv1connect"
	"{{MODULE_PATH}}/internal/app"
)

type Handler struct {
	service *app.ChatService
}

func NewHandler(service *app.ChatService) (string, http.Handler) {
	return chatv1connect.NewChatServiceHandler(&Handler{service: service})
}

func (h *Handler) CreateUser(ctx context.Context, request *connect.Request[chatv1.CreateUserRequest]) (*connect.Response[chatv1.CreateUserResponse], error) {
	user, err := h.service.CreateUser(ctx, app.CreateUserInput{
		Username:    request.Msg.GetUsername(),
		DisplayName: request.Msg.GetDisplayName(),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.CreateUserResponse{User: toProtoUser(user)}), nil
}

func (h *Handler) GetUser(ctx context.Context, request *connect.Request[chatv1.GetUserRequest]) (*connect.Response[chatv1.GetUserResponse], error) {
	user, err := h.service.GetUser(ctx, request.Msg.GetUserId())
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.GetUserResponse{User: toProtoUser(user)}), nil
}

func (h *Handler) GetUserByUsername(ctx context.Context, request *connect.Request[chatv1.GetUserByUsernameRequest]) (*connect.Response[chatv1.GetUserByUsernameResponse], error) {
	user, err := h.service.GetUserByUsername(ctx, request.Msg.GetUsername())
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.GetUserByUsernameResponse{User: toProtoUser(user)}), nil
}

func (h *Handler) CreateConversation(ctx context.Context, request *connect.Request[chatv1.CreateConversationRequest]) (*connect.Response[chatv1.CreateConversationResponse], error) {
	conversation, err := h.service.CreateConversation(ctx, app.CreateConversationInput{
		CreatedByUserID:    request.Msg.GetCreatedByUserId(),
		Title:              request.Msg.GetTitle(),
		ParticipantUserIDs: request.Msg.GetParticipantUserIds(),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.CreateConversationResponse{Conversation: toProtoConversation(conversation)}), nil
}

func (h *Handler) GetConversation(ctx context.Context, request *connect.Request[chatv1.GetConversationRequest]) (*connect.Response[chatv1.GetConversationResponse], error) {
	conversation, err := h.service.GetConversation(ctx, request.Msg.GetConversationId())
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.GetConversationResponse{Conversation: toProtoConversation(conversation)}), nil
}

func (h *Handler) UpdateConversation(ctx context.Context, request *connect.Request[chatv1.UpdateConversationRequest]) (*connect.Response[chatv1.UpdateConversationResponse], error) {
	conversation, err := h.service.UpdateConversation(ctx, request.Msg.GetConversationId(), app.UpdateConversationInput{
		Title: request.Msg.GetTitle(),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.UpdateConversationResponse{Conversation: toProtoConversation(conversation)}), nil
}

func (h *Handler) DeleteConversation(ctx context.Context, request *connect.Request[chatv1.DeleteConversationRequest]) (*connect.Response[chatv1.DeleteConversationResponse], error) {
	if err := h.service.DeleteConversation(ctx, request.Msg.GetConversationId()); err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.DeleteConversationResponse{}), nil
}

func (h *Handler) AddConversationParticipant(ctx context.Context, request *connect.Request[chatv1.AddConversationParticipantRequest]) (*connect.Response[chatv1.AddConversationParticipantResponse], error) {
	conversation, err := h.service.AddParticipant(ctx, request.Msg.GetConversationId(), request.Msg.GetUserId())
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.AddConversationParticipantResponse{Conversation: toProtoConversation(conversation)}), nil
}

func (h *Handler) RemoveConversationParticipant(ctx context.Context, request *connect.Request[chatv1.RemoveConversationParticipantRequest]) (*connect.Response[chatv1.RemoveConversationParticipantResponse], error) {
	if err := h.service.RemoveParticipant(ctx, request.Msg.GetConversationId(), request.Msg.GetUserId()); err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.RemoveConversationParticipantResponse{}), nil
}

func (h *Handler) ListMessages(ctx context.Context, request *connect.Request[chatv1.ListMessagesRequest]) (*connect.Response[chatv1.ListMessagesResponse], error) {
	result, err := h.service.ListMessages(ctx, request.Msg.GetConversationId(), app.ListMessagesInput{
		Cursor: request.Msg.GetCursor(),
		Limit:  int(request.Msg.GetLimit()),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	items := make([]*chatv1.Message, 0, len(result.Messages))
	for _, message := range result.Messages {
		items = append(items, toProtoMessage(message))
	}
	return connect.NewResponse(&chatv1.ListMessagesResponse{
		Messages:   items,
		NextCursor: result.NextCursor,
	}), nil
}

func (h *Handler) CreateMessage(ctx context.Context, request *connect.Request[chatv1.CreateMessageRequest]) (*connect.Response[chatv1.CreateMessageResponse], error) {
	message, err := h.service.CreateMessage(ctx, request.Msg.GetConversationId(), app.CreateMessageInput{
		UserID: request.Msg.GetUserId(),
		Body:   request.Msg.GetBody(),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.CreateMessageResponse{Message: toProtoMessage(message)}), nil
}

func (h *Handler) UpdateMessage(ctx context.Context, request *connect.Request[chatv1.UpdateMessageRequest]) (*connect.Response[chatv1.UpdateMessageResponse], error) {
	message, err := h.service.UpdateMessage(ctx, request.Msg.GetConversationId(), request.Msg.GetMessageId(), app.UpdateMessageInput{
		Body: request.Msg.GetBody(),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.UpdateMessageResponse{Message: toProtoMessage(message)}), nil
}

func (h *Handler) DeleteMessage(ctx context.Context, request *connect.Request[chatv1.DeleteMessageRequest]) (*connect.Response[chatv1.DeleteMessageResponse], error) {
	if err := h.service.DeleteMessage(ctx, request.Msg.GetConversationId(), request.Msg.GetMessageId()); err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.DeleteMessageResponse{}), nil
}

func (h *Handler) CreateAttachmentUpload(ctx context.Context, request *connect.Request[chatv1.CreateAttachmentUploadRequest]) (*connect.Response[chatv1.CreateAttachmentUploadResponse], error) {
	result, err := h.service.CreateAttachmentUpload(ctx, app.CreateAttachmentUploadInput{
		ConversationID:   request.Msg.GetConversationId(),
		UploadedByUserID: request.Msg.GetUserId(),
		Filename:         request.Msg.GetFilename(),
		ContentType:      request.Msg.GetContentType(),
		ByteSize:         request.Msg.GetByteSize(),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.CreateAttachmentUploadResponse{
		Attachment: toProtoAttachment(result.Attachment),
		Upload: &chatv1.UploadTarget{
			Method:  result.Upload.Method,
			Url:     result.Upload.URL,
			Headers: result.Upload.Headers,
		},
	}), nil
}

func (h *Handler) FinalizeAttachment(ctx context.Context, request *connect.Request[chatv1.FinalizeAttachmentRequest]) (*connect.Response[chatv1.FinalizeAttachmentResponse], error) {
	attachment, err := h.service.FinalizeAttachment(ctx, request.Msg.GetAttachmentId(), app.FinalizeAttachmentInput{
		MessageID: request.Msg.GetMessageId(),
	})
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.FinalizeAttachmentResponse{Attachment: toProtoAttachment(attachment)}), nil
}

func (h *Handler) GetAttachment(ctx context.Context, request *connect.Request[chatv1.GetAttachmentRequest]) (*connect.Response[chatv1.GetAttachmentResponse], error) {
	attachment, err := h.service.GetAttachment(ctx, request.Msg.GetAttachmentId())
	if err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.GetAttachmentResponse{Attachment: toProtoAttachment(attachment)}), nil
}

func (h *Handler) DeleteAttachment(ctx context.Context, request *connect.Request[chatv1.DeleteAttachmentRequest]) (*connect.Response[chatv1.DeleteAttachmentResponse], error) {
	if err := h.service.DeleteAttachment(ctx, request.Msg.GetAttachmentId()); err != nil {
		return nil, toConnectError(err)
	}
	return connect.NewResponse(&chatv1.DeleteAttachmentResponse{}), nil
}

func toConnectError(err error) error {
	var appErr *app.AppError
	if ok := asAppError(err, &appErr); ok {
		return connect.NewError(statusCodeToConnectCode(appErr.Status), err)
	}
	return connect.NewError(connect.CodeInternal, err)
}

func asAppError(err error, target **app.AppError) bool {
	if err == nil {
		return false
	}
	appErr, ok := err.(*app.AppError)
	if ok {
		*target = appErr
		return true
	}
	return false
}

func statusCodeToConnectCode(status int) connect.Code {
	switch status {
	case 400:
		return connect.CodeInvalidArgument
	case 404:
		return connect.CodeNotFound
	case 409:
		return connect.CodeAlreadyExists
	default:
		return connect.CodeInternal
	}
}

func toProtoUser(user app.User) *chatv1.User {
	return &chatv1.User{
		Id:          user.ID,
		Username:    user.Username,
		DisplayName: user.DisplayName,
		CreatedAt:   user.CreatedAt,
		UpdatedAt:   user.UpdatedAt,
	}
}

func toProtoConversation(conversation app.Conversation) *chatv1.Conversation {
	participants := make([]*chatv1.User, 0, len(conversation.Participants))
	for _, participant := range conversation.Participants {
		participants = append(participants, toProtoUser(participant))
	}
	return &chatv1.Conversation{
		Id:              conversation.ID,
		Title:           conversation.Title,
		CreatedByUserId: conversation.CreatedByUserID,
		Participants:    participants,
		CreatedAt:       conversation.CreatedAt,
		UpdatedAt:       conversation.UpdatedAt,
	}
}

func toProtoMessage(message app.Message) *chatv1.Message {
	attachments := make([]*chatv1.MessageAttachment, 0, len(message.Attachments))
	for _, attachment := range message.Attachments {
		attachments = append(attachments, &chatv1.MessageAttachment{
			Id:          attachment.ID,
			Filename:    attachment.Filename,
			ContentType: attachment.ContentType,
			ByteSize:    attachment.ByteSize,
			Status:      attachment.Status,
			PublicUrl:   attachment.PublicURL,
		})
	}
	return &chatv1.Message{
		Id:             message.ID,
		ConversationId: message.ConversationID,
		UserId:         message.UserID,
		Body:           message.Body,
		EditedAt:       message.EditedAt,
		CreatedAt:      message.CreatedAt,
		UpdatedAt:      message.UpdatedAt,
		Attachments:    attachments,
	}
}

func toProtoAttachment(attachment app.Attachment) *chatv1.Attachment {
	return &chatv1.Attachment{
		Id:               attachment.ID,
		ConversationId:   attachment.ConversationID,
		MessageId:        attachment.MessageID,
		UploadedByUserId: attachment.UploadedByUserID,
		StorageBucket:    attachment.StorageBucket,
		StorageKey:       attachment.StorageKey,
		ContentType:      attachment.ContentType,
		ByteSize:         attachment.ByteSize,
		Filename:         attachment.Filename,
		Status:           attachment.Status,
		PublicUrl:        attachment.PublicURL,
		CreatedAt:        attachment.CreatedAt,
		UpdatedAt:        attachment.UpdatedAt,
	}
}
