import { createHash, randomUUID } from "node:crypto";
import type { Brain } from "./service.ts";
import type { Principal } from "../contracts/index.ts";
import { BrainError, canonical } from "./logic.ts";
export type BindingPack = {
  id: string;
  project_id: string;
  who_i_am: string[];
  identity_claim_ids: string[];
  identity_policy_version: number;
  pages: any[];
  open_intents: any[];
  source_versions: { source_id: string; version: number }[];
  expires_at: string;
  hash: string;
  exclusions: string[];
  omissions: string[];
};
export function buildPack(
  brain: Brain,
  principal: Principal,
  project: string,
  task: string,
): BindingPack {
  brain.access(principal, project);
  const words = task
    .toLocaleLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  const pages = brain
    .pages(principal, project)
    .filter((page) =>
      words.some(
        (w) =>
          page.entity.toLocaleLowerCase().includes(w) ||
          page.current.some((c: any) =>
            String(c.data.value).toLocaleLowerCase().includes(w),
          ),
      ),
    )
    .slice(0, 3);
  const openIntents = brain.agentIntent(
    principal,
    project,
    "list",
    {},
  ) as any[];
  const allowlist = brain.store.setting<string[]>(
    `identity_allowlist:${project}`,
    [],
  );
  const who =
    principal.kind === "owner"
      ? brain
          .currentClaims(principal, project)
          .filter(
            (c) => c.data.aspect === "name" || c.data.aspect === "preference",
          )
      : brain
          .currentClaims({ kind: "owner" }, project)
          .filter(
            (c) =>
              allowlist.includes(c.id) &&
              (c.data.aspect === "name" || c.data.aspect === "preference"),
          );
  const sourceVersions = [
    ...new Map(
      pages
        .flatMap((page) =>
          page.current.flatMap((c: any) => c.data.evidence ?? []),
        )
        .map((e: any) => [
          e.source_id,
          { source_id: e.source_id, version: e.source_version },
        ]),
    ).values(),
  ];
  const pack = {
    id: randomUUID(),
    project_id: project,
    who_i_am: who.map((c) => `${c.data.aspect}: ${String(c.data.value)}`),
    identity_claim_ids: who.map((c) => c.id),
    identity_policy_version: brain.store.setting<number>(
      `identity_policy_version:${project}`,
      0,
    ),
    pages: pages.map((page) => ({
      entity: page.entity,
      current: page.current.map((c: any) => ({
        id: c.id,
        aspect: c.data.aspect,
        value: c.data.value,
        evidence: c.data.evidence,
      })),
    })),
    open_intents: openIntents.slice(0, 10),
    source_versions: sourceVersions,
    expires_at: new Date(brain.clock().getTime() + 20 * 60000).toISOString(),
    exclusions: [
      "private or unallowlisted identity",
      "retired claims",
      "withdrawn or deleted evidence",
    ],
    omissions:
      pages.length < 3
        ? [
            `Only ${pages.length} relevant current page${pages.length === 1 ? "" : "s"} available; no empty pages invented.`,
          ]
        : [],
  };
  const hash = createHash("sha256").update(canonical(pack)).digest("hex");
  brain.access(principal, project);
  return { ...pack, hash };
}
export function validatePack(
  brain: Brain,
  principal: Principal,
  pack: BindingPack,
) {
  brain.access(principal, pack.project_id);
  if (
    brain.store.setting<number>(
      `identity_policy_version:${pack.project_id}`,
      0,
    ) !== pack.identity_policy_version
  )
    throw new BrainError(
      "BINDING_STALE",
      "Identity sharing changed. Refresh the pack.",
      409,
    );
  const currentIdentity = brain
    .currentClaims({ kind: "owner" }, pack.project_id)
    .map((c) => c.id);
  if (pack.identity_claim_ids.some((id) => !currentIdentity.includes(id)))
    throw new BrainError(
      "BINDING_STALE",
      "Identity evidence changed. Refresh the pack.",
      409,
    );
  if (Date.parse(pack.expires_at) <= brain.clock().getTime())
    throw new BrainError(
      "BINDING_EXPIRED",
      "Context expired. Refresh the pack before continuing.",
      409,
    );
  const { hash, ...body } = pack;
  if (createHash("sha256").update(canonical(body)).digest("hex") !== hash)
    throw new BrainError(
      "BINDING_INVALID",
      "Context changed. Refresh before continuing.",
      409,
    );
  for (const source of pack.source_versions) {
    if (brain.source(principal, source.source_id).version !== source.version)
      throw new BrainError(
        "BINDING_STALE",
        "Evidence changed. Refresh before continuing.",
        409,
      );
  }
  return true;
}
export async function runBoundTask<T>(
  brain: Brain,
  principal: Principal,
  project: string,
  task: string,
  work: (context: BindingPack, preAction: () => true) => Promise<T>,
) {
  const pack = buildPack(brain, principal, project, task);
  validatePack(brain, principal, pack);
  // Enforced wrapper: work receives the authorized pack before it can begin. This is not a claim about arbitrary clients.
  const result = await work(pack, () => {
    validatePack(brain, principal, pack);
    return true;
  });
  validatePack(brain, principal, pack);
  return { result, delivered_pack_hash: pack.hash };
}
