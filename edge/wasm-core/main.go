// OpenTag WASM dispatch core — TinyGo via syumai/workers.
// Template lineage: github.com/syumai/workers/_templates/cloudflare/worker-tinygo
//
// CONSTRAINTS (goal-prompt.md invariant #4):
// - No goroutines (go func() is forbidden — Workers WASM has no scheduler).
// - No WASI syscalls (no os.Getenv, no file I/O, no sockets).
// - All inputs arrive via the HTTP request body.
//
// Build (requires TinyGo + wasm-opt):
//   tinygo build -o ../workers/wasm-dispatch/src/main.wasm -target wasm -no-debug .
//   wasm-opt -O3 ../workers/wasm-dispatch/src/main.wasm -o ../workers/wasm-dispatch/src/main.opt.wasm
//
// Until TinyGo is available in this environment, the TypeScript fallback at
// workers/wasm-dispatch/src/index.ts implements the same /dispatch contract.

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/syumai/workers"
)

type dispatchRequest struct {
	Text      string `json:"text"`
	UserID    string `json:"userId"`
	ChannelID string `json:"channelId"`
}

type dispatchResponse struct {
	Intent             string  `json:"intent"`
	Confidence         float64 `json:"confidence"`
	ExtractedObjective string  `json:"extractedObjective"`
}

var (
	researchPrefix = regexp.MustCompile(`(?i)^\s*research\b`)
	researchColon  = regexp.MustCompile(`(?i)\bresearch:\s*`)
	mentionRE      = regexp.MustCompile(`<@[^>]+>`)
	researchStrip  = regexp.MustCompile(`(?i)^\s*research[:\s]+`)
	triageWord     = regexp.MustCompile(`(?i)\btriage\b`)
	triageSlash    = regexp.MustCompile(`(?i)/triage`)
)

func extractObjective(text string) string {
	s := mentionRE.ReplaceAllString(text, "")
	s = researchStrip.ReplaceAllString(s, "")
	return strings.TrimSpace(s)
}

func classify(text string) dispatchResponse {
	trimmed := strings.TrimSpace(text)
	objective := extractObjective(trimmed)

	if researchPrefix.MatchString(trimmed) || researchColon.MatchString(trimmed) {
		return dispatchResponse{Intent: "research", Confidence: 1.0, ExtractedObjective: objective}
	}
	if triageWord.MatchString(trimmed) || triageSlash.MatchString(trimmed) {
		return dispatchResponse{Intent: "triage", Confidence: 1.0, ExtractedObjective: objective}
	}
	if strings.HasSuffix(trimmed, "?") {
		return dispatchResponse{Intent: "question", Confidence: 0.8, ExtractedObjective: objective}
	}
	return dispatchResponse{Intent: "unknown", Confidence: 0.5, ExtractedObjective: objective}
}

func handleDispatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method_not_allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"read_body"}`, http.StatusBadRequest)
		return
	}
	var req dispatchRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid_json"}`, http.StatusBadRequest)
		return
	}
	resp := classify(req.Text)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true,"worker":"opentag-wasm-dispatch","impl":"tinygo"}`))
}

func main() {
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/dispatch", handleDispatch)
	workers.Serve(nil) // nil → DefaultServeMux
}
