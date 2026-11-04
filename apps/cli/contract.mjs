// apps/cli/contract.mjs
// The bibrain-agent/1 contract as the CLI speaks it. `hook`, `hook-end`, `recall` and `note` are four parsers and printers over the two functions here.
import { readFileSync } from "node:fs";
import { HOOK_BUDGET_MS, HOOK_END_BUDGET_MS, HOOK_END_PER_SESSION, HOOK_PROMPT_MAX, firstCodePoints, hasMarkerLine, hookSkipReason, hookStatePath, keyFilePath, looksLikeSecret, loopbackApi, markerLines, noteHookState, noteSessionEnd, readHookState, sha256, writeHookState } from "./lib.mjs";

export const CONTRACT = "bibrain-agent/1";
export const GENERIC_CLIENTS = ["hermes", "other"];

/** The client name a generic command reports: one of the generic names, else other. */
export function genericClient(flag) {
  return typeof flag === "string" && GENERIC_CLIENTS.includes(flag) ? flag : "other";
}

function parseV1(raw) {
  let value;
  try {
    value = JSON.parse(String(raw).replace(/^﻿/u, "").trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || value.v !== 1) return null;
  return value;
}

/** Generic recall input: { v: 1, prompt, session?, cwd? }. The cwd is accepted and ignored; it never leaves the process. */
export function parseRecallInput(raw) {
  const value = parseV1(raw);
  if (!value || typeof value.prompt !== "string") return null;
  return { prompt: value.prompt, session: typeof value.session === "string" ? value.session : "" };
}

/** Generic note input: { v: 1, reply, session?, continued? }. */
export function parseNoteInput(raw) {
  const value = parseV1(raw);
  if (!value || typeof value.reply !== "string") return null;
  return { reply: value.reply, session: typeof value.session === "string" ? value.session : "", continued: value.continued === true };
}

export const recallOutput = (text) => JSON.stringify({ v: 1, context: text });
export const noteOutput = () => JSON.stringify({ v: 1 });

function connection(dataDir, connectionId) {
  const file = keyFilePath(dataDir, connectionId);
  const { api, key } = JSON.parse(readFileSync(file, "utf8"));
  if (typeof key !== "string") throw new Error("no key");
  return { origin: loopbackApi(api), key, statePath: hookStatePath(dataDir, connectionId) };
}

/**
 * One prompt-time recall push. Returns the context text to put in front of the model, or "" when there is nothing.
 * Throws on any problem; every caller swallows that, because a hook must never slow or block the agent.
 */
export async function pushRecall({ prompt, sessionId, client, dataDir, connectionId, startedAt }) {
  if (hookSkipReason(prompt)) return "";
  const { origin, key, statePath } = connection(dataDir, connectionId);
  const state = readHookState(statePath);
  const sessionHash = sha256(sessionId);
  const session = state.sessions[sessionHash];
  // performance.timeOrigin is fractional and AbortSignal.timeout needs an integer.
  const remaining = Math.max(50, Math.floor(HOOK_BUDGET_MS - (Date.now() - startedAt)));
  const res = await fetch(`${origin}/api/v1/agent/recall-push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: firstCodePoints(prompt, HOOK_PROMPT_MAX), session_id: sessionHash, first_prompt: !session?.digested, seen: session?.hashes ?? [], client }),
    signal: AbortSignal.timeout(remaining),
    redirect: "error",
  });
  if (!res.ok) return "";
  const body = await res.json();
  if (!body || typeof body !== "object" || !["full", "pointer", "none"].includes(body.level) || typeof body.text !== "string") return "";
  const ids = Array.isArray(body.hit_ids) ? body.hit_ids.filter((x) => typeof x === "string") : [];
  writeHookState(statePath, noteHookState(state, sessionHash, ids, Date.now(), body.digest === true));
  return body.text;
}

/** One end-of-turn session note: only the marker lines travel, once per session and text, at most 12 a session. Throws on any problem; callers swallow it. */
export async function postNote({ message, active, sessionId, client, dataDir, connectionId, startedAt }) {
  if (active || !hasMarkerLine(message) || looksLikeSecret(message)) return;
  const text = markerLines(message);
  if (text === null || looksLikeSecret(text)) return;
  const { origin, key, statePath } = connection(dataDir, connectionId);
  const state = readHookState(statePath);
  // A client that sends no session id shares one bucket (and its per-session note cap) across those turns.
  const sessionHash = sha256(sessionId);
  const messageHash = sha256(text);
  const notes = state.sessions[sessionHash]?.notes ?? [];
  if (notes.includes(messageHash) || notes.length >= HOOK_END_PER_SESSION) return;
  const remaining = Math.max(50, Math.floor(HOOK_END_BUDGET_MS - (Date.now() - startedAt)));
  const res = await fetch(`${origin}/api/v1/agent/session-note`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionHash, client, text }),
    signal: AbortSignal.timeout(remaining),
    redirect: "error",
  });
  if (!res.ok) return;
  writeHookState(statePath, noteSessionEnd(state, sessionHash, messageHash, Date.now()));
}
