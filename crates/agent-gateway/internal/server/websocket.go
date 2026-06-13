package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/websocket"

	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

type websocketRequest struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type websocketEnvelope struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Payload any    `json:"payload,omitempty"`
	Error   string `json:"error,omitempty"`
}

type websocketAuthPayload struct {
	Token string `json:"token"`
}

type websocketChatResumePayload struct {
	RequestID      string `json:"request_id"`
	ConversationID string `json:"conversation_id"`
	AfterSeq       int64  `json:"after_seq"`
}

type websocketChatAttachPayload struct {
	ConversationID string `json:"conversation_id"`
	AfterSeq       int64  `json:"after_seq"`
}

type websocketChatDetachPayload struct {
	RequestID string `json:"request_id"`
}

type websocketTerminalRequestPayload struct {
	SessionID      string `json:"session_id"`
	ProjectPathKey string `json:"project_path_key"`
	Cwd            string `json:"cwd"`
	Shell          string `json:"shell"`
	Title          string `json:"title"`
	Data           string `json:"data"`
	Cols           *int   `json:"cols"`
	Rows           *int   `json:"rows"`
	MaxBytes       *int   `json:"max_bytes"`
	SshHostID      string `json:"ssh_host_id"`
	PromptID       string `json:"prompt_id"`
	PromptAnswer   string `json:"prompt_answer"`
	TrustHostKey   bool   `json:"trust_host_key"`
}

type websocketSshKnownHostResetPayload struct {
	Host string `json:"host"`
	Port *int   `json:"port"`
}

type websocketGitRequestPayload struct {
	Workdir string          `json:"workdir"`
	Args    json.RawMessage `json:"args,omitempty"`
}

type websocketChatState struct {
	cancel          context.CancelFunc
	conversationID  string
	sourceRequestID string
}

type websocketConnection struct {
	cfg *config.Config
	sm  *session.Manager

	conn *websocket.Conn

	writer     *websocketConnectionWriter
	closeOnce  sync.Once
	done       chan struct{}
	authorized bool

	historyEvents         <-chan *gatewayv1.HistorySyncEvent
	historyEventsCleanup  func()
	settingsEvents        <-chan *gatewayv1.SettingsSyncEvent
	settingsEventsCleanup func()
	terminalEvents        <-chan *gatewayv1.TerminalEvent
	terminalEventsCleanup func()
	chatEvents            <-chan *session.ChatBroadcastEvent
	chatEventsCleanup     func()
	heartbeatOnce         sync.Once

	chatTracker      *websocketChatTracker
	terminalInterest *websocketTerminalInterestTracker
}

const recentActiveChatRetention = 5 * time.Second
const maxHistoryListLimit = 200
const defaultHistoryListPage = 1
const defaultHistoryListPageSize = 80

func NewWebSocketServer(cfg *config.Config, sm *session.Manager) http.Handler {
	server := &websocket.Server{
		Handshake: func(_ *websocket.Config, _ *http.Request) error {
			return nil
		},
		Handler: websocket.Handler(func(conn *websocket.Conn) {
			state := &websocketConnection{
				cfg:              cfg,
				sm:               sm,
				conn:             conn,
				writer:           newWebsocketConnectionWriter(conn, cfg.WebSocketWriteTimeout),
				done:             make(chan struct{}),
				chatTracker:      newWebsocketChatTracker(),
				terminalInterest: newWebsocketTerminalInterestTracker(),
			}
			defer state.close()
			state.serve()
		}),
	}
	return server
}

func (c *websocketConnection) serve() {
	for {
		var req websocketRequest
		if err := websocket.JSON.Receive(c.conn, &req); err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			return
		}

		req.ID = strings.TrimSpace(req.ID)
		req.Type = strings.TrimSpace(req.Type)
		if req.Type == "pong" {
			continue
		}
		if req.ID == "" {
			_ = c.writeError("", "request id is required")
			continue
		}
		if req.Type == "" {
			_ = c.writeError(req.ID, "request type is required")
			continue
		}

		if req.Type == "auth" {
			c.handleAuth(req)
			continue
		}

		if !c.authorized {
			_ = c.writeError(req.ID, "unauthorized")
			continue
		}

		go c.dispatch(req)
	}
}

func (c *websocketConnection) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		if c.historyEventsCleanup != nil {
			c.historyEventsCleanup()
			c.historyEventsCleanup = nil
		}
		if c.settingsEventsCleanup != nil {
			c.settingsEventsCleanup()
			c.settingsEventsCleanup = nil
		}
		if c.terminalEventsCleanup != nil {
			c.terminalEventsCleanup()
			c.terminalEventsCleanup = nil
		}
		if c.chatEventsCleanup != nil {
			c.chatEventsCleanup()
			c.chatEventsCleanup = nil
		}
		activeAttachments := c.releaseAllActiveChatAttachments()
		for _, cancel := range activeAttachments {
			cancel()
		}
		activeChats := c.releaseAllActiveChats()
		for _, chat := range activeChats {
			chat.cancel()
		}
		_ = c.conn.Close()
	})
}

func (c *websocketConnection) handleAuth(req websocketRequest) {
	var payload websocketAuthPayload
	if err := decodeWebSocketPayload(req.Payload, &payload); err != nil {
		_ = c.writeError(req.ID, "invalid auth payload")
		c.close()
		return
	}

	expectedToken := strings.TrimSpace(c.cfg.Token)
	if expectedToken == "" || strings.TrimSpace(payload.Token) != expectedToken {
		_ = c.writeError(req.ID, "unauthorized")
		c.close()
		return
	}

	c.authorized = true
	c.startHistorySyncForwarder()
	c.startSettingsSyncForwarder()
	c.startTerminalEventForwarder()
	c.startChatEventForwarder()
	c.startWebSocketHeartbeat()
	if err := c.writeResponse(req.ID, map[string]any{"ok": true}); err != nil {
		c.close()
		return
	}
	c.replayTerminalSessionSnapshot()
}

func (c *websocketConnection) startHistorySyncForwarder() {
	if c.historyEvents != nil || c.historyEventsCleanup != nil {
		return
	}

	historyEvents, cleanup := c.sm.SubscribeHistorySync()
	c.historyEvents = historyEvents
	c.historyEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-historyEvents:
				if !ok {
					return
				}
				if err := c.writeHistoryEvent(websocketHistorySyncPayload(event)); err != nil {
					c.close()
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startChatEventForwarder() {
	if c.chatEvents != nil || c.chatEventsCleanup != nil {
		return
	}

	chatEvents, cleanup := c.sm.SubscribeChatEvents()
	c.chatEvents = chatEvents
	c.chatEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-chatEvents:
				if !ok {
					return
				}
				if c.hasActiveChatRequest(event.RequestID) {
					continue
				}
				if event.Control != nil {
					if err := c.writeEnvelope(websocketEnvelope{
						Type:    "conversation.control",
						Payload: websocketChatControlPayload(event.Control, event.Seq, event.Workdir),
					}); err != nil {
						c.close()
						return
					}
				} else if event.Event != nil {
					if err := c.writeConversationEvent(websocketChatEventPayload(event.Event, event.Seq, event.Workdir)); err != nil {
						c.close()
						return
					}
				}
			}
		}
	}()
}

func (c *websocketConnection) startSettingsSyncForwarder() {
	if c.settingsEvents != nil || c.settingsEventsCleanup != nil {
		return
	}

	settingsEvents, cleanup := c.sm.SubscribeSettingsSync()
	c.settingsEvents = settingsEvents
	c.settingsEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-settingsEvents:
				if !ok {
					return
				}
				payload, err := websocketSettingsSyncPayload(event)
				if err != nil {
					return
				}
				if err := c.writeSettingsEvent(payload); err != nil {
					c.close()
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startTerminalEventForwarder() {
	if c.terminalEvents != nil || c.terminalEventsCleanup != nil {
		return
	}

	terminalEvents, cleanup := c.sm.SubscribeTerminalEvents()
	c.terminalEvents = terminalEvents
	c.terminalEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-terminalEvents:
				if !ok {
					return
				}
				if !c.shouldForwardTerminalEvent(event) {
					continue
				}
				if err := c.writeTerminalEvent(websocketTerminalEventPayload(event)); err != nil {
					c.close()
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) replayTerminalSessionSnapshot() {
	if !c.terminalFeaturesEnabled() {
		return
	}
	for _, terminalSession := range c.sm.TerminalSessionSnapshot("") {
		if !c.terminalSessionAllowed(terminalSession) {
			continue
		}
		if err := c.writeTerminalEvent(websocketTerminalEventPayload(&gatewayv1.TerminalEvent{
			Kind:           "created",
			SessionId:      terminalSession.GetId(),
			ProjectPathKey: terminalSession.GetProjectPathKey(),
			Session:        terminalSession,
		})); err != nil {
			c.close()
			return
		}
	}
}

func (c *websocketConnection) rememberTerminalProject(projectPathKey string) {
	c.terminalInterest.rememberProject(projectPathKey)
}

func (c *websocketConnection) rememberTerminalSession(sessionID string, projectPathKey string) {
	c.terminalInterest.rememberSession(sessionID, projectPathKey)
}

func (c *websocketConnection) forgetTerminalInterest(sessionID string, projectPathKey string) {
	c.terminalInterest.forget(sessionID, projectPathKey)
}

func (c *websocketConnection) shouldForwardTerminalEvent(event *gatewayv1.TerminalEvent) bool {
	return c.terminalEventAllowed(event) && c.terminalInterest.shouldForward(event)
}

func (c *websocketConnection) startWebSocketHeartbeat() {
	c.heartbeatOnce.Do(func() {
		period := c.cfg.WebSocketHeartbeatPeriod
		if period <= 0 {
			period = 15 * time.Second
		}
		go func() {
			ticker := time.NewTicker(period)
			defer ticker.Stop()
			for {
				select {
				case <-c.done:
					return
				case <-ticker.C:
					if err := c.writeEnvelope(websocketEnvelope{
						Type: "ping",
						Payload: map[string]any{
							"timestamp": time.Now().Unix(),
						},
					}); err != nil {
						c.close()
						return
					}
				}
			}
		}()
	})
}

func (c *websocketConnection) dispatch(req websocketRequest) {
	handler := websocketRequestHandlers[req.Type]
	if handler == nil {
		_ = c.writeError(req.ID, "unsupported request type")
		return
	}
	handler(c, req)
}

func (c *websocketConnection) awaitAgentResponse(
	requestID string,
	envelope *gatewayv1.GatewayEnvelope,
) (*gatewayv1.AgentEnvelope, error) {
	ctx, cancel := context.WithTimeout(context.Background(), c.cfg.RequestTimeout)
	defer cancel()

	go func() {
		select {
		case <-c.done:
			cancel()
		case <-ctx.Done():
		}
	}()

	return awaitAgentUnaryResponse(ctx, c.sm, requestID, envelope)
}

func (c *websocketConnection) sendToAgent(envelope *gatewayv1.GatewayEnvelope) error {
	timeout := c.cfg.WebSocketWriteTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	go func() {
		select {
		case <-c.done:
			cancel()
		case <-ctx.Done():
		}
	}()

	return c.sm.SendToAgentContext(ctx, envelope)
}

func (c *websocketConnection) chatStartTimeout() time.Duration {
	timeout := c.cfg.ChatStartTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return timeout
}

func (c *websocketConnection) chatRenderStartTimeout() time.Duration {
	timeout := c.cfg.ChatRenderStartTimeout
	if timeout <= 0 {
		timeout = 45 * time.Second
	}
	return timeout
}

func (c *websocketConnection) writeResponse(requestID string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:      requestID,
		Type:    "response",
		Payload: payload,
	})
}

func (c *websocketConnection) writeError(requestID string, message string) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:    requestID,
		Type:  "error",
		Error: message,
	})
}

func (c *websocketConnection) writeChatEvent(requestID string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:      requestID,
		Type:    "chat.event",
		Payload: payload,
	})
}

func (c *websocketConnection) writeChatControl(requestID string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:      requestID,
		Type:    "chat.control",
		Payload: payload,
	})
}

func (c *websocketConnection) writeHistoryEvent(payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		Type:    "history.event",
		Payload: payload,
	})
}

func (c *websocketConnection) writeConversationEvent(payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		Type:    "conversation.event",
		Payload: payload,
	})
}

func (c *websocketConnection) writeSettingsEvent(payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		Type:    "settings.event",
		Payload: payload,
	})
}

func (c *websocketConnection) writeTerminalEvent(payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		Type:    "terminal.event",
		Payload: payload,
	})
}

func (c *websocketConnection) writeEnvelope(envelope websocketEnvelope) error {
	return c.writer.write(envelope)
}
