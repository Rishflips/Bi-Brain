export type ReviewableMemory = {
  type: "fact" | "decision" | "hypothesis";
  entity: string;
  field:
    | {
        aspect: "status";
        value: "planned" | "active" | "paused" | "done" | "cancelled";
      }
    | { aspect: "statement"; value: string };
  quote: string;
  /** Zero-based Unicode code-point offsets into the retained source body. */
  start: number;
  end: number;
  reason:
    | "explicit_decision_needs_owner_review"
    | "ordinary_language_needs_owner_review";
  classifier_version:
    | "explicit-decision-line-v1"
    | "ordinary-language-memory-v1";
};

const UNSAFE_SUBJECT = /^(?:i|me|my|myself|we|you|he|she|they|it|this|that|owner|user|identity)$/iu;
const UNCERTAIN = /\b(?:if|unless|maybe|perhaps|possibly|probably|could|might)\b/iu;
const DISCOURSE_SUBJECT = /^(?:according to|after discussion|for example|for instance|in my note|note that)\b/iu;
const STATUS = /^(planned|active|paused|done|cancelled)$/iu;

function pointLength(value: string) {
  return Array.from(value).length;
}

function sentenceParts(body: string) {
  const result: { quote: string; start: number; end: number }[] = [];
  const pattern = /[^.!?\r\n]+(?:[.!?](?=\s|$)|$)/gu;
  for (const match of body.matchAll(pattern)) {
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const quote = raw.trim();
    if (!quote) continue;
    const codeUnitStart = (match.index ?? 0) + leading;
    const start = pointLength(body.slice(0, codeUnitStart));
    result.push({ quote, start, end: start + pointLength(quote) });
  }
  return result;
}

function naturalCandidate(part: {
  quote: string;
  start: number;
  end: number;
}): ReviewableMemory | null {
  if (part.quote.endsWith("?") || UNCERTAIN.test(part.quote)) return null;
  let text = part.quote.replace(/[.!]$/u, "").trim();
  let type: ReviewableMemory["type"] = "fact";

  const decision = /^(?:we|i)\s+(?:decided|agreed|chose)(?:\s+that)?\s+(.+)$/iu.exec(
    text,
  );
  if (decision) {
    type = "decision";
    text = decision[1].trim();
  } else {
    const hypothesis = /^(?:i|we)\s+(?:think|believe)(?:\s+that)?\s+(.+)$/iu.exec(
      text,
    );
    if (hypothesis) {
      type = "hypothesis";
      text = hypothesis[1].trim();
    }
  }

  const statement = /^(?:the\s+)?(.+?)\s+(is|will be|uses)\s+(.+)$/iu.exec(text);
  if (!statement) return null;
  const entity = statement[1].trim().replace(/\s+/gu, " ").toLocaleLowerCase();
  const value = statement[3].trim().replace(/\s+/gu, " ");
  if (
    !entity ||
    !value ||
    UNSAFE_SUBJECT.test(entity) ||
    DISCOURSE_SUBJECT.test(entity) ||
    entity.length > 120 ||
    value.length > 300 ||
    entity.split(/\s+/u).length > 8 ||
    /[,;:{}<>]/u.test(entity) ||
    /[{}<>]/u.test(value)
  )
    return null;

  const status = STATUS.exec(value)?.[1]?.toLocaleLowerCase() as
    | "planned"
    | "active"
    | "paused"
    | "done"
    | "cancelled"
    | undefined;
  return {
    type,
    entity,
    field: status
      ? { aspect: "status", value: status }
      : { aspect: "statement", value },
    quote: part.quote,
    start: part.start,
    end: part.end,
    reason: "ordinary_language_needs_owner_review",
    classifier_version: "ordinary-language-memory-v1",
  };
}

/**
 * Finds at most one high-precision, review-only memory in ordinary saved text.
 * Multiple plausible statements deliberately produce no suggestion so capture
 * remains quiet and nothing ambiguous is promoted. This is deterministic
 * grammar, not semantic understanding or calibrated model output.
 */
export function extractReviewableMemory(body: string): ReviewableMemory | null {
  const explicit = body
    .split(/\r?\n/u)
    .filter((line) =>
      /^[A-Za-z][A-Za-z0-9_-]*(?: [A-Za-z][A-Za-z0-9_-]*){1,7}: [A-Za-z0-9][A-Za-z0-9 _.-]{0,299}$/u.test(
        line,
      ),
    );
  if (
    explicit.length === 1 &&
    !/^(?:i|me|my|myself|owner|user|identity)\b/iu.test(explicit[0])
  ) {
    const quote = explicit[0];
    const [rawEntity, value] = quote.split(": ");
    const codeUnitStart = body.indexOf(quote);
    const start = pointLength(body.slice(0, codeUnitStart));
    return {
      type: "decision",
      entity: rawEntity.toLocaleLowerCase(),
      field: { aspect: "statement", value },
      quote,
      start,
      end: start + pointLength(quote),
      reason: "explicit_decision_needs_owner_review",
      classifier_version: "explicit-decision-line-v1",
    };
  }
  if (explicit.length > 1) return null;

  const candidates = sentenceParts(body)
    .map((part) => naturalCandidate(part))
    .filter((candidate): candidate is ReviewableMemory => candidate !== null);
  return candidates.length === 1 ? candidates[0] : null;
}
