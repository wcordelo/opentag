package main

import "testing"

func TestClassifyResearch(t *testing.T) {
	got := classify("research: Cloudflare Durable Objects")
	if got.Intent != "research" || got.Confidence != 1.0 {
		t.Fatalf("expected research/1.0, got %+v", got)
	}
	if got.ExtractedObjective != "Cloudflare Durable Objects" {
		t.Fatalf("objective = %q", got.ExtractedObjective)
	}
}

func TestClassifyTriage(t *testing.T) {
	got := classify("please triage this bug")
	if got.Intent != "triage" {
		t.Fatalf("expected triage, got %+v", got)
	}
}

func TestClassifyQuestion(t *testing.T) {
	got := classify("what is a Durable Object?")
	if got.Intent != "question" || got.Confidence != 0.8 {
		t.Fatalf("expected question/0.8, got %+v", got)
	}
}

func TestClassifyUnknown(t *testing.T) {
	got := classify("hello there")
	if got.Intent != "unknown" {
		t.Fatalf("expected unknown, got %+v", got)
	}
}

func TestStripMention(t *testing.T) {
	got := classify("research <@U123> OpenTag migration")
	if got.ExtractedObjective != "OpenTag migration" {
		t.Fatalf("objective = %q", got.ExtractedObjective)
	}
}
