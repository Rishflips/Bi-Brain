import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  Entity,
  Source,
  Preferences,
} from "../../packages/contracts/index.ts";
import sample from "../../fixtures/beta-launch.json" with { type: "json" };
import { EvidenceList } from "./components.tsx";
import { SignIn, ConnectionUnavailable, type RuntimeMode } from "./sign-in.tsx";
import { BrandLockup } from "./brand.tsx";
import { takePairToken } from "./pair-link.ts";
import { TodayView } from "./today/TodayView.tsx";
import "./today/today.css";
import { BrainView } from "./brain/BrainView.tsx";
import { SourceView } from "./brain/SourceView.tsx";
import type { OpenSourceOptions } from "./today/types.ts";
import "./brain/brain.css";
import { ConnectionsView } from "./connections/ConnectionsView.tsx";
import "./connections/connections.css";
import {
  AgentClientPicker,
  AgentSetupGuide,
  agentSetupCommand,
  type AgentClient,
} from "./agent-connection.tsx";
import "@fontsource-variable/manrope/wght.css";
import "./style.css";
import "./refinement.css";
let csrf = "";

function NavGlyph({ name }: { name: string }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (name === "Today")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
      </svg>
    );
  if (name === "Your brain")
    return (
      <svg {...common}>
        <path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H11v17H7.5A2.5 2.5 0 0 1 5 17.5v-12ZM19 5.5A2.5 2.5 0 0 0 16.5 3H13v17h3.5a2.5 2.5 0 0 0 2.5-2.5v-12Z" />
        <path d="M5 8h3M16 8h3M5 15h3M16 15h3" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M9.5 14.5 7 17a3.54 3.54 0 0 1-5-5l3-3a3.54 3.54 0 0 1 5 0" />
      <path d="m14.5 9.5 2.5-2.5a3.54 3.54 0 0 1 5 5l-3 3a3.54 3.54 0 0 1-5 0" />
      <path d="m8 16 8-8" />
    </svg>
  );
}
/**
 * Exact dollar display from integer micro-USD. A nonzero amount below the
 * display floor is shown as "<$0.0001", never as a free "$0.0000".
 */
function formatUsd(microUsd: number): string {
  if (!Number.isFinite(microUsd) || microUsd <= 0) return "$0.0000";
  const usd = microUsd / 1_000_000;
  return usd < 0.0001 ? "<$0.0001" : `$${usd.toFixed(6)}`;
}
type SortingStatus = {
  configured: boolean;
  label: string | null;
  reason: string | null;
  wanted: boolean;
  worker_running: boolean;
  answers: number;
  reviewed: number;
  last_error: string | null;
};
/** The one plain line Settings shows about sorting help. */
function sortingLine(status: SortingStatus, prefs: Preferences): string {
  if (!status.configured)
    return `Off on this computer: ${status.reason ?? "sorting help is not set up."}`;
  if (!status.worker_running) return "Waiting for BiBrain's background worker to start.";
  if (prefs.daily_cap_micro_usd <= 0) return "Needs a daily limit above $0 below.";
  if (prefs.per_job_cap_micro_usd <= 0) return "Needs a per-note limit above $0 below.";
  if (!prefs.enabled) return "Needs background help turned on below.";
  if (!prefs.decision_provider_enabled) return "Waiting for your consent below.";
  return `On · ${status.label ?? "sorting service"} · ${status.answers} ${status.answers === 1 ? "note" : "notes"} sorted, ${status.reviewed} reviewed`;
}
/**
 * Monotonic auth generation. It advances whenever the browser session is
 * established, lost, or found to belong to a different account. Every
 * account-scoped request captures it and refuses to resolve once it has moved,
 * so a late response from a previous account can never repopulate the view.
 */
let authGeneration = 0;
class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const generation = authGeneration;
  const response = await fetch("/api/v1" + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      "X-Brain-CSRF": csrf,
      ...(body ? { "Idempotency-Key": crypto.randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let value: any = null;
  try {
    value = await response.json();
  } catch {
    value = null;
  }
  // A superseded session's response is discarded, never applied.
  if (generation !== authGeneration)
    throw new ApiError(
      "Your session changed. Sign in again to continue.",
      "UNAUTHORIZED",
    );
  if (!response.ok)
    throw new ApiError(
      value?.error?.message ?? "Your brain is unavailable.",
      value?.error?.code ?? "UNAVAILABLE",
    );
  if (value === null)
    throw new ApiError(
      "Your brain sent an unexpected response.",
      "UNAVAILABLE",
    );
  return value;
}
type RuntimeMeta = {
  mode: RuntimeMode;
  sign_in_url: string | null;
  sign_in_available: boolean;
  pairing_available: boolean;
};
type SessionInfo = { csrf: string; account_id: string | null };
type BillingStatus =
  | {
      available: true;
      mode: "sandbox" | "live";
      provider: "dodo";
      state: "not_started" | "confirming" | "active" | "attention";
      cadence: "monthly" | "annual" | null;
      subscription_status: string | null;
      checkout_url: string | null;
      management_available: boolean;
    }
  | { available: false; state: "unavailable"; reason: string };
const isRuntimeMeta = (value: any): value is RuntimeMeta =>
  !!value &&
  typeof value === "object" &&
  (value.mode === "local" || value.mode === "managed");
const isSessionInfo = (value: any): value is SessionInfo =>
  !!value && typeof value === "object" && typeof value.csrf === "string";
function openBillingCheckout(
  status: Extract<BillingStatus, { available: true }>,
  checkoutUrl: string,
) {
  const url = new URL(checkoutUrl);
  const host =
    status.mode === "sandbox"
      ? "test.checkout.dodopayments.com"
      : "checkout.dodopayments.com";
  if (
    url.protocol !== "https:" ||
    url.host !== host ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Secure checkout could not be opened.");
  location.assign(url.toString());
}
function download(name: string, value: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Modal({
  title,
  close,
  children,
  error,
  variant,
  dataUi,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
  error?: string;
  variant?: "inspector";
  dataUi?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const focus = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => focus?.focus();
  }, []);
  return (
    <dialog
      className={variant === "inspector" ? "inspector" : undefined}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-labelledby="dialog-title"
      data-ui={dataUi}
    >
      <header className="row">
        <h2 id="dialog-title">{title}</h2>
        <button aria-label="Close dialog" onClick={close}>
          ×
        </button>
      </header>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
      {children}
    </dialog>
  );
}
// Taken at module load so the one-time token leaves the address bar before
// anything else reads location.hash.
let pendingPairToken = takePairToken(location, history);
function App() {
  const navFromHash = () =>
    (
      ({
        "#today": "Today",
        "#brain": "Your brain",
        "#connections": "Connections",
        "#settings": "Settings",
      }) as Record<string, string>
    )[location.hash] ?? "Today";
  // Bootstrap is a three-state gate. The authenticated workspace is only ever
  // reachable once a real `/api/v1/runtime` response has been validated; a
  // failed runtime fetch never falls back to local pairing.
  const [phase, setPhase] = useState<"loading" | "unknown" | "ready">(
      "loading",
    ),
    [retryNonce, setRetryNonce] = useState(0),
    [paired, setPaired] = useState(false),
    [runtime, setRuntime] = useState<RuntimeMeta | null>(null),
    [accountId, setAccountId] = useState<string | null>(null),
    [nav, setNav] = useState(navFromHash),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [demo, setDemo] = useState(false),
    [projects, setProjects] = useState<any[]>([]),
    [notes, setNotes] = useState<Source[]>([]),
    [retiredReceipts, setRetiredReceipts] = useState<string[]>([]),
    [today, setToday] = useState<any>({
      briefs: [],
      goals: [],
      proposals: [],
      receipts: [],
      pings: [],
      status: { jobs: [] },
    }),
    [prefs, setPrefs] = useState<Preferences | null>(null),
    [sorting, setSorting] = useState<SortingStatus | null>(null),
    [sortingUnavailable, setSortingUnavailable] = useState(false),
    // The preferences as last loaded or saved, which is what sorting help really runs on.
    [savedPrefs, setSavedPrefs] = useState<Preferences | null>(null),
    [grants, setGrants] = useState<any[]>([]),
    [billing, setBilling] = useState<BillingStatus | null>(null),
    [scope, setScope] = useState(
      () => localStorage.getItem("brain-project") ?? "inbox",
    ),
    [dialog, setDialog] = useState<string | null>(null),
    [source, setSource] = useState<Source | null>(null),
    [sourceView, setSourceView] = useState<OpenSourceOptions>({}),
    [proposal, setProposal] = useState<Entity | null>(null),
    [handoff, setHandoff] = useState<Entity | null>(null),
    [newTitle, setNewTitle] = useState(""),
    [body, setBody] = useState(""),
    [captureScope, setCaptureScope] = useState("inbox"),
    [visibility, setVisibility] = useState("project"),
    [separate, setSeparate] = useState(false),
    [projectTitle, setProjectTitle] = useState(""),
    [goalTitle, setGoalTitle] = useState(""),
    [criteria, setCriteria] = useState(""),
    [goalDue, setGoalDue] = useState(""),
    [goalReview, setGoalReview] = useState(""),
    [artifact, setArtifact] = useState(""),
    [token, setToken] = useState(""),
    [grantProjects, setGrantProjects] = useState<string[]>([]),
    [canWrite, setCanWrite] = useState(false),
    [grantDuration, setGrantDuration] = useState(24),
    [agentClient, setAgentClient] = useState<AgentClient>("codex"),
    [preview, setPreview] = useState<any>(null),
    [snooze, setSnooze] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const preferencesDirty = useRef(false);
  const sortingConsentTouched = useRef(false);
  // Recall help is its own consent, loaded and saved beside the preferences and never part of them.
  const [recallHelp, setRecallHelp] = useState(false);
  const [savedRecallHelp, setSavedRecallHelp] = useState(false);
  const recallConsentTouched = useRef(false);
  const [consentOverride, setConsentOverride] = useState<boolean | null>(null);
  // An INDEPENDENT override for the separate decision-stage consent. It is never
  // derived from the master override; an omitted field preserves the RAW stored
  // choice and a toggled field sends exactly one explicit boolean.
  const [decisionConsentOverride, setDecisionConsentOverride] = useState<
    boolean | null
  >(null);
  const [comparison, setComparison] = useState<{
    receipt: Entity;
    goal: Entity;
  } | null>(null);
  const [briefCount, setBriefCount] = useState<number | null | "unavailable">(
    null,
  );
  // Connections reports no client name, so a verified grant is shown generically.
  const brainState =
    notes.length === 0
      ? "Empty brain"
      : briefCount === "unavailable"
        ? "Couldn't check for changes"
        : !prefs
          ? ""
          : !prefs.enabled
            ? "Background help off"
            : briefCount === null
              ? "Checking…"
              : briefCount > 0
                ? `${briefCount} to look at`
                : "Caught up";
  const agentNamesByProject = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const g of grants)
      if (g.status === "Connected")
        for (const id of g.projects ?? [])
          (map[id] ??= []).push(g.client_name ?? "A connected agent");
    return map;
  }, [grants]);
  const [adapterSelection, setAdapterSelection] = useState<any>(null);
  const [adapterPreview, setAdapterPreview] = useState<any>(null);
  const [forgetProof, setForgetProof] = useState<any>(null);
  const [forgetNeedsRetry, setForgetNeedsRetry] = useState<string | null>(null);
  const [identityDisclosure, setIdentityDisclosure] = useState<any>(null);
  const [claimEntity, setClaimEntity] = useState("");
  const [claimKind, setClaimKind] = useState("status");
  const [claimStatus, setClaimStatus] = useState("active");
  const [claimMeaning, setClaimMeaning] = useState("");
  const [claimQuote, setClaimQuote] = useState("");
  const [dark, setDark] = useState(
    () => localStorage.getItem("brain-theme") === "dark",
  );
  useEffect(() => {
    const update = () => setNav(navFromHash());
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
    };
  }, []);
  useEffect(() => {
    const hash = (
      {
        Today: "#today",
        "Your brain": "#brain",
        Connections: "#connections",
        Settings: "#settings",
      } as Record<string, string>
    )[nav];
    if (hash && location.hash !== hash) history.pushState(null, "", hash);
  }, [nav]);
  useEffect(() => {
    // Managed accounts must never share a selected scope through global browser
    // storage; the selection lives only for this signed-in session.
    if (runtime?.mode === "managed") return;
    localStorage.setItem("brain-project", scope);
  }, [scope, runtime?.mode]);
  useEffect(() => {
    if (runtime?.mode !== "managed") return;
    // Do not let a stale local scope or search from another visitor bleed into
    // a managed session.
    setScope("inbox");
    try {
      localStorage.removeItem("brain-project");
    } catch {
      /* storage may be unavailable */
    }
  }, [runtime?.mode]);
  const scopeChecked = useRef(false);
  useEffect(() => {
    // Once, when the first list loads: a saved project that no longer exists would leave Your
    // brain on "Item unavailable." Later changes are the person's own and may precede a re-read.
    if (scopeChecked.current || !projects.length) return;
    scopeChecked.current = true;
    if (scope !== "inbox" && !projects.some((p) => p.id === scope)) setScope("inbox");
  }, [projects, scope]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("brain-theme", dark ? "dark" : "light");
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#111111" : "#f7f5ef");
  }, [dark]);
  const refresh = useCallback(async () => {
    const generation = authGeneration;
    const [p, n, t, settings, g, paidPlan, sortingStatus, recall] = await Promise.all([
      api("/projects"),
      api("/search"),
      api("/today"),
      api("/preferences/background"),
      api("/connections"),
      api<BillingStatus>("/billing/status"),
      // Sorting help is optional: a failed read says so on its card, never fails the rest.
      api<SortingStatus>("/system-one/status").catch(() => null),
      // A failed read leaves recall help shown as off.
      api<{ enabled: boolean }>("/preferences/recall-help").catch(() => ({ enabled: false })),
    ]);
    // A response that arrives after sign-out or an account change must not
    // restore the previous account's data.
    if (generation !== authGeneration) return;
    setProjects(p);
    setNotes(n);
    setToday(t);
    if (!preferencesDirty.current) setPrefs(settings);
    setSavedPrefs(settings);
    setGrants(g);
    setBilling(paidPlan);
    setSorting(sortingStatus);
    setSortingUnavailable(sortingStatus === null);
    if (!recallConsentTouched.current) setRecallHelp(recall.enabled === true);
    setSavedRecallHelp(recall.enabled === true);
  }, []);
  /**
   * Clears every piece of per-account UI state: fetched data, chosen scope,
   * search results, open dialogs, in-progress forms and one-time secrets.
   */
  const resetPersonalState = useCallback(() => {
    setProjects([]);
    setNotes([]);
    setRetiredReceipts([]);
    setToday({
      briefs: [],
      goals: [],
      proposals: [],
      receipts: [],
      pings: [],
      status: { jobs: [] },
    });
    setPrefs(null);
    setSorting(null);
    setSortingUnavailable(false);
    setRecallHelp(false);
    setSavedRecallHelp(false);
    recallConsentTouched.current = false;
    setSavedPrefs(null);
    setBriefCount(null);
    setGrants([]);
    setBilling(null);
    setScope("inbox");
    setIdentityDisclosure(null);
    setDialog(null);
    setConfirmation("");
    setPreview(null);
    setAdapterSelection(null);
    setAdapterPreview(null);
    setSource(null);
    setSourceView({});
    setProposal(null);
    setHandoff(null);
    setComparison(null);
    setForgetProof(null);
    setForgetNeedsRetry(null);
    setNotice("");
    setNewTitle("");
    setBody("");
    setCaptureScope("inbox");
    setVisibility("project");
    setSeparate(false);
    setProjectTitle("");
    setGoalTitle("");
    setCriteria("");
    setGoalDue("");
    setGoalReview("");
    setArtifact("");
    setToken("");
    setGrantProjects([]);
    setCanWrite(false);
    setGrantDuration(24);
    setAgentClient("codex");
    setSnooze("");
    setClaimEntity("");
    setClaimKind("status");
    setClaimStatus("active");
    setClaimMeaning("");
    setClaimQuote("");
    setBusy(false);
    preferencesDirty.current = false;
    setConsentOverride(null);
    setDecisionConsentOverride(null);
  }, []);
  /**
   * Central invalidation: advance the generation (fencing every in-flight
   * request), wipe all personal state, close dialogs and re-validate the real
   * runtime and session. A browser that now holds a different account enters
   * that account's workspace fresh.
   */
  const invalidateSession = useCallback(
    (options: { message?: string } = {}) => {
      authGeneration += 1;
      csrf = "";
      resetPersonalState();
      // Leave the authenticated UI immediately: no dialog or workspace view
      // may survive into the re-validation.
      setPaired(false);
      setAccountId(null);
      if (options.message) setError(options.message);
      else setError("");
      setRetryNonce((value) => value + 1);
    },
    [resetPersonalState],
  );
  const bootstrap = useCallback(async () => {
    const generation = (authGeneration += 1);
    setPhase("loading");
    setPaired(false);
    // A re-validation must never re-render a previous account's data, even
    // briefly, if the browser's credential changed while the runtime was down.
    resetPersonalState();
    let meta: RuntimeMeta | null = null;
    try {
      const value = await api("/runtime");
      if (isRuntimeMeta(value)) meta = value;
    } catch {
      meta = null;
    }
    if (generation !== authGeneration) return;
    if (!meta) {
      // No authenticated UI is shown until a real runtime response validates.
      setRuntime(null);
      setAccountId(null);
      setPaired(false);
      setPhase("unknown");
      return;
    }
    setRuntime(meta);
    let session: SessionInfo | null = null;
    if (pendingPairToken && meta.mode === "local") {
      const token = pendingPairToken;
      pendingPairToken = null;
      try {
        const s = await api<{ csrf: string }>("/session/pair-link/redeem", {
          token,
        });
        csrf = s.csrf;
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "This link was already used or has expired. Use the installation code instead.",
        );
      }
    }
    try {
      const value = await api("/session");
      if (isSessionInfo(value)) session = value;
    } catch (failure) {
      if (generation !== authGeneration) return;
      if (!(failure instanceof ApiError && failure.code === "UNAUTHORIZED")) {
        setAccountId(null);
        setPaired(false);
        setPhase("unknown");
        return;
      }
      session = null;
    }
    if (generation !== authGeneration) return;
    if (session) {
      csrf = session.csrf;
      setAccountId(session.account_id ?? null);
      setPaired(true);
      setPhase("ready");
      await refresh();
    } else {
      csrf = "";
      setAccountId(null);
      setPaired(false);
      setPhase("ready");
    }
  }, [refresh, resetPersonalState]);
  useEffect(() => {
    // Validate the runtime and the session against the real endpoints on first
    // paint and on every retry. The authenticated workspace stays unreachable
    // until a runtime response validates.
    void bootstrap();
  }, [bootstrap, retryNonce]);
  useEffect(() => {
    if (!paired || demo) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      const generation = authGeneration;
      api<SessionInfo>("/session")
        .then(async (session) => {
          if (generation !== authGeneration) return;
          // Compared independently of runtime mode, so a discovery gap cannot
          // hide an account switch.
          if ((session.account_id ?? null) !== accountId) {
            invalidateSession({
              message:
                "You signed in as a different account. Reload this page to see that account’s work.",
            });
            return;
          }
          await refresh();
        })
        .catch((failure) => {
          if (generation !== authGeneration) return;
          if (failure instanceof ApiError && failure.code === "UNAUTHORIZED") {
            invalidateSession({
              message:
                runtime?.mode === "managed"
                  ? "Your session ended. Sign in again to continue."
                  : "Your browser is no longer paired. Re-enter the installation code.",
            });
          } else {
            setError(
              runtime?.mode === "managed"
                ? "We could not reach your brain. Your work is safe; this page keeps trying."
                : "Your local brain is offline. Saved work remains on this computer.",
            );
          }
        });
    }, 2500);
    return () => clearInterval(timer);
  }, [paired, demo, refresh, runtime?.mode, accountId, invalidateSession]);
  useEffect(() => {
    if (!paired || demo) return;
    const url = new URL(location.href);
    if (url.searchParams.get("billing_return") !== "1") return;
    url.searchParams.delete("billing_return");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setNotice(
      "Payment was submitted. BiBrain is confirming it with the billing provider before enabling the plan.",
    );
    void refresh().catch(() => {});
  }, [paired, demo, refresh]);
  useEffect(() => {
    if (!paired || demo) return;
    let active = true;
    api(
      `/identity-disclosure?project_id=${encodeURIComponent(scope || "inbox")}`,
    )
      .then((value) => {
        if (active) setIdentityDisclosure(value);
      })
      .catch(() => {
        if (active) setIdentityDisclosure(null);
      });
    return () => {
      active = false;
    };
  }, [paired, demo, scope, today]);
  useEffect(() => {
    if (source && dialog === "source" && paired && !demo) {
      api<Source>(`/sources/${source.id}`)
        .then(setSource)
        .catch(() => {});
    }
  }, [today, dialog]);
  async function act(fn: () => Promise<void>) {
    // Capture the generation so a callback that resumes after an account
    // switch or sign-out cannot write a stale error or clear a new busy state.
    const generation = authGeneration;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (generation === authGeneration)
        setError(e instanceof Error ? e.message : "The operation failed.");
    } finally {
      if (generation === authGeneration) setBusy(false);
    }
  }
  /**
   * Builds a `/preferences/background` PATCH body from the current form state.
   * In managed mode it ALWAYS strips both RAW consent fields (`provider_enabled`
   * and `decision_provider_enabled`) so an unrelated save, a quick pause or any
   * other action can never echo the effective getter or re-grant a consent the user
   * did not touch. Callers that represent an explicit toggle re-add exactly that
   * field from its own override. Local mode keeps the full preference body.
   */
  function backgroundPatchBody(over: Record<string, unknown> = {}) {
    const body: Record<string, unknown> = { ...(prefs ?? {}), ...over };
    if (runtime?.mode === "managed") {
      delete body.provider_enabled;
      delete body.decision_provider_enabled;
    } else if (!("decision_provider_enabled" in over)) {
      // Local mode: sorting consent is sent only when the box itself was
      // changed, so an unrelated save never re-asks the worker for permission.
      delete body.decision_provider_enabled;
    }
    return body;
  }
  function close() {
    setDialog(null);
    setSourceView({});
    setConfirmation("");
    setPreview(null);
    setAdapterSelection(null);
    setAdapterPreview(null);
  }
  async function previewAdapter(
    kind: "folder" | "chat",
    list?: FileList | null,
    dropped?: { file: File; path: string }[],
  ) {
    const picked =
      dropped ??
      Array.from(list ?? []).map((file) => ({
        file,
        path:
          kind === "folder" ? file.webkitRelativePath || file.name : file.name,
      }));
    if (!picked.length) return;
    if (picked.length > 50)
      throw new Error("Choose at most 50 files per batch.");
    if (
      picked.some(({ file }) => file.size > 1048576) ||
      picked.reduce((sum, { file }) => sum + file.size, 0) > 4 * 1048576
    )
      throw new Error(
        "Each file must be at most 1 MiB and the batch at most 4 MiB.",
      );
    const generation = authGeneration;
    const selection = {
      kind,
      project_id: scope || "inbox",
      entries: await Promise.all(
        picked.map(async ({ file, path }) => ({
          path,
          content: await file.text(),
        })),
      ),
    };
    // Reading files is not an authenticated call: fence it explicitly so a
    // session change during a large read cannot open a stale dialog.
    if (generation !== authGeneration) return;
    setAdapterSelection(selection);
    setAdapterPreview(await api("/import-adapters/preview", selection));
    if (generation !== authGeneration) return;
    setDialog("adapter-import");
  }
  async function droppedFolder(data: DataTransfer) {
    // Folder traversal awaits FileSystem callbacks and can be suspended for a
    // long time. Capture the session generation now so a traversal that resumes
    // after an account switch is abandoned instead of previewing the previous
    // account's files under the new session.
    const generation = authGeneration;
    const stale = () => generation !== authGeneration;
    const picked: { file: File; path: string }[] = [];
    async function visit(
      entry: any,
      path: string,
      depth: number,
    ): Promise<void> {
      if (stale()) return;
      if (depth > 12 || picked.length > 50)
        throw new Error(
          "Folder nesting or file count exceeds the import limit.",
        );
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
          entry.file(resolve, reject),
        );
        if (stale()) return;
        picked.push({ file, path: `${path}${entry.name}` });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        while (true) {
          const batch = await new Promise<any[]>((resolve, reject) =>
            reader.readEntries(resolve, reject),
          );
          if (stale()) return;
          if (!batch.length) break;
          for (const child of batch) {
            if (stale()) return;
            await visit(child, `${path}${entry.name}/`, depth + 1);
          }
        }
      }
    }
    const roots = Array.from(data.items)
      .map((item: any) => item.webkitGetAsEntry?.())
      .filter(Boolean);
    if (roots.length)
      for (const entry of roots) {
        if (stale()) return;
        await visit(entry, "", 0);
      }
    else
      for (const file of Array.from(data.files))
        picked.push({ file, path: file.name });
    // Never hand a superseded traversal to the preview request.
    if (stale()) return;
    await previewAdapter("folder", undefined, picked);
  }
  function saveDialog() {
    setDialog("save");
    setNewTitle("");
    setBody("");
    setCaptureScope(scope || "inbox");
    setVisibility("project");
    setSeparate(false);
  }
  function connectAgent(projectIds: string[] = [scope || "inbox"]) {
    const available = new Set(projects.map((project) => project.id));
    const selected = projectIds.filter((id) => available.has(id));
    setGrantProjects(selected.length ? selected : [scope || "inbox"]);
    setToken("");
    setGrantDuration(24);
    setCanWrite(false);
    setDialog("grant");
  }
  /** Makes the Today receipt and answer let go of a note right away. */
  function retireReceipt(id: string) {
    setRetiredReceipts((ids) => [...ids, id]);
  }
  async function openSource(id: string, opts: OpenSourceOptions = {}) {
    await act(async () => {
      setSource(await api(`/sources/${id}`));
      setSourceView(opts);
      setDialog("source");
    });
  }
  const projectName = (id: string) =>
    projects.find((p) => p.id === id)?.title ?? "Project";
  const connectionProject = scope || "inbox";
  const field = (label: string, child: React.ReactNode) => (
    <label className="field">
      {label}
      {React.isValidElement(child)
        ? React.cloneElement(child as React.ReactElement<any>, {
            "aria-label": label,
          })
        : child}
    </label>
  );
  // Keep the disabled global action visible in the explicit disconnected
  // recovery state. It makes the unavailable boundary legible and preserves
  // the safety contract that a runtime discovery failure can never look paired.
  const showProductShell = paired || demo || phase === "unknown";
  async function importFile(file?: File) {
    if (!file) return;
    if (file.size > 4 * 1048576)
      throw new Error("Import exceeds the 4 MiB limit.");
    const generation = authGeneration;
    const text = await file.text();
    if (generation !== authGeneration) return;
    const result = await api("/imports/preview", JSON.parse(text));
    if (generation !== authGeneration) return;
    setPreview(result);
  }
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {showProductShell ? (
        <header className="masthead">
          <a
            className="brand"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setNav("Today");
            }}
          >
            <BrandLockup className="masthead-lockup" />
            <span className="tagline">One brain. Every agent.</span>
          </a>
          {brainState ? (
            <span className="tv-state" role="status">
              {brainState}
            </span>
          ) : null}
          <button
            className="primary"
            data-ui="save-something"
            disabled={!paired || demo}
            onClick={saveDialog}
          >
            ＋ Save something
          </button>
        </header>
      ) : null}
      <div className={`layout${showProductShell ? "" : " entry-layout"}`}>
        {showProductShell ? (
          <aside>
            <nav aria-label="Main navigation" data-ui="primary-navigation">
              {["Today", "Your brain", "Connections"].map((n) => (
                <button
                  key={n}
                  aria-current={nav === n ? "page" : undefined}
                  onClick={() => setNav(n)}
                >
                  <NavGlyph name={n} />
                  <span className="nav-label">{n}</span>
                </button>
              ))}
            </nav>
            <p className="rail-copy">
              Agents change.
              <br />
              Your brain stays yours.
            </p>
            <button
              className="link settings"
              onClick={() => setNav("Settings")}
              disabled={!paired || demo}
            >
              Settings & privacy
            </button>
            <small>
              {phase !== "ready"
                ? ""
                : runtime?.mode === "managed"
                  ? "Stored in your account"
                  : "Stored on this computer"}
            </small>
          </aside>
        ) : null}
        <main id="main-content">
          {demo ? (
            <div className="banner">
              <strong>Synthetic sample · nothing is saved</strong>
              <button onClick={() => setDemo(false)}>Return to my brain</button>
            </div>
          ) : null}
          {error ? (
            <div className="alert" role="alert">
              {error}
              <button className="link" onClick={() => setError("")}>
                Dismiss
              </button>
            </div>
          ) : null}
          {notice ? (
            <p className="status" role="status">
              {notice}
            </p>
          ) : null}
          {phase === "loading" ? (
            <p>Opening your brain…</p>
          ) : phase === "unknown" ? (
            <ConnectionUnavailable
              busy={busy}
              onRetry={() => setRetryNonce((value) => value + 1)}
            />
          ) : !paired && !demo ? (
            <SignIn
              mode={runtime?.mode ?? "local"}
              signInUrl={runtime?.sign_in_url ?? null}
              signInAvailable={runtime?.sign_in_available ?? false}
              busy={busy}
              onPair={(value) => {
                // A fresh credential fences any request that preceded pairing.
                authGeneration += 1;
                void act(async () => {
                  const s = await api("/session/pair", { secret: value });
                  csrf = s.csrf;
                  setAccountId(null);
                  setPaired(true);
                  await refresh();
                });
              }}
              onDemo={() => setDemo(true)}
            />
          ) : demo ? (
            <section>
              <p className="eyebrow">DEMO · SYNTHETIC MATERIAL</p>
              <h1>Try one conversation first.</h1>
              <p>
                This isolated example shows a source-backed proposal. Editing
                and saving are unavailable in this sample.
              </p>
              <article className="featured">
                <span className="pill">Prepared · not applied</span>
                <h2>{sample.proposals[0].title}</h2>
                <p>{sample.proposals[0].reason}</p>
                {sample.proposals[0].evidence.map((e) => (
                  <blockquote key={e.source_id}>{e.quote}</blockquote>
                ))}
                <ol>
                  {sample.proposals[0].suggested_steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <button disabled>Review actions unavailable in sample</button>
              </article>
            </section>
          ) : nav === "Today" ? (
            <TodayView
              api={api}
              projects={projects.map((p: any) => ({
                id: p.id,
                title: p.title,
                watched: p.watched !== false,
              }))}
              sourceCount={notes.length}
              notes={notes.map((n) => ({ id: n.id, title: n.title }))}
              retiredSourceIds={retiredReceipts}
              backgroundOn={!!prefs?.enabled}
              agentNamesByProject={agentNamesByProject}
              onOpenSource={(id, opts) => void openSource(id, opts)}
              onOpenProject={(id) => {
                setScope(id);
                setNav("Your brain");
              }}
              onNavigate={(to) => setNav(to)}
              onChanged={() => refresh()}
              onBriefCount={setBriefCount}
            />
          ) : nav === "Your brain" ? (
            <BrainView
              key={accountId ?? "local"}
              api={api}
              projects={projects.map((p: any) => ({
                id: p.id,
                title: p.title,
                watched: p.watched !== false,
              }))}
              projectId={scope || "inbox"}
              onChanged={() => refresh()}
              onSelectProject={(id) => setScope(id)}
              agentNamesByProject={agentNamesByProject}
              goals={today.goals}
              busy={busy}
              refreshKey={today}
              onOpenSource={(id, opts) => void openSource(id, opts)}
              onNewProject={() => setDialog("project")}
              onSave={saveDialog}
              onPreviewHandoff={(projectId) =>
                void act(async () => {
                  setHandoff(await api("/handoffs", { project_id: projectId }));
                  setDialog("handoff");
                })
              }
              onNavigate={(to) => setNav(to)}
              goalActions={{
                choose: (projectId) => {
                  setCaptureScope(projectId);
                  setDialog("goal");
                },
                setPreparation: (g, enabled) => {
                  setToday((current: any) => ({
                    ...current,
                    goals: current.goals.map((goal: Entity) =>
                      goal.id === g.id
                        ? { ...goal, data: { ...goal.data, preparation_enabled: enabled } }
                        : goal,
                    ),
                  }));
                  void act(async () => {
                    try {
                      await api(
                        `/goals/${g.id}`,
                        { expected_version: g.version, preparation_enabled: enabled },
                        "PATCH",
                      );
                    } finally {
                      await refresh();
                    }
                  });
                },
                prepare: (g) =>
                  void act(async () => {
                    await api(`/goals/${g.id}/prepare`, {});
                    setNotice("Preparation requested. It will appear in Today when ready.");
                  }),
                toggleStatus: (g) =>
                  void act(async () => {
                    await api(
                      `/goals/${g.id}`,
                      {
                        expected_version: g.version,
                        status: g.data.status === "active" ? "paused" : "active",
                      },
                      "PATCH",
                    );
                    await refresh();
                  }),
                editPlan: (g) => {
                  setProposal(g);
                  setArtifact(g.data.plan);
                  setDialog("plan");
                },
              }}
            />
          ) : nav === "Connections" ? (
            <section className="connections-view" data-ui="connections">
              <ConnectionsView
                api={api}
                projects={projects.map((p: any) => ({ id: p.id, title: p.title }))}
                projectId={scope || "inbox"}
                grants={grants}
                onChanged={refresh}
                onPreviewHandoff={(projectId) =>
                  void act(async () => {
                    setHandoff(await api("/handoffs", { project_id: projectId }));
                    setDialog("handoff");
                  })
                }
                onManualSetup={() => connectAgent()}
              />
              <details>
                <summary>Choose identity details an agent may receive</summary>
                <p>
                  Identity stays private unless you select a current field here.
                  Changing this setting invalidates earlier context packs and
                  handoffs.
                </p>
                {identityDisclosure?.claims.length ? (
                  identityDisclosure.claims.map((claim: any) => (
                    <label key={claim.id} className="field">
                      <span>
                        <input
                          type="checkbox"
                          checked={identityDisclosure.selected.includes(
                            claim.id,
                          )}
                          onChange={(e) =>
                            setIdentityDisclosure({
                              ...identityDisclosure,
                              selected: e.target.checked
                                ? [...identityDisclosure.selected, claim.id]
                                : identityDisclosure.selected.filter(
                                    (id: string) => id !== claim.id,
                                  ),
                            })
                          }
                        />{" "}
                        {claim.aspect}: {String(claim.value)}
                      </span>
                    </label>
                  ))
                ) : (
                  <p>No accepted identity fields in this project.</p>
                )}
                <button
                  disabled={busy || !identityDisclosure}
                  onClick={() =>
                    void act(async () => {
                      setIdentityDisclosure(
                        await api(
                          "/identity-disclosure",
                          {
                            project_id: scope || "inbox",
                            selected: identityDisclosure.selected,
                          },
                          "PATCH",
                        ),
                      );
                      setNotice(
                        "Identity sharing saved. Preview a new handoff before switching agents.",
                      );
                    })
                  }
                >
                  Save identity sharing
                </button>
              </details>
              <h2>Bring more context in</h2>
              <article>
                <h3>Bring in files or conversations</h3>
                <p>
                  Choose a local folder of text or Markdown, or a JSON chat
                  export for {projectName(connectionProject)}. Review the
                  detected items before saving. Attachments and unsupported
                  formats are skipped.
                </p>
                <button onClick={saveDialog}>Import a file</button>
                <div
                  className="dropzone"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void act(() => droppedFolder(e.dataTransfer));
                  }}
                >
                  Drop a folder of text or Markdown files here
                </div>
                {field(
                  "Choose a folder",
                  <input
                    type="file"
                    multiple
                    accept=".txt,.md"
                    {...({ webkitdirectory: "" } as any)}
                    onChange={(e) =>
                      void act(() => previewAdapter("folder", e.target.files))
                    }
                  />,
                )}
                {field(
                  "Choose a chat JSON export",
                  <input
                    type="file"
                    multiple
                    accept=".json,application/json"
                    onChange={(e) =>
                      void act(() => previewAdapter("chat", e.target.files))
                    }
                  />,
                )}
              </article>
            </section>
          ) : (
            <section>
              <p className="eyebrow">MAKE IT YOURS</p>
              <h1>Settings & privacy</h1>
              <article>
                <h2>Appearance</h2>
                <label>
                  <input
                    type="checkbox"
                    checked={dark}
                    onChange={(e) => setDark(e.target.checked)}
                  />{" "}
                  Dark appearance
                </label>
              </article>
              {runtime?.mode === "managed" ? (
                <article className="billing-card">
                  <p className="eyebrow">YOUR BIBRAIN PLAN</p>
                  <h2>
                    {billing?.available && billing.state === "active"
                      ? "Your plan is active"
                      : billing?.available && billing.state === "confirming"
                        ? "Confirming your plan"
                        : billing?.available && billing.state === "attention"
                          ? "Your plan needs attention"
                          : "Keep one brain across every agent"}
                  </h2>
                  {!billing ? (
                    <p className="muted">Checking your plan…</p>
                  ) : !billing.available ? (
                    <p className="muted">
                      {billing.reason} Your saved work, export, and connected
                      agents remain available.
                    </p>
                  ) : billing.state === "active" ? (
                    <>
                      <p>
                        Your {billing.cadence ?? "current"} plan is connected.
                        Billing never controls access to your saved work.
                      </p>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const session = await api<{ url: string }>(
                              "/billing/portal-session",
                              {},
                            );
                            location.assign(session.url);
                          })
                        }
                      >
                        Manage billing
                      </button>
                    </>
                  ) : billing.state === "confirming" ? (
                    <>
                      <p role="status">
                        BiBrain is confirming your payment. Your plan starts
                        only after confirmation. Your saved work is available
                        while you wait.
                      </p>
                      {billing.checkout_url ? (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const generation = authGeneration;
                              await openBillingCheckout(
                                billing,
                                billing.checkout_url!,
                              );
                              if (generation !== authGeneration) return;
                            })
                          }
                        >
                          Continue secure checkout
                        </button>
                      ) : null}
                    </>
                  ) : billing.state === "attention" ? (
                    <>
                      <p role="status">
                        New paid processing is paused. Your notes, memory,
                        connected agents, export, and corrections still work.
                      </p>
                      {billing.management_available ? (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const session = await api<{ url: string }>(
                                "/billing/portal-session",
                                {},
                              );
                              location.assign(session.url);
                            })
                          }
                        >
                          Review billing
                        </button>
                      ) : (
                        <p className="muted">
                          A checkout request may still be processing. BiBrain
                          won&apos;t start another one until it is resolved.
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p>
                        Choose how often to renew. Secure checkout opens with
                        Dodo Payments and shows the price, taxes, and currency
                        before you pay.
                      </p>
                      {billing.mode === "sandbox" ? (
                        <p className="status" role="status">
                          Test checkout · no real payment
                        </p>
                      ) : null}
                      <div className="plan-actions">
                        {(["monthly", "annual"] as const).map((cadence) => (
                          <button
                            key={cadence}
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                const generation = authGeneration;
                                const checkout = await api<{
                                  checkout_url: string;
                                  status: "confirming";
                                }>("/billing/checkout-intent", { cadence });
                                if (generation !== authGeneration) return;
                                setBilling({
                                  ...billing,
                                  state: "confirming",
                                  cadence,
                                  checkout_url: checkout.checkout_url,
                                });
                                await openBillingCheckout(
                                  billing,
                                  checkout.checkout_url,
                                );
                                if (generation !== authGeneration) return;
                              })
                            }
                          >
                            Choose {cadence}
                          </button>
                        ))}
                      </div>
                      <small className="muted">
                        No automatic overages. Cancelling never locks your
                        memory or export.
                      </small>
                    </>
                  )}
                </article>
              ) : null}
              {forgetProof ? (
                <article>
                  <h2>Last deletion check</h2>
                  <p>
                    {forgetProof.file_gone &&
                    forgetProof.index_gone &&
                    forgetProof.embedding_gone &&
                    forgetProof.graph_edge_gone
                      ? "Managed local copies passed read-after-delete checks."
                      : "One or more managed deletion checks is incomplete."}{" "}
                    Previously delivered copies and backups outside this app
                    still need separate handling.
                  </p>
                  <button onClick={() => setDialog("forget-proof")}>
                    View checks
                  </button>
                </article>
              ) : null}
              {prefs && savedPrefs && (sorting || sortingUnavailable) && runtime?.mode !== "managed" ? (
                <article>
                  <h2>Sorting help</h2>
                  <p>
                    BiBrain can suggest where a new note belongs and what is
                    worth your attention. It only suggests: nothing moves
                    without your Keep.
                  </p>
                  <p className="status" role="status">
                    {sorting
                      ? sortingLine(sorting, savedPrefs)
                      : "Sorting help status is unavailable right now."}
                  </p>
                  {sorting &&
                  (prefs.enabled !== savedPrefs.enabled ||
                    prefs.daily_cap_micro_usd !== savedPrefs.daily_cap_micro_usd ||
                    prefs.per_job_cap_micro_usd !== savedPrefs.per_job_cap_micro_usd ||
                    prefs.decision_provider_enabled !== savedPrefs.decision_provider_enabled) ? (
                    <p className="muted">Save to apply.</p>
                  ) : null}
                  <p className="muted">{savedRecallHelp ? "Recall help: on" : "Recall help: off"}</p>
                  {sorting?.configured && sorting.last_error ? (
                    <p className="muted">Last problem: {sorting.last_error}</p>
                  ) : null}
                  <div className="actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const log = await api("/system-one/log");
                          download(
                            "bibrain-review-log.json",
                            JSON.stringify(log, null, 2),
                            "application/json",
                          );
                          setNotice("Review log downloaded.");
                        })
                      }
                    >
                      Download the review log
                    </button>
                  </div>
                  <small className="muted">
                    The log lists what sorting help suggested and what you did
                    with it. It never contains your notes.
                  </small>
                </article>
              ) : null}
              {prefs ? (
                <article>
                  <h2>Background help & spending</h2>
                  <p>
                    Preparation runs while this computer and the worker are
                    awake. One bounded daily catch-up follows missed checks.
                  </p>
                  <form
                    onChange={() => {
                      preferencesDirty.current = true;
                    }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => {
                        const body = backgroundPatchBody(
                          sortingConsentTouched.current && prefs
                            ? { decision_provider_enabled: prefs.decision_provider_enabled }
                            : {},
                        );
                        if (runtime?.mode === "managed") {
                          // Send each consent field ONLY when the user explicitly
                          // toggled it; otherwise omit it so the raw stored value is
                          // preserved (never rewrite from the effective getter). The
                          // two overrides are independent.
                          if (consentOverride !== null)
                            body.provider_enabled = consentOverride;
                          if (decisionConsentOverride !== null)
                            body.decision_provider_enabled =
                              decisionConsentOverride;
                        }
                        let saved: Preferences;
                        try {
                          saved = await api("/preferences/background", body, "PATCH");
                        } catch (error) {
                          // A refused consent should say why in the worker's words.
                          if (body.decision_provider_enabled === true && runtime?.mode !== "managed") {
                            const now = await api<SortingStatus>("/system-one/status").catch(() => null);
                            if (now) setSorting(now);
                            if (now?.reason) throw new Error(now.reason);
                          }
                          throw error;
                        }
                        setPrefs(saved);
                        setSavedPrefs(saved);
                        if (runtime?.mode !== "managed") {
                          if (recallConsentTouched.current) {
                            try {
                              const r = await api<{ enabled: boolean }>("/preferences/recall-help", { enabled: recallHelp }, "PATCH");
                              setRecallHelp(r.enabled);
                              setSavedRecallHelp(r.enabled);
                            } catch (error) {
                              // A refused "on" says why and the box goes back to what is saved.
                              setRecallHelp(savedRecallHelp);
                              throw error;
                            } finally {
                              recallConsentTouched.current = false;
                            }
                          } else {
                            // Switching sorting help off also withdraws recall help; show what is stored now.
                            const r = await api<{ enabled: boolean }>("/preferences/recall-help").catch(() => null);
                            if (r) {
                              setRecallHelp(r.enabled);
                              setSavedRecallHelp(r.enabled);
                            }
                          }
                        }
                        api<SortingStatus>("/system-one/status")
                          .then((now) => {
                            setSorting(now);
                            setSortingUnavailable(false);
                          })
                          .catch(() => {});
                        setConsentOverride(null);
                        setDecisionConsentOverride(null);
                        preferencesDirty.current = false;
                        sortingConsentTouched.current = false;
                        setNotice("Background preferences saved.");
                      });
                    }}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={prefs.enabled}
                        onChange={(e) =>
                          setPrefs({ ...prefs, enabled: e.target.checked })
                        }
                      />{" "}
                      Turn on background help (sorting new notes and preparing reviews)
                    </label>
                    <div className="grid">
                      {field(
                        "Time zone",
                        <input
                          required
                          value={prefs.time_zone}
                          onChange={(e) =>
                            setPrefs({ ...prefs, time_zone: e.target.value })
                          }
                        />,
                      )}
                      {field(
                        "Daily check hour (0–23)",
                        <input
                          type="number"
                          min="0"
                          max="23"
                          value={prefs.digest_hour}
                          onChange={(e) =>
                            setPrefs({
                              ...prefs,
                              digest_hour: Number(e.target.value),
                            })
                          }
                        />,
                      )}
                      {field(
                        "Quiet hours start",
                        <input
                          type="number"
                          min="0"
                          max="23"
                          value={prefs.quiet_start}
                          onChange={(e) =>
                            setPrefs({
                              ...prefs,
                              quiet_start: Number(e.target.value),
                            })
                          }
                        />,
                      )}
                      {field(
                        "Quiet hours end",
                        <input
                          type="number"
                          min="0"
                          max="23"
                          value={prefs.quiet_end}
                          onChange={(e) =>
                            setPrefs({
                              ...prefs,
                              quiet_end: Number(e.target.value),
                            })
                          }
                        />,
                      )}
                      {field(
                        "Daily cap (USD)",
                        // Caps are integer micro-USD; 6-decimal USD precision
                        // keeps a valid sub-cent cap from tripping the browser
                        // stepMismatch and blocking Save preferences.
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.000001"
                          value={prefs.daily_cap_micro_usd / 1000000}
                          onChange={(e) =>
                            setPrefs({
                              ...prefs,
                              daily_cap_micro_usd: Math.round(
                                Number(e.target.value) * 1000000,
                              ),
                            })
                          }
                        />,
                      )}
                      {field(
                        "Per preparation cap (USD)",
                        // Caps are integer micro-USD; 6-decimal USD precision
                        // keeps a valid sub-cent cap from tripping the browser
                        // stepMismatch and blocking Save preferences.
                        <input
                          type="number"
                          min="0"
                          max="10"
                          step="0.000001"
                          value={prefs.per_job_cap_micro_usd / 1000000}
                          onChange={(e) =>
                            setPrefs({
                              ...prefs,
                              per_job_cap_micro_usd: Math.round(
                                Number(e.target.value) * 1000000,
                              ),
                            })
                          }
                        />,
                      )}
                    </div>
                    <p>
                      OpenAI receives selected shareable source text when you
                      enable paid preparation. Private sources stay local.
                      Backend key, model, and verified prices must be configured
                      by the operator. Your Codex subscription does not cover
                      these calls.
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        checked={
                          runtime?.mode === "managed"
                            ? (consentOverride ??
                              today.status.spend?.stored_consent_active ??
                              false)
                            : prefs.provider_enabled
                        }
                        disabled={
                          runtime?.mode === "managed"
                            ? !(
                                consentOverride ??
                                today.status.spend?.stored_consent_active ??
                                false
                              ) &&
                              !(
                                today.status.spend?.capability_ready &&
                                today.status.spend?.configured &&
                                ![
                                  "overrun",
                                  "restored_backup",
                                  "reconciliation_required",
                                  "disputed_usage",
                                ].includes(
                                  today.status.spend?.blocked_reason ?? "",
                                )
                              )
                            : today.status.spend?.blocked
                        }
                        onChange={(e) => {
                          if (runtime?.mode === "managed") {
                            setConsentOverride(e.target.checked);
                            preferencesDirty.current = true;
                          } else {
                            setPrefs({
                              ...prefs,
                              provider_enabled: e.target.checked,
                            });
                          }
                        }}
                      />{" "}
                      I authorize selected text to be processed by OpenAI within
                      these caps
                    </label>
                    {runtime?.mode !== "managed" && sorting ? (
                      <div>
                        <label>
                          <input
                            type="checkbox"
                            checked={prefs.decision_provider_enabled}
                            disabled={
                              !prefs.decision_provider_enabled &&
                              !sorting.configured
                            }
                            onChange={(e) => {
                              sortingConsentTouched.current = true;
                              setPrefs({
                                ...prefs,
                                decision_provider_enabled: e.target.checked,
                              });
                            }}
                          />{" "}
                          Let BiBrain sort new notes with{" "}
                          {sorting.label ?? "the sorting service"}. Costs count
                          against the limits below.
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={recallHelp}
                            disabled={!recallHelp && !(sorting.configured && prefs.decision_provider_enabled)}
                            onChange={(e) => {
                              recallConsentTouched.current = true;
                              setRecallHelp(e.target.checked);
                            }}
                          />{" "}
                          Recall help: when a connected agent asks a question, BiBrain may send that question, the matching passages and the names of your projects and topics to the same service to pick the right ones. Off by default.
                          {!recallHelp && !(sorting.configured && prefs.decision_provider_enabled) && <span className="muted"> Needs sorting help on first.</span>}
                        </label>
                      </div>
                    ) : null}
                    {runtime?.mode === "managed" ? (
                      <div>
                        <label>
                          <input
                            type="checkbox"
                            checked={
                              decisionConsentOverride ??
                              today.status.spend
                                ?.decision_stored_consent_active ??
                              false
                            }
                            disabled={
                              !(
                                decisionConsentOverride ??
                                today.status.spend
                                  ?.decision_stored_consent_active ??
                                false
                              ) &&
                              !(
                                today.status.spend?.decision_capability_ready &&
                                today.status.spend?.configured &&
                                ![
                                  "overrun",
                                  "restored_backup",
                                  "reconciliation_required",
                                  "disputed_usage",
                                ].includes(
                                  today.status.spend?.blocked_reason ?? "",
                                )
                              )
                            }
                            onChange={(e) => {
                              setDecisionConsentOverride(e.target.checked);
                              preferencesDirty.current = true;
                            }}
                          />{" "}
                          Additional background checks
                        </label>
                        <small className="muted">
                          Allow selected goal context to be sent to an
                          additional configured service for background checks.
                        </small>
                        <p className="muted" role="status">
                          {today.status.spend?.decision_stored_consent_active
                            ? today.status.spend?.decision_consent_effective
                              ? "Additional background checks are authorized for this account."
                              : today.status.spend?.decision_capability_ready
                                ? today.status.spend?.stored_consent_active
                                  ? "Your authorization for additional background checks is saved. Paid processing is not available right now; saved work stays available."
                                  : "Your authorization for additional background checks is saved. The connected-model consent is also required; saved work stays available."
                                : "Your authorization for additional background checks is saved; this installation cannot run them right now. You can withdraw it any time."
                            : today.status.spend?.decision_capability_ready
                              ? "Additional background checks are available for this installation."
                              : "Additional background checks are not available on this installation."}
                        </p>
                      </div>
                    ) : null}
                    {runtime?.mode === "managed" ? (
                      <p className="muted" role="status">
                        {today.status.spend?.consent_effective
                          ? today.status.spend?.paused
                            ? "Connected model processing is temporarily awaiting usage accounting. Your saved work stays available."
                            : "Connected model processing is ready for this deployment."
                          : today.status.spend?.stored_consent_active
                            ? "Your authorization is saved. Connected model processing is not available right now; saved work stays extractive."
                            : today.status.spend?.capability_ready
                              ? "Connected model processing is ready; authorize selected text below within your caps."
                              : "Connected model processing is not available for this deployment. Your saved work stays extractive."}
                      </p>
                    ) : null}
                    <div className="actions">
                      <button className="primary" disabled={busy}>
                        Save preferences
                      </button>
                    </div>
                  </form>
                  <p className="muted">
                    {runtime?.mode === "managed"
                      ? `Connected processing ${
                          today.status.spend?.capability_ready
                            ? "ready"
                            : "unavailable"
                        }`
                      : `Provider key ${
                          today.status.provider_configured
                            ? "configured"
                            : "not configured"
                        }`}{" "}
                    · settled{" "}
                    {formatUsd(today.status.spend?.settled_micro_usd ?? 0)} ·
                    unresolved (usage unknown){" "}
                    {formatUsd(today.status.spend?.unresolved_micro_usd ?? 0)}
                    {today.status.spend?.time_zone
                      ? ` · ${today.status.spend.budget_day} ${today.status.spend.time_zone}`
                      : ""}
                  </p>
                  {runtime?.mode === "managed" ? (
                    <p className="muted" role="status">
                      {today.status.spend?.available
                        ? "Managed paid processing is available within your operator allowance."
                        : today.status.spend?.paused
                          ? "Connected processing is temporarily awaiting usage accounting; saved work stays available."
                          : today.status.spend?.configured
                            ? "Your managed allowance is configured; paid processing is not available right now. Saved work stays available."
                            : "Managed paid processing is not enabled. Saved work stays available."}
                      {today.status.spend?.allowance
                        ? ` Allowance left ${formatUsd(
                            today.status.spend.allowance.remaining_micro_usd,
                          )}.`
                        : ""}
                    </p>
                  ) : null}
                  {today.status.spend?.blocked ? (
                    <p className="muted" role="status">
                      {today.status.spend.blocked_message}
                    </p>
                  ) : null}
                </article>
              ) : null}
              <article>
                <h2>Your data</h2>
                <p>
                  Local SQLite storage is unencrypted. Exports exclude
                  credentials. Deleting a source removes its history and
                  affected understanding; existing backups can retain earlier
                  content.
                </p>
                <div className="actions">
                  <button
                    onClick={() =>
                      void act(async () =>
                        download(
                          "bi-brain.json",
                          JSON.stringify(await api("/exports", {}), null, 2),
                          "application/json",
                        ),
                      )
                    }
                  >
                    Export my brain
                  </button>
                  <button onClick={() => setDialog("import")}>
                    Import an export
                  </button>
                  <button
                    onClick={() =>
                      void act(async () => {
                        // Best-effort server sign-out; the local session and all
                        // personal state are cleared regardless of the result.
                        await api("/session", {}, "DELETE").catch(() => {});
                        invalidateSession();
                      })
                    }
                  >
                    {runtime?.mode === "managed"
                      ? "Sign out"
                      : "Unpair this browser"}
                  </button>
                </div>
              </article>
              <article>
                <h2>Preparation status</h2>
                <p>
                  {today.status.worker_online
                    ? "Worker is available."
                    : "Worker is offline. Run npm run worker to resume."}
                </p>
                {today.status.jobs.map((j: any) => (
                  <div className="job" key={j.id}>
                    <strong>{j.status}</strong>
                    <span>{j.error ?? "Saved work preparation"}</span>
                    {["failed", "cancelled"].includes(j.status) ? (
                      <button
                        onClick={() =>
                          void act(async () => {
                            await api(`/jobs/${j.id}/retry`, {});
                            await refresh();
                          })
                        }
                      >
                        Retry
                      </button>
                    ) : ["queued", "running", "retry_wait"].includes(
                        j.status,
                      ) ? (
                      <button
                        onClick={() =>
                          void act(async () => {
                            await api(`/jobs/${j.id}/cancel`, {});
                            await refresh();
                          })
                        }
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                ))}
              </article>
            </section>
          )}
          <footer>
            One brain. Every agent. Always caught up. A little ahead.
            <span>
              {phase !== "ready"
                ? "Not connected"
                : demo
                  ? "Synthetic sample · nothing is saved"
                  : runtime?.mode === "managed"
                    ? "Your account · your brain · your choice of agent"
                    : "Local preview · your data stays under your control"}
            </span>
          </footer>
        </main>
      </div>
      {paired && !demo ? (
        <>
          {dialog === "save" ? (
            <Modal error={error} title="Save something" close={close}>
              <p>
                Text or Markdown · up to 100,000 characters and 1 MiB. Your
                original is retained before preparation.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const saved = await api("/sources", {
                      title:
                        newTitle ||
                        body.trim().split("\n")[0].slice(0, 80) ||
                        "Untitled note",
                      body,
                      project_id: captureScope,
                      visibility,
                      separate,
                    });
                    setSource(await api(`/sources/${saved.source_id}`));
                    setSourceView({});
                    await refresh();
                    setDialog("source");
                    setNotice(
                      saved.quarantined
                        ? saved.warning
                        : saved.duplicate
                          ? "This exact text is already saved. Opened the original."
                          : "Saved to your brain. Preparation follows separately.",
                    );
                  });
                }}
              >
                {field(
                  "Title",
                  <input
                    maxLength={200}
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="Give it a familiar name"
                  />,
                )}
                {field(
                  "Paste something you are working on",
                  <textarea
                    required
                    rows={9}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    maxLength={200000}
                    placeholder="A conversation, a decision, a note…"
                  />,
                )}
                {field(
                  "Or import a text file",
                  <input
                    type="file"
                    accept=".txt,.md,text/plain,text/markdown"
                    onChange={(e) =>
                      void act(async () => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        if (
                          !/\.(txt|md)$/i.test(file.name) ||
                          file.size > 1048576
                        )
                          throw new Error(
                            "Choose a .txt or .md file no larger than 1 MiB.",
                          );
                        const generation = authGeneration;
                        const text = await file.text();
                        if (generation !== authGeneration) return;
                        setBody(text);
                        setNewTitle(file.name.replace(/\.(txt|md)$/i, ""));
                      })
                    }
                  />,
                )}
                <div className="grid">
                  {field(
                    "Project",
                    <select
                      value={captureScope}
                      onChange={(e) => setCaptureScope(e.target.value)}
                    >
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                    </select>,
                  )}
                  {field(
                    "Who can use it?",
                    <select
                      value={visibility}
                      onChange={(e) => setVisibility(e.target.value)}
                    >
                      <option value="project">
                        Agents with this project’s access
                      </option>
                      <option value="private">Only me — keep private</option>
                    </select>,
                  )}
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={separate}
                    onChange={(e) => setSeparate(e.target.checked)}
                  />{" "}
                  Keep a separately dated occurrence if already saved
                </label>
                <div className="actions">
                  <button className="primary" disabled={busy}>
                    Save to my brain
                  </button>
                  <button type="button" onClick={close}>
                    Cancel
                  </button>
                </div>
              </form>
            </Modal>
          ) : null}
          {dialog === "source" && source ? (
            <Modal
              error={error}
              title={source.title}
              close={close}
              variant="inspector"
              dataUi="source-viewer"
            >
              <SourceView
                api={api}
                source={source}
                quote={sourceView.quote}
                factId={sourceView.factId}
                projectTitle={projectName(source.project_id)}
                actions={
                    <div className="actions">
                      <button
                        onClick={() => {
                          setBody(source.body);
                          setNewTitle(source.title);
                          setCaptureScope(source.project_id);
                          setVisibility(source.visibility);
                          setDialog("edit-source");
                        }}
                      >
                        Correct or move source
                      </button>
                      <button
                        onClick={() => {
                          setClaimEntity("");
                          setClaimKind("status");
                          setClaimStatus("active");
                          setClaimMeaning("");
                          setClaimQuote(source.body.slice(0, 300));
                          setDialog("propose-claim");
                        }}
                      >
                        Add a fact for review
                      </button>
                      <button
                        onClick={() => {
                          setConfirmation("");
                          setDialog("delete");
                        }}
                      >
                        Delete / withdraw
                      </button>
                      {source.version > 1 ? (
                        <button
                          onClick={() =>
                            void act(async () => {
                              setSource(
                                await api(
                                  `/sources/${source.id}?version=${source.version - 1}`,
                                ),
                              );
                              setDialog("history");
                            })
                          }
                        >
                          Earlier version
                        </button>
                      ) : null}
                    </div>
                }
              />
            </Modal>
          ) : null}
          {dialog === "propose-claim" && source ? (
            <Modal
              error={error}
              title="Add a fact from this original"
              close={close}
            >
              <p>
                Tell BiBrain what an exact passage means. It stays a suggestion
                until you review it, and the original always remains
                inspectable.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    await api(`/sources/${source.id}/claim-proposals`, {
                      expected_version: source.version,
                      type: claimKind === "status" ? "fact" : claimKind,
                      entity: claimEntity,
                      field:
                        claimKind === "status"
                          ? { aspect: "status", value: claimStatus }
                          : { aspect: "statement", value: claimMeaning },
                      quote: claimQuote,
                    });
                    setScope(source.project_id);
                    setNav("Your brain");
                    close();
                    await refresh();
                    setNotice(
                      "Fact proposed. Review it before it becomes current understanding.",
                    );
                  });
                }}
              >
                <label className="field">
                  Topic or entity
                  <input
                    required
                    maxLength={200}
                    value={claimEntity}
                    onChange={(event) => setClaimEntity(event.target.value)}
                  />
                </label>
                <label className="field">
                  What kind of memory is this?
                  <select
                    value={claimKind}
                    onChange={(event) => setClaimKind(event.target.value)}
                  >
                    <option value="status">A status</option>
                    <option value="fact">A fact</option>
                    <option value="decision">A decision</option>
                    <option value="rule">A rule</option>
                    <option value="hypothesis">A possibility</option>
                  </select>
                </label>
                {claimKind === "status" ? (
                  <label className="field">
                    Status
                    <select
                      value={claimStatus}
                      onChange={(event) => setClaimStatus(event.target.value)}
                    >
                      {(
                        [
                          "planned",
                          "active",
                          "paused",
                          "done",
                          "cancelled",
                        ] as const
                      ).map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="field">
                    What should BiBrain remember?
                    <input
                      required
                      maxLength={1000}
                      value={claimMeaning}
                      onChange={(event) => setClaimMeaning(event.target.value)}
                      placeholder="Write the meaning in your own words"
                    />
                  </label>
                )}
                <label className="field">
                  Exact passage from original
                  <textarea
                    required
                    maxLength={10000}
                    value={claimQuote}
                    onChange={(event) => setClaimQuote(event.target.value)}
                  />
                </label>
                <button className="primary" type="submit">
                  Send for review
                </button>
              </form>
            </Modal>
          ) : null}
          {dialog === "history" && source ? (
            <Modal
              error={error}
              title={`Earlier source · v${source.version}`}
              close={close}
              variant="inspector"
            >
              <p>
                Historical provenance. Active context uses the latest version.
              </p>
              <pre>{source.body}</pre>
              <button onClick={() => void openSource(source.id)}>
                Return to current original
              </button>
            </Modal>
          ) : null}
          {dialog === "edit-source" && source ? (
            <Modal error={error} title="Correct saved material" close={close}>
              <p>
                Your edit creates a new version. Earlier text stays in source
                history until permanent deletion.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    setSource(
                      await api(`/sources/${source.id}/versions`, {
                        expected_version: source.version,
                        title: newTitle,
                        body,
                        project_id: captureScope,
                        visibility,
                      }),
                    );
                    setRetiredReceipts((ids) => [...ids, source.id]);
                    await refresh();
                    setDialog("source");
                    setNotice(
                      "Correction saved. Earlier understanding is updating.",
                    );
                  });
                }}
              >
                {field(
                  "Title",
                  <input
                    required
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                  />,
                )}
                {field(
                  "Source text",
                  <textarea
                    required
                    rows={10}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />,
                )}
                {field(
                  "Project",
                  <select
                    value={captureScope}
                    onChange={(e) => setCaptureScope(e.target.value)}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>,
                )}
                {field(
                  "Visibility",
                  <select
                    value={visibility}
                    onChange={(e) => setVisibility(e.target.value)}
                  >
                    <option value="project">Project</option>
                    <option value="private">Private</option>
                  </select>,
                )}
                <button className="primary" disabled={busy}>
                  Save correction
                </button>
              </form>
            </Modal>
          ) : null}
          {dialog === "delete" && source ? (
            <Modal error={error} title="Remove saved material" close={close}>
              <p>
                Withdrawal excludes this source from retrieval immediately.
                Permanent deletion purges all versions and affected
                understanding. Earlier backups may retain it.
              </p>
              <button
                onClick={() =>
                  void act(async () => {
                    await api(`/sources/${source.id}/withdraw`, {
                      expected_version: source.version,
                    });
                    retireReceipt(source.id);
                    await refresh();
                    close();
                    setNotice("Source withdrawn from active retrieval.");
                  })
                }
              >
                Withdraw from active use
              </button>
              {field(
                "Type DELETE to permanently purge",
                <input
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />,
              )}
              <button
                className="danger"
                disabled={confirmation !== "DELETE" || busy}
                onClick={() =>
                  void act(async () => {
                    const result = await api(
                      `/sources/${source.id}`,
                      { expected_version: source.version, confirmation },
                      "DELETE",
                    ).catch((failure) => {
                      if (
                        failure instanceof ApiError &&
                        failure.code === "FORGET_INCOMPLETE"
                      ) {
                        setForgetNeedsRetry(source.id);
                        retireReceipt(source.id);
                      }
                      throw failure;
                    });
                    setForgetNeedsRetry(null);
                    setForgetProof(result.proof ?? null);
                    setSource(null);
                    retireReceipt(source.id);
                    await refresh();
                    close();
                    setNotice(
                      result.proof &&
                        ![
                          result.proof.file_gone,
                          result.proof.index_gone,
                          result.proof.embedding_gone,
                          result.proof.graph_edge_gone,
                        ].every(Boolean)
                        ? "Source removed from active use, but a managed deletion check is incomplete. Open Settings for details."
                        : "Source history and affected understanding deleted from managed local stores. Open Settings for verification details.",
                    );
                  })
                }
              >
                Permanently delete
              </button>
              {forgetNeedsRetry === source.id ? (
                <button
                  onClick={() =>
                    void act(async () => {
                      const proof = await api(
                        `/sources/${source.id}/finalize-forget`,
                        {},
                      );
                      setForgetProof(proof);
                      setForgetNeedsRetry(null);
                      setSource(null);
                      retireReceipt(source.id);
                      await refresh();
                      close();
                      setNotice(
                        "Managed deletion checks completed. Open Settings for details.",
                      );
                    })
                  }
                >
                  Retry managed erasure
                </button>
              ) : null}
            </Modal>
          ) : null}
          {dialog === "project" ? (
            <Modal error={error} title="Create a project" close={close}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const p = await api("/projects", { title: projectTitle });
                    setScope(p.id);
                    setProjectTitle("");
                    await refresh();
                    close();
                  });
                }}
              >
                {field(
                  "Project name",
                  <input
                    required
                    maxLength={200}
                    value={projectTitle}
                    onChange={(e) => setProjectTitle(e.target.value)}
                  />,
                )}
                <button className="primary" disabled={busy}>
                  Create project
                </button>
              </form>
            </Modal>
          ) : null}
          {dialog === "goal" ? (
            <Modal error={error} title="Choose a goal" close={close}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    await api("/goals", {
                      project_id: captureScope,
                      title: goalTitle,
                      success_criteria: criteria,
                      ...(goalDue
                        ? { due_at: new Date(goalDue).toISOString() }
                        : {}),
                      ...(goalReview
                        ? { review_at: new Date(goalReview).toISOString() }
                        : {}),
                    });
                    await refresh();
                    close();
                    setGoalTitle("");
                    setCriteria("");
                    setGoalDue("");
                    setGoalReview("");
                    setNotice(
                      "Goal saved. Enable preparation when you’re ready.",
                    );
                  });
                }}
              >
                {field(
                  "Project",
                  <select
                    value={captureScope}
                    onChange={(e) => setCaptureScope(e.target.value)}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>,
                )}
                {field(
                  "What do you want to accomplish?",
                  <input
                    required
                    maxLength={200}
                    value={goalTitle}
                    onChange={(e) => setGoalTitle(e.target.value)}
                  />,
                )}
                {field(
                  "What would success look like?",
                  <textarea
                    rows={4}
                    maxLength={2000}
                    value={criteria}
                    onChange={(e) => setCriteria(e.target.value)}
                  />,
                )}
                {field(
                  "Due (optional, this computer's time zone)",
                  <input
                    type="datetime-local"
                    value={goalDue}
                    onChange={(e) => setGoalDue(e.target.value)}
                  />,
                )}
                {field(
                  "Begin reviewing (optional, this computer's time zone)",
                  <input
                    type="datetime-local"
                    value={goalReview}
                    onChange={(e) => setGoalReview(e.target.value)}
                  />,
                )}
                <button className="primary" disabled={busy}>
                  Save goal
                </button>
              </form>
            </Modal>
          ) : null}
          {dialog === "review" && proposal ? (
            <Modal error={error} title={proposal.data.title} close={close}>
              <span className="pill">Hypothesis · Prepared, not applied</span>
              <p>{proposal.data.reason}</p>
              <h3>Earlier plan</h3>
              <pre>
                {today.goals.find((g: Entity) => g.id === proposal.data.goal_id)
                  ?.data.plan || "No accepted plan yet."}
              </pre>
              <h3>Saved evidence</h3>
              <EvidenceList
                items={proposal.data.evidence}
                onOpen={(id) => void openSource(id)}
              />
              {field(
                "Proposed plan — edit before accepting",
                <textarea
                  rows={9}
                  value={artifact}
                  onChange={(e) => setArtifact(e.target.value)}
                  maxLength={20000}
                />,
              )}
              <div className="actions">
                <button
                  className="primary"
                  disabled={busy || !artifact.trim()}
                  onClick={() =>
                    void act(async () => {
                      await api(`/proposals/${proposal.id}/accept`, {
                        expected_version: proposal.version,
                        edited_artifact: artifact,
                      });
                      await refresh();
                      close();
                      setNotice(
                        "Plan accepted. You can undo it unless a later edit changes the plan.",
                      );
                    })
                  }
                >
                  Keep this plan
                </button>
                <button
                  onClick={() => {
                    setSnooze("");
                    setDialog("snooze");
                  }}
                >
                  Later
                </button>
                <button
                  onClick={() =>
                    void act(async () => {
                      await api(`/proposals/${proposal.id}/dismiss`, {
                        expected_version: proposal.version,
                      });
                      await refresh();
                      close();
                      setNotice(
                        "Dismissed. The same evidence will not prompt you again.",
                      );
                    })
                  }
                >
                  Not useful
                </button>
              </div>
            </Modal>
          ) : null}
          {dialog === "snooze" && proposal ? (
            <Modal error={error} title="Review later" close={close}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    await api(`/proposals/${proposal.id}/snooze`, {
                      expected_version: proposal.version,
                      until: new Date(snooze).toISOString(),
                    });
                    await refresh();
                    close();
                    setNotice(
                      "Snoozed until " +
                        new Date(snooze).toLocaleString() +
                        ".",
                    );
                  });
                }}
              >
                {field(
                  "Remind me in Today at",
                  <input
                    type="datetime-local"
                    required
                    value={snooze}
                    onChange={(e) => setSnooze(e.target.value)}
                  />,
                )}
                <button className="primary" disabled={busy}>
                  Snooze
                </button>
              </form>
            </Modal>
          ) : null}
          {dialog === "compare" && comparison ? (
            <Modal
              error={error}
              title="Your plan changed after acceptance"
              close={close}
            >
              <p>
                Undo cannot replace a later edit. Compare your plans before
                making a new revision.
              </p>
              <h3>Before acceptance</h3>
              <pre>
                {comparison.receipt.data.previous_plan || "No previous plan."}
              </pre>
              <h3>Current plan</h3>
              <pre>{comparison.goal.data.plan || "No current plan."}</pre>
              <div className="row">
                <button onClick={close}>Keep current plan</button>
                <button
                  className="primary"
                  onClick={() => {
                    setProposal(comparison.goal);
                    setArtifact(comparison.goal.data.plan ?? "");
                    setDialog("plan");
                  }}
                >
                  Edit current plan
                </button>
              </div>
            </Modal>
          ) : null}
          {dialog === "handoff" && handoff ? (
            <Modal error={error} title="Project handoff" close={close}>
              <p>
                Accepted evidence and open intentions from{" "}
                {projectName(handoff.project_id)}. This preview does not open an
                external agent.
              </p>
              <pre>{handoff.data.text}</pre>
              <div className="actions">
                <button
                  onClick={() =>
                    void act(async () => {
                      await navigator.clipboard.writeText(handoff.data.text);
                      setNotice("Handoff copied.");
                    })
                  }
                >
                  Copy handoff
                </button>
                <button
                  onClick={() =>
                    download("bi-brain-handoff.md", handoff.data.text)
                  }
                >
                  Download Markdown
                </button>
              </div>
            </Modal>
          ) : null}
          {dialog === "adapter-import" && adapterPreview && adapterSelection ? (
            <Modal error={error} title="Review import" close={close}>
              <p>
                {adapterPreview.items.length} text items ready for{" "}
                {projectName(adapterSelection.project_id)}. Imported
                conversation messages are saved as evidence, not instructions.
              </p>
              <ul>
                {adapterPreview.items.slice(0, 50).map((item: any) => (
                  <li key={item.path}>{item.title}</li>
                ))}
              </ul>
              {adapterPreview.warnings.length ? (
                <details>
                  <summary>
                    {adapterPreview.warnings.length} skipped or limited
                  </summary>
                  <ul>
                    {adapterPreview.warnings.map((warning: string) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <button
                className="primary"
                disabled={busy || !adapterPreview.items.length}
                onClick={() =>
                  void act(async () => {
                    const result = await api("/import-adapters/apply", {
                      selection: adapterSelection,
                      checkpoint: adapterPreview.checkpoint,
                    });
                    await refresh();
                    close();
                    setNotice(
                      `${result.imported} saved, ${result.duplicates} already present. Review current understanding when preparation finishes.`,
                    );
                  })
                }
              >
                Save selected items
              </button>
            </Modal>
          ) : null}
          {dialog === "forget-proof" && forgetProof ? (
            <Modal error={error} title="Managed deletion checks" close={close}>
              <ul>
                <li>
                  Vault files and managed history:{" "}
                  {forgetProof.file_gone ? "gone" : "incomplete"}
                </li>
                <li>
                  Search and retained records:{" "}
                  {forgetProof.index_gone ? "gone" : "incomplete"}
                </li>
                <li>
                  Embeddings:{" "}
                  {forgetProof.per_store.embeddings.configured
                    ? "configured; check incomplete"
                    : "not configured; no active store"}
                </li>
                <li>
                  Graph edges:{" "}
                  {forgetProof.per_store.graph.configured
                    ? "configured; check incomplete"
                    : "not configured; no active store"}
                </li>
              </ul>
              <p>
                Verified {new Date(forgetProof.verified_at).toLocaleString()}.
                Unmanaged backups and copies already sent to a client or
                provider cannot be verified here.
              </p>
              <details>
                <summary>Proof details</summary>
                <pre>{JSON.stringify(forgetProof, null, 2)}</pre>
              </details>
            </Modal>
          ) : null}
          {dialog === "plan" && proposal ? (
            <Modal error={error} title="Edit your plan" close={close}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    await api(
                      `/goals/${proposal.id}`,
                      { expected_version: proposal.version, plan: artifact },
                      "PATCH",
                    );
                    await refresh();
                    close();
                  });
                }}
              >
                {field(
                  "Plan",
                  <textarea
                    rows={10}
                    maxLength={20000}
                    value={artifact}
                    onChange={(e) => setArtifact(e.target.value)}
                  />,
                )}
                <button className="primary" disabled={busy}>
                  Save plan revision
                </button>
              </form>
            </Modal>
          ) : null}
          {dialog === "grant" ? (
            <Modal
              error={error}
              title="Connect an agent"
              close={close}
              dataUi="permission-preview"
            >
              {token ? (
                <AgentSetupGuide
                  client={agentClient}
                  token={token}
                  apiUrl={location.origin}
                  busy={busy}
                  onCopyToken={() =>
                    void act(async () => {
                      await navigator.clipboard.writeText(token);
                      setNotice("Connection key copied. Keep it private.");
                    })
                  }
                  onCopySetup={() =>
                    void act(async () => {
                      await navigator.clipboard.writeText(
                        agentSetupCommand(agentClient, location.origin),
                      );
                      setNotice(
                        `${agentClient === "codex" ? "Codex" : "Claude Code"} setup copied. Paste it into a private PowerShell in this BiBrain folder.`,
                      );
                    })
                  }
                  onDone={close}
                />
              ) : (
                <form
                  className="connection-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      const result = await api("/agent-grants", {
                        client: agentClient,
                        projects: grantProjects,
                        operations: canWrite
                          ? ["read", "propose_memory"]
                          : ["read"],
                        expires_at: new Date(
                          Date.now() + grantDuration * 60 * 60 * 1000,
                        ).toISOString(),
                      });
                      setToken(result.token);
                      await refresh();
                    });
                  }}
                >
                  <p>
                    Choose where you want to continue, then select the smallest
                    amount of access it needs. You can revoke it instantly.
                  </p>
                  <AgentClientPicker
                    value={agentClient}
                    onChange={setAgentClient}
                  />
                  <fieldset className="connection-permissions">
                    <legend>What may this agent read?</legend>
                    {projects.map((p) => (
                      <label className="check" key={p.id}>
                        <input
                          type="checkbox"
                          name="agent-project"
                          value={p.id}
                          checked={grantProjects.includes(p.id)}
                          onChange={(e) =>
                            setGrantProjects(
                              e.target.checked
                                ? [...grantProjects, p.id]
                                : grantProjects.filter((id) => id !== p.id),
                            )
                          }
                        />
                        {p.title}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset className="connection-permissions">
                    <legend>What may it do?</legend>
                    <label className="connection-choice compact">
                      <input
                        type="radio"
                        name="agent-access"
                        checked={!canWrite}
                        onChange={() => setCanWrite(false)}
                      />
                      <span>
                        <strong>Read only</strong>
                        <small>
                          Recommended · recall selected accepted memory.
                        </small>
                      </span>
                    </label>
                    <label className="connection-choice compact">
                      <input
                        type="radio"
                        name="agent-access"
                        checked={canWrite}
                        onChange={() => setCanWrite(true)}
                      />
                      <span>
                        <strong>Read and suggest</strong>
                        <small>
                          Suggestions still wait for your review and cannot
                          overwrite decisions.
                        </small>
                      </span>
                    </label>
                  </fieldset>
                  {field(
                    "Access duration",
                    <select
                      name="agent-duration"
                      value={grantDuration}
                      onChange={(e) => setGrantDuration(Number(e.target.value))}
                    >
                      <option value={24}>One day</option>
                      <option value={168}>Seven days</option>
                      <option value={720}>Thirty days</option>
                    </select>,
                  )}
                  <p className="permission-note">
                    Private sources are always excluded. A connection cannot
                    change permissions, delete your work, or accept its own
                    suggestions.
                  </p>
                  <button
                    className="primary"
                    disabled={busy || !grantProjects.length}
                  >
                    Create private connection
                  </button>
                </form>
              )}
            </Modal>
          ) : null}
          {dialog === "import" ? (
            <Modal error={error} title="Import your brain" close={close}>
              <p>
                Choose a BiBrain JSON export. Preview before applying.
                Conflicting originals block the entire import.
              </p>
              {field(
                "Export file",
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) =>
                    void act(() => importFile(e.target.files?.[0]))
                  }
                />,
              )}
              {preview ? (
                <>
                  <p>
                    {preview.projects} projects · {preview.sources} source
                    versions · {preview.conflicts.length} conflicts
                  </p>
                  <p>{preview.policy}</p>
                  <details>
                    <summary>Review material before importing</summary>
                    {preview.source_preview.map((s: any, index: number) => (
                      <article key={index}>
                        <h3>
                          {s.title} · v{s.version} · {s.visibility}
                        </h3>
                        <pre>{s.body}</pre>
                      </article>
                    ))}
                    {preview.plan_preview.map((g: any, index: number) => (
                      <article key={index}>
                        <h3>{g.title}</h3>
                        <pre>{g.plan || "No accepted plan"}</pre>
                      </article>
                    ))}
                  </details>
                  <button
                    className="primary"
                    disabled={busy || preview.conflicts.length > 0}
                    onClick={() =>
                      void act(async () => {
                        await api(`/imports/${preview.id}/apply`, {});
                        await refresh();
                        close();
                        setNotice(
                          "Import applied. Understanding is rebuilding from originals.",
                        );
                      })
                    }
                  >
                    Apply reviewed import
                  </button>
                </>
              ) : null}
            </Modal>
          ) : null}
        </>
      ) : null}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
