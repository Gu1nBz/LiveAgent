package server

import (
	"encoding/json"
	"errors"
	"strings"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

func websocketConversationSummaryPayload(conversation *gatewayv1.ConversationSummary) map[string]any {
	if conversation == nil {
		return nil
	}

	return map[string]any{
		"id":            conversation.GetId(),
		"title":         conversation.GetTitle(),
		"created_at":    conversation.GetCreatedAt(),
		"updated_at":    conversation.GetUpdatedAt(),
		"message_count": conversation.GetMessageCount(),
		"provider_id":   conversation.GetProviderId(),
		"model":         conversation.GetModel(),
		"session_id":    conversation.GetSessionId(),
		"cwd":           conversation.GetCwd(),
		"is_pinned":     conversation.GetIsPinned(),
		"pinned_at":     conversation.GetPinnedAt(),
		"is_shared":     conversation.GetIsShared(),
	}
}

func websocketActiveChatRunSummariesPayload(summaries []session.ActiveChatRunSummary) []map[string]any {
	payload := make([]map[string]any, 0, len(summaries))
	for _, summary := range summaries {
		conversationID := strings.TrimSpace(summary.ConversationID)
		if conversationID == "" {
			continue
		}
		payload = append(payload, map[string]any{
			"conversation_id": conversationID,
			"cwd":             strings.TrimSpace(summary.Workdir),
			"updated_at":      summary.UpdatedAt,
		})
	}
	return payload
}

func websocketHistoryShareStatusPayload(share *gatewayv1.HistoryShareStatus) map[string]any {
	if share == nil {
		return nil
	}

	return map[string]any{
		"conversation_id":     share.GetConversationId(),
		"enabled":             share.GetEnabled(),
		"token":               share.GetToken(),
		"created_at":          share.GetCreatedAt(),
		"updated_at":          share.GetUpdatedAt(),
		"redact_tool_content": share.GetRedactToolContent(),
	}
}

func websocketHistorySyncPayload(event *gatewayv1.HistorySyncEvent) map[string]any {
	payload := map[string]any{
		"kind":            strings.TrimSpace(event.GetKind()),
		"conversation_id": strings.TrimSpace(event.GetConversationId()),
	}

	if conversation := event.GetConversation(); conversation != nil {
		payload["conversation"] = websocketConversationSummaryPayload(conversation)
	}

	return payload
}

func websocketSettingsSyncPayload(event *gatewayv1.SettingsSyncEvent) (map[string]any, error) {
	return websocketSettingsJSONPayload(event.GetSettingsJson())
}

func websocketSettingsJSONPayload(raw string) (map[string]any, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]any{}, nil
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return nil, errors.New("gateway settings payload is not valid JSON")
	}
	if payload == nil {
		return map[string]any{}, nil
	}
	return payload, nil
}

func websocketTerminalSessionPayload(session *gatewayv1.TerminalSession) map[string]any {
	if session == nil {
		return nil
	}
	kind := terminalSessionKind(session)
	payload := map[string]any{
		"id":               strings.TrimSpace(session.GetId()),
		"project_path_key": strings.TrimSpace(session.GetProjectPathKey()),
		"cwd":              strings.TrimSpace(session.GetCwd()),
		"shell":            strings.TrimSpace(session.GetShell()),
		"title":            strings.TrimSpace(session.GetTitle()),
		"kind":             kind,
		"pid":              session.GetPid(),
		"cols":             session.GetCols(),
		"rows":             session.GetRows(),
		"created_at":       session.GetCreatedAt(),
		"updated_at":       session.GetUpdatedAt(),
		"finished_at":      session.GetFinishedAt(),
		"exit_code":        session.GetExitCode(),
		"running":          session.GetRunning(),
	}
	if session.GetPid() == 0 {
		payload["pid"] = nil
	}
	if session.GetFinishedAt() == 0 {
		payload["finished_at"] = nil
	}
	if kind == "ssh" {
		payload["pid"] = nil
	}
	if ssh := session.GetSsh(); ssh != nil {
		payload["ssh"] = map[string]any{
			"host_id":                strings.TrimSpace(ssh.GetHostId()),
			"host_name":              strings.TrimSpace(ssh.GetHostName()),
			"username":               strings.TrimSpace(ssh.GetUsername()),
			"host":                   strings.TrimSpace(ssh.GetHost()),
			"port":                   ssh.GetPort(),
			"auth_type":              strings.TrimSpace(ssh.GetAuthType()),
			"status":                 strings.TrimSpace(ssh.GetStatus()),
			"reconnect_attempt":      ssh.GetReconnectAttempt(),
			"reconnect_max_attempts": ssh.GetReconnectMaxAttempts(),
		}
	}
	return payload
}

func terminalSessionKind(session *gatewayv1.TerminalSession) string {
	kind := strings.TrimSpace(session.GetKind())
	if kind == "ssh" {
		return "ssh"
	}
	return "local"
}

func websocketTerminalShellOptionPayload(option *gatewayv1.TerminalShellOption) map[string]any {
	if option == nil {
		return nil
	}
	return map[string]any{
		"id":      strings.TrimSpace(option.GetId()),
		"label":   strings.TrimSpace(option.GetLabel()),
		"command": strings.TrimSpace(option.GetCommand()),
	}
}

func websocketTerminalResponsePayload(resp *gatewayv1.TerminalResponse) map[string]any {
	sessions := make([]map[string]any, 0, len(resp.GetSessions()))
	for _, session := range resp.GetSessions() {
		if payload := websocketTerminalSessionPayload(session); payload != nil {
			sessions = append(sessions, payload)
		}
	}
	shellOptions := make([]map[string]any, 0, len(resp.GetShellOptions()))
	for _, option := range resp.GetShellOptions() {
		if payload := websocketTerminalShellOptionPayload(option); payload != nil {
			shellOptions = append(shellOptions, payload)
		}
	}
	payload := map[string]any{
		"action":        strings.TrimSpace(resp.GetAction()),
		"sessions":      sessions,
		"output":        resp.GetOutput(),
		"truncated":     resp.GetTruncated(),
		"shell_options": shellOptions,
		"default_shell": resp.GetDefaultShell(),
	}
	if resp.GetOutputStartOffset() != 0 || resp.GetOutputEndOffset() != 0 || resp.GetOutput() != "" {
		payload["output_start_offset"] = resp.GetOutputStartOffset()
		payload["output_end_offset"] = resp.GetOutputEndOffset()
	}
	if resp.GetLatencyMs() > 0 {
		payload["latency_ms"] = resp.GetLatencyMs()
	}
	if session := websocketTerminalSessionPayload(resp.GetSession()); session != nil {
		payload["session"] = session
	}
	if prompt := resp.GetSshPrompt(); prompt != nil {
		payload["ssh_prompt"] = map[string]any{
			"id":                 strings.TrimSpace(prompt.GetId()),
			"kind":               strings.TrimSpace(prompt.GetKind()),
			"host_id":            strings.TrimSpace(prompt.GetHostId()),
			"host_name":          strings.TrimSpace(prompt.GetHostName()),
			"host":               strings.TrimSpace(prompt.GetHost()),
			"port":               prompt.GetPort(),
			"message":            strings.TrimSpace(prompt.GetMessage()),
			"fingerprint_sha256": strings.TrimSpace(prompt.GetFingerprintSha256()),
			"key_type":           strings.TrimSpace(prompt.GetKeyType()),
			"answer_echo":        prompt.GetAnswerEcho(),
		}
	}
	return payload
}

func websocketTerminalEventPayload(event *gatewayv1.TerminalEvent) map[string]any {
	payload := map[string]any{
		"kind":             strings.TrimSpace(event.GetKind()),
		"session_id":       strings.TrimSpace(event.GetSessionId()),
		"project_path_key": strings.TrimSpace(event.GetProjectPathKey()),
		"data":             event.GetData(),
	}
	if event.GetOutputStartOffset() != 0 || event.GetOutputEndOffset() != 0 || event.GetData() != "" {
		payload["output_start_offset"] = event.GetOutputStartOffset()
		payload["output_end_offset"] = event.GetOutputEndOffset()
	}
	if session := websocketTerminalSessionPayload(event.GetSession()); session != nil {
		payload["session"] = session
	}
	return payload
}

func websocketMemoryResultPayload(raw string) (any, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]any{}, nil
	}

	var payload any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return nil, errors.New("gateway memory response is not valid JSON")
	}
	if payload == nil {
		return map[string]any{}, nil
	}
	return payload, nil
}

func websocketGitResultPayload(raw string) (any, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]any{}, nil
	}
	var payload any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return nil, errors.New("gateway git response is not valid JSON")
	}
	if payload == nil {
		return map[string]any{}, nil
	}
	return payload, nil
}

func websocketRawPayloadJSON(raw json.RawMessage) (string, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return "{}", nil
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return "", errors.New("invalid settings.update payload")
	}
	if payload == nil {
		return "{}", nil
	}

	normalized, err := json.Marshal(payload)
	if err != nil {
		return "", errors.New("invalid settings.update payload")
	}
	return string(normalized), nil
}

func nullableTrimmedString(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func websocketOptionalUint32(value *int, field string) (uint32, error) {
	if value == nil {
		return 0, nil
	}
	if *value < 0 {
		return 0, errors.New(field + " must be >= 0")
	}
	return uint32(*value), nil
}
