import { describe, expect, it } from "vitest";
import type { Entity } from "../../packages/contracts/index.ts";
import { gateFitsBrief } from "../../packages/domain/brief.ts";
import { factText } from "../../packages/domain/facts.ts";
import {
  QUESTION_LIMIT,
  findOpenQuestions,
  questionSignature,
} from "../../packages/domain/questions.ts";

const source = (
  id: string,
  body: string,
  captured_at = "2026-10-20T09:00:00Z",
  extra: { state?: string; title?: string; version?: number } = {},
) => ({
  id,
  version: extra.version ?? 1,
  title: extra.title ?? `Note ${id}`,
  body,
  captured_at,
  state: extra.state ?? "active",
});
const quoteAt = (body: string, e: { start: number; end: number }) =>
  Array.from(body).slice(e.start, e.end).join("");

describe("factText", () => {
  it("reads a status as a sentence and anything else as name: value", () => {
    expect(factText("Northstar beta", "status", "active")).toBe("Northstar beta is active.");
    expect(factText("Northstar beta", "statement", "invite only")).toBe("Northstar beta: invite only");
    expect(factText("Seats", "count", 50)).toBe("Seats: 50");
    expect(factText("Odd", "statement", { a: 1 })).toBe('Odd: {"a":1}');
  });
});

describe("findOpenQuestions", () => {
  it("finds marked lines and short-note questions with exact code-point evidence", () => {
    const body =
      "🙂 Plan for the week.\nOpen question: which benchmark has dated facts?\nDo we ship the self-hosted page first?";
    const { items, total } = findOpenQuestions([source("a", body)], new Set());
    expect(total).toBe(2);
    expect(items.map((q) => q.text)).toEqual([
      "which benchmark has dated facts?",
      "Do we ship the self-hosted page first?",
    ]);
    for (const q of items) expect(quoteAt(body, q.evidence)).toBe(q.evidence.quote);
    expect(items[0].evidence).toMatchObject({ source_id: "a", source_version: 1 });
    expect(items[0].source_title).toBe("Note a");
  });

  it("keeps a marked line that has no question mark", () => {
    const { items } = findOpenQuestions(
      [source("a", "Question: pricing for teams\nEverything else is settled.")],
      new Set(),
    );
    expect(items.map((q) => q.text)).toEqual(["pricing for teams"]);
  });

  it("takes only marked lines from an original full of questions, like a pasted chat", () => {
    const chat = [
      "Can you help?",
      "What do you need?",
      "Is the beta open?",
      "Who is invited?",
      "Open question: when does billing start?",
    ].join("\n");
    const { items } = findOpenQuestions([source("chat", chat)], new Set());
    expect(items.map((q) => q.text)).toEqual(["when does billing start?"]);
  });

  it("shows a question once, from the newest original, and hides answered ones", () => {
    const older = source("old", "Do we ship the self-hosted page first?", "2026-10-01T09:00:00Z");
    const newer = source("new", "Do we ship the  self-hosted page first ?", "2026-10-21T09:00:00Z");
    const first = findOpenQuestions([older, newer], new Set());
    expect(first.items).toHaveLength(1);
    expect(first.items[0].evidence.source_id).toBe("new");
    const answered = new Set([first.items[0].signature]);
    expect(findOpenQuestions([older, newer], answered).items).toEqual([]);
    expect(questionSignature("Do we ship it?")).toBe(questionSignature("do we   ship it"));
    expect(questionSignature("Is the café open?")).toBe(questionSignature("Is the café open?"));
  });

  it("ignores withdrawn originals, quarantine placeholders, secret-looking lines and very short questions", () => {
    const secret = "Open question: should api_key = " + "a".repeat(20) + " go in the config?";
    const { items } = findOpenQuestions(
      [
        source("w", "Open question: is this withdrawn?", undefined, { state: "withdrawn" }),
        source(
          "q",
          "[Quarantined: suspected secret. Original retained outside the vault.]",
          undefined,
          { title: "Quarantined source" },
        ),
        source("s", secret),
        source("short", "Why?"),
      ],
      new Set(),
    );
    expect(items).toEqual([]);
  });

  it("takes a marked line whole, even with several sentences or abbreviations", () => {
    const body =
      "🙂 Notes\nOpen question: who owns Q3. Alice or Bob?\r\nQuestion: Dr. Chen's review, e.g. the plan?";
    const { items } = findOpenQuestions([source("m", body)], new Set());
    expect(items.map((q) => q.text)).toEqual([
      "who owns Q3. Alice or Bob?",
      "Dr. Chen's review, e.g. the plan?",
    ]);
    expect(items[0].evidence.quote).toBe("Open question: who owns Q3. Alice or Bob?");
    for (const q of items) expect(quoteAt(body, q.evidence)).toBe(q.evidence.quote);
  });

  it("does not treat a hyphenated word as a marker", () => {
    const { items } = findOpenQuestions(
      [source("qa", "Question-and-answer notes from the call")],
      new Set(),
    );
    expect(items).toEqual([]);
  });

  it("caps the list and reports how many there are", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      source(
        `n${i}`,
        `Open question: topic number ${i} still open?`,
        `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T09:00:00Z`,
      ),
    );
    const { items, total } = findOpenQuestions(many, new Set());
    expect(items).toHaveLength(QUESTION_LIMIT);
    expect(total).toBe(30);
  });
});

const gate = (data: Record<string, unknown>): Entity => ({
  id: "g",
  project_id: "inbox",
  kind: "gate",
  version: 1,
  created_at: "2026-10-20T09:00:00Z",
  data,
});
const evidence = [{ source_id: "s", source_version: 1, start: 0, end: 4, quote: "Beta" }];

describe("gateFitsBrief", () => {
  it("fits a named fact with evidence and leaves intentions and raw text to Your brain", () => {
    expect(
      gateFitsBrief(gate({ status: "queued", entity: "Beta", field: { aspect: "statement", value: "invite only" }, evidence })),
    ).toBe(true);
    expect(gateFitsBrief(gate({ status: "queued", type: "intent", intent: { action: "propose" }, evidence }))).toBe(false);
    expect(
      gateFitsBrief(gate({ status: "queued", entity: "Beta", field: { aspect: "statement", value: "" }, evidence })),
    ).toBe(false);
    expect(
      gateFitsBrief(gate({ status: "queued", entity: "Beta", field: { aspect: "statement", value: "x" }, evidence: [] })),
    ).toBe(false);
  });
});
