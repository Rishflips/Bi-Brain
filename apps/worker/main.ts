import { randomUUID } from "node:crypto";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  PreparedReasoningProvider,
  REASONING_DEFAULT_ENDPOINT,
  type PreparedProvider,
} from "../../packages/providers/prepared.ts";
import { PreparedDecisionProvider } from "../../packages/providers/prepared-decision.ts";
import { ManagedRuntime, managedCapability, managedDecisionCapability } from "../../packages/runtime/managed.ts";
import {
  decisionServerCapability,
  evaluateConfiguredDecisionPolicy,
  evaluateConfiguredPolicy,
  installDecisionPolicy,
  readActivation,
  readDecisionActivation,
  serverCapability,
} from "../../packages/runtime/managed-activation.ts";
import {
  readWorkerReadiness,
  removeWorkerReadiness,
  writeWorkerReadiness,
} from "../../packages/runtime/worker-readiness.ts";
import {
  readDecisionReadiness,
  removeDecisionReadiness,
  writeDecisionReadiness,
} from "../../packages/runtime/decision-worker-readiness.ts";
import { loadConfig } from "../server/config.ts";
import { Worker } from "./engine.ts";
import { ManagedWorker } from "./managed.ts";

const config = loadConfig();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fail-closed provider used when this deployment has no ready configured policy (or
 * no key). A paid intent yields an explicit unavailable attempt with NO provider
 * call and NO hold; when paid is not requested the worker still runs extractive.
 */
const unavailableProvider: PreparedProvider = {
  prepareCall(): never {
    throw new BrainError(
      "PROVIDER_UNAVAILABLE",
      "Connected model processing is not available. Your saved work stays available and extractive.",
      503,
    );
  },
};

const HEARTBEAT_MS = 5000;

if (config.mode === "managed") {
  const optIn = (process.env.BRAIN_MANAGED_ALLOW_PAID ?? "").trim() === "1";
  const runtime = new ManagedRuntime(config.managedRoot, {
    capability: () => {
      const c = managedCapability({
        control: runtime.control,
        root: runtime.root,
        now: runtime.control.clock(),
        optIn,
      });
      return { ready: c.available, reason: c.reason };
    },
    decisionCapability: () => {
      const c = managedDecisionCapability({
        control: runtime.control,
        root: runtime.root,
        now: runtime.control.clock(),
        optIn,
      });
      return { ready: c.available, reason: c.reason };
    },
  });
  const control = runtime.control;
  const controlHandle = { db: control.db, path: control.path };
  const workerId = randomUUID();
  const bootedAt = control.clock().toISOString();

  // Bootstrap INDEPENDENT of own readiness: configured policy + key presence only.
  const configured = evaluateConfiguredPolicy({
    control: controlHandle,
    root: runtime.root,
    now: control.clock(),
    optIn,
  });
  const profile = configured.ready
    ? readActivation(controlHandle, runtime.root)
    : undefined;
  const key = process.env.OPENAI_API_KEY;
  const keyPresent =
    typeof key === "string" && key.trim() !== "" && key.length <= 4096;
  const candidate =
    configured.ready && profile && keyPresent
      ? { root: runtime.root, profile }
      : undefined;

  // Offline validation with the ADAPTER's own rules: build the prepared config and
  // call `prepareCall` ONCE (no I/O) so a locally-invalid key/model/price never
  // installs a paid path or publishes readiness. A thrown config error is static.
  let provider: PreparedProvider | undefined;
  if (candidate) {
    const built = new PreparedReasoningProvider({
      model: candidate.profile.model,
      price: {
        version: candidate.profile.price_version,
        input_micro_usd_per_million:
          candidate.profile.input_micro_usd_per_million,
        output_micro_usd_per_million:
          candidate.profile.output_micro_usd_per_million,
      },
      accepted_response_models: candidate.profile.accepted_response_models,
      max_output_tokens: candidate.profile.max_output_tokens,
      key,
      endpoint: REASONING_DEFAULT_ENDPOINT,
    });
    try {
      built.prepareCall({ kind: "brief", sources: [] });
      provider = built;
    } catch {
      provider = undefined;
    }
  }
  const installed = provider ? candidate : undefined;

  // DECISION bootstrap is INDEPENDENT of the reasoning path and of own readiness:
  // the configured decision policy, the enrolled profile and the worker-only
  // `BRAIN_DECISION_API_KEY` alone. The key is never inferred from a provider, never
  // logged and never forwarded to the server child.
  const decisionConfigured = evaluateConfiguredDecisionPolicy({
    control: controlHandle,
    root: runtime.root,
    now: control.clock(),
    optIn,
  });
  const decisionProfile = decisionConfigured.ready
    ? readDecisionActivation(controlHandle, runtime.root)
    : undefined;
  const decisionKey = process.env.BRAIN_DECISION_API_KEY;
  const decisionKeyPresent =
    typeof decisionKey === "string" &&
    decisionKey.trim() !== "" &&
    decisionKey.length <= 4096;
  const decisionCandidate =
    decisionConfigured.ready && decisionProfile && decisionKeyPresent
      ? { root: runtime.root, profile: decisionProfile }
      : undefined;
  let decisionProvider: PreparedDecisionProvider | undefined;
  if (decisionCandidate) {
    const built = new PreparedDecisionProvider({
      provider: decisionCandidate.profile.provider,
      endpoint: decisionCandidate.profile.endpoint,
      model: decisionCandidate.profile.model,
      accepted_response_models: [
        ...decisionCandidate.profile.accepted_response_models,
      ],
      price: {
        version: decisionCandidate.profile.price_version,
        input_micro_usd_per_million:
          decisionCandidate.profile.input_micro_usd_per_million,
        output_micro_usd_per_million:
          decisionCandidate.profile.output_micro_usd_per_million,
      },
      key: decisionKey,
      timeout_ms: decisionCandidate.profile.timeout_ms,
      max_request_bytes: decisionCandidate.profile.max_request_bytes,
      max_response_bytes: decisionCandidate.profile.max_response_bytes,
    });
    try {
      // Synthetic prepareDecision with NO I/O: a locally-invalid key/model/price
      // never installs a paid decision path or publishes decision readiness.
      built.prepareDecision({
        state: "synthetic",
        instruction: "synthetic",
        options: [
          { id: "related", description: "synthetic" },
          { id: "unrelated", description: "synthetic" },
        ],
      });
      decisionProvider = built;
    } catch {
      decisionProvider = undefined;
    }
  }
  // The installed decision policy's `worker_id` is the PROCESS boot identity and
  // must equal the decision readiness lease; it is deliberately distinct from the
  // per-job `Worker.id` lease owner.
  const installedDecision =
    decisionProvider && decisionCandidate
      ? installDecisionPolicy({
          root: decisionCandidate.root,
          profile: decisionCandidate.profile,
          worker_id: workerId,
          optIn,
        })
      : undefined;

  // Production send-time fencing: after bootstrap, the actual provider requires a
  // FRESH own-worker readiness lease at `prepare` and again immediately before
  // `execute` (a post-mark failure retains the hold). It never re-checks during the
  // await, so an already-running call still settles a known charge.
  const ownReadinessFresh = () => {
    const r = readWorkerReadiness(runtime.root, control.clock());
    // Reuse the pure capability comparison so EVERY frozen field is checked
    // (FP/epoch/root_nonce/config/provider/model/price/endpoint) against the
    // installed profile — not just our own worker id on a tampered wrong-FP lease.
    const matches =
      !!installed &&
      serverCapability({
        configured: { ready: true, reason: "ready" },
        readiness: r,
        profile: installed.profile,
      }).ready;
    if (
      !matches ||
      r.state !== "ready" ||
      !r.readiness ||
      r.readiness.worker_id !== workerId
    )
      throw new BrainError(
        "PROVIDER_UNAVAILABLE",
        "Connected model processing is not available. Your saved work stays available and extractive.",
        503,
      );
  };
  const fencedProvider: PreparedProvider | undefined = provider
    ? {
        prepareCall(input) {
          ownReadinessFresh();
          const call = provider!.prepareCall(input);
          return {
            identity: call.identity,
            request_bytes: call.request_bytes,
            execute: async (signal) => {
              ownReadinessFresh();
              return call.execute(signal);
            },
          };
        },
      }
    : undefined;

  // Production send-time fencing for the decision stage: the real provider
  // requires a FRESH own decision readiness lease at `prepare` and again
  // immediately before `execute`. It never re-checks during the await, so an
  // already-running call still settles a known charge.
  const ownDecisionReadinessFresh = () => {
    const r = readDecisionReadiness(runtime.root, control.clock());
    const matches =
      !!installedDecision &&
      decisionServerCapability({
        configured: { ready: true, reason: "ready" },
        readiness: r,
        profile: installedDecision.profile,
      }).ready;
    if (
      !matches ||
      r.state !== "ready" ||
      !r.readiness ||
      r.readiness.worker_id !== workerId
    )
      throw new BrainError(
        "PROVIDER_UNAVAILABLE",
        "Connected model processing is not available. Your saved work stays available and extractive.",
        503,
      );
  };
  const fencedDecisionProvider:
    | Pick<PreparedDecisionProvider, "prepareDecision">
    | undefined = decisionProvider
    ? {
        prepareDecision(input) {
          ownDecisionReadinessFresh();
          const call = decisionProvider!.prepareDecision(input);
          return {
            identity: call.identity,
            request_bytes: call.request_bytes,
            execute: async (signal) => {
              ownDecisionReadinessFresh();
              return call.execute(signal);
            },
          };
        },
      }
    : undefined;

  const worker = new ManagedWorker(runtime, {
    ...(installed && fencedProvider
      ? { bootstrap: installed, providerFactory: () => fencedProvider }
      : { providerFactory: () => unavailableProvider }),
    ...(installedDecision && fencedDecisionProvider
      ? {
          decisionBootstrap: installedDecision,
          decisionProviderFactory: () => fencedDecisionProvider,
        }
      : {}),
  });

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const beatReasoning = () => {
    try {
      const live = readActivation(controlHandle, runtime.root);
      const configuredNow = installed
        ? evaluateConfiguredPolicy({
            control: controlHandle,
            root: runtime.root,
            now: control.clock(),
            optIn,
          })
        : { ready: false };
      const stillFrozen =
        !!installed &&
        !!live &&
        live.enabled &&
        configuredNow.ready &&
        live.fingerprint === installed.profile.fingerprint &&
        live.version === installed.profile.version &&
        live.config_digest === installed.profile.config_digest &&
        live.epoch === installed.profile.epoch &&
        live.root_nonce === installed.profile.root_nonce;
      if (stillFrozen) {
        const now = control.clock();
        writeWorkerReadiness(runtime.root, {
          schema: 1,
          worker_id: workerId,
          epoch: live!.epoch,
          root_nonce: live!.root_nonce,
          activation_fingerprint: live!.fingerprint,
          config_digest: live!.config_digest,
          provider: live!.provider,
          model: live!.model,
          price_version: live!.price_version,
          endpoint_class: live!.endpoint_class,
          booted_at: bootedAt,
          heartbeat_at: now.toISOString(),
          expires_at: new Date(now.getTime() + HEARTBEAT_MS * 3).toISOString(),
        });
      } else {
        // Withdraw ONLY our own lease; never another worker's.
        removeWorkerReadiness(runtime.root, workerId);
      }
    } catch {
      /* A transient readiness write failure must not stop processing. */
    }
  };
  const beatDecision = () => {
    try {
      const live = installedDecision
        ? readDecisionActivation(controlHandle, runtime.root)
        : undefined;
      const configuredNow = installedDecision
        ? evaluateConfiguredDecisionPolicy({
            control: controlHandle,
            root: runtime.root,
            now: control.clock(),
            optIn,
          })
        : { ready: false };
      const stillFrozen =
        !!installedDecision &&
        !!live &&
        live.enabled &&
        configuredNow.ready &&
        live.fingerprint === installedDecision.profile.fingerprint &&
        live.version === installedDecision.profile.version &&
        live.config_digest === installedDecision.profile.config_digest &&
        live.epoch === installedDecision.profile.epoch &&
        live.root_nonce === installedDecision.profile.root_nonce;
      if (stillFrozen) {
        const now = control.clock();
        writeDecisionReadiness(runtime.root, {
          schema: 1,
          worker_id: workerId,
          stage_scope: "decision",
          provider_family: live!.provider,
          endpoint_digest: live!.endpoint_digest,
          epoch: live!.epoch,
          root_nonce: live!.root_nonce,
          activation_fingerprint: live!.fingerprint,
          config_digest: live!.config_digest,
          model: live!.model,
          price_version: live!.price_version,
          booted_at: bootedAt,
          heartbeat_at: now.toISOString(),
          expires_at: new Date(now.getTime() + HEARTBEAT_MS * 3).toISOString(),
        });
      } else {
        // Withdraw ONLY our own lease; never another worker's.
        removeDecisionReadiness(runtime.root, workerId);
      }
    } catch {
      /* A transient readiness write failure must not stop processing. */
    }
  };
  const beat = () => {
    beatReasoning();
    beatDecision();
  };
  // Either profile alone starts the shared 5 s heartbeat: a decision-only install
  // must not require a reasoning bootstrap to publish and refresh its own lease.
  if (installed || installedDecision) {
    beat();
    heartbeat = setInterval(beat, HEARTBEAT_MS);
  }

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (running) {
    try {
      const worked = await worker.tick();
      if (!worked) await sleep(1000);
    } catch {
      console.error("Managed worker tick failed; retrying.");
      await sleep(2000);
    }
  }
  if (heartbeat) clearInterval(heartbeat);
  await worker.stop();
  try {
    removeWorkerReadiness(runtime.root, workerId);
  } catch {
    /* best-effort cleanup */
  }
  try {
    removeDecisionReadiness(runtime.root, workerId);
  } catch {
    /* best-effort cleanup */
  }
  try {
    runtime.close();
  } catch {
    console.error("Managed runtime did not close cleanly; a handle was pinned.");
  }
} else {
  const storage = new Storage();
  const worker = new Worker(new Brain(storage));
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (running) {
    try {
      const worked = await worker.tick();
      if (!worked) await sleep(1000);
    } catch {
      console.error("Worker storage unavailable; retrying.");
      await sleep(2000);
    }
  }
  storage.close();
}
