/**
 * Which authenticated request counts as one agent step in the native proof. Only the agent's own
 * `brain_recall` call does: the prompt hook's `/api/v1/agent/recall-push` shares the prefix and must
 * not be counted, or the owner transitions keyed to step numbers would fire one step early.
 */
export const isAgentRecallStep = (url: string): boolean => url.split("?")[0] === "/api/v1/agent/recall";
