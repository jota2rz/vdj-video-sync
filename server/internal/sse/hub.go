package sse

import (
	"fmt"
	"log/slog"
	"sync"
)

// Client represents a connected SSE browser client.
type Client struct {
	ID     string
	Events chan []byte // outbound event data
}

// Hub manages SSE client connections and broadcasts events.
type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	mu         sync.RWMutex
	done       chan struct{}
}

// NewHub creates a new SSE hub.
func NewHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		broadcast:  make(chan []byte, 64),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		done:       make(chan struct{}),
	}
}

// Run starts the hub's event loop. Call in a goroutine.
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()
			slog.Info("sse client connected", "id", client.ID, "total", h.Count())

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.Events)
			}
			h.mu.Unlock()
			slog.Info("sse client disconnected", "id", client.ID, "total", h.Count())

		case data := <-h.broadcast:
			h.mu.RLock()
			for client := range h.clients {
				select {
				case client.Events <- data:
				default:
					// Client buffer full — drop message rather than block
					slog.Warn("sse client buffer full, dropping message", "id", client.ID)
				}
			}
			h.mu.RUnlock()

		case <-h.done:
			h.mu.Lock()
			for client := range h.clients {
				close(client.Events)
				delete(h.clients, client)
			}
			h.mu.Unlock()
			return
		}
	}
}

// Register adds a client to the hub.
// Uses a select so that sends after Close() don't block forever.
func (h *Hub) Register(c *Client) {
	select {
	case h.register <- c:
	case <-h.done:
	}
}

// Unregister removes a client from the hub.
// Uses a select so that sends after Close() don't block forever.
func (h *Hub) Unregister(c *Client) {
	select {
	case h.unregister <- c:
	case <-h.done:
	}
}

// Broadcast sends a named SSE event to all connected clients.
// Uses a select so that sends after Close() don't block forever.
func (h *Hub) Broadcast(event string, data []byte) {
	msg := fmt.Appendf(nil, "event: %s\ndata: %s\n\n", event, data)
	select {
	case h.broadcast <- msg:
	case <-h.done:
	}
}

// Count returns the number of connected clients.
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// Close shuts down the hub.
func (h *Hub) Close() {
	close(h.done)
}
