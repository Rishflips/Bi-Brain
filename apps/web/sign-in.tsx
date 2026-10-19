import { useState } from "react";
import { BrandLockup } from "./brand.tsx";

export type RuntimeMode = "local" | "managed";

/**
 * Shown when the runtime could not be validated. It never falls back to the
 * local installation form: an unknown deployment must not be presented as a
 * local brain. Retrying re-fetches the real `/api/v1/runtime` and
 * `/api/v1/session` endpoints.
 */
export function ConnectionUnavailable({
  busy,
  onRetry,
}: {
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <section className="welcome connection-unavailable">
      <p className="eyebrow">NOT CONNECTED</p>
      <h1>We can’t reach this BiBrain.</h1>
      <p>
        The server did not return the information needed to open your brain.
        Nothing has been changed, and no installation type has been assumed.
      </p>
      <article>
        <h2>Try again</h2>
        <p>
          Check that the server is running, then retry. This asks the server for
          its runtime status again.
        </p>
        <button className="primary" disabled={busy} onClick={onRetry}>
          Retry
        </button>
      </article>
    </section>
  );
}

/**
 * First-use view. It renders exactly one of two honest states:
 *  - a managed deployment with a real, working sign-in link, or an explicit
 *    "not available yet" note (never a disabled button that pretends to work);
 *  - the unchanged local single-owner installation code.
 * The managed branch has no account data of its own and never reads or writes
 * browser storage.
 */
export function SignIn({
  mode,
  signInUrl,
  signInAvailable,
  busy,
  onPair,
  onDemo,
}: {
  mode: RuntimeMode;
  signInUrl: string | null;
  signInAvailable: boolean;
  busy: boolean;
  onPair: (code: string) => void;
  onDemo: () => void;
}) {
  const [code, setCode] = useState("");
  if (mode === "managed")
    return (
      <section className="welcome entry-experience" data-ui="first-use">
        <div className="entry-story">
          <BrandLockup className="entry-lockup" />
          <p className="eyebrow">YOUR PRIVATE SPACE</p>
          <h1>Your work, remembered.</h1>
          <p className="entry-lede">
            One calm place that carries your context between every agent you
            choose to use.
          </p>
        </div>
        <article className="entry-card">
          {signInAvailable && signInUrl ? (
            <>
              <h2>Sign in to BiBrain</h2>
              <p>
                You will return here after your identity provider confirms who
                you are. No password is stored by Bi Brain.
              </p>
              <a href={signInUrl} className="primary-link">
                Sign in to BiBrain
              </a>
            </>
          ) : (
            <>
              <h2>Sign-in is not available yet</h2>
              <p>
                This server has not finished connecting an identity provider.
                Ask the operator to complete managed setup before signing in.
              </p>
            </>
          )}
        </article>
      </section>
    );
  return (
    <section className="welcome entry-experience" data-ui="first-use">
      <div className="entry-story">
        <BrandLockup className="entry-lockup" />
        <p className="eyebrow">YOUR PRIVATE SPACE</p>
        <h1>A private brain for everything you’re building.</h1>
        <p className="entry-lede">
          Save a thought once. BiBrain keeps the original, carries the context,
          and helps every agent you choose pick up where you left off.
        </p>
        <div className="entry-promises" aria-label="What BiBrain does">
          <span>Private by default</span>
          <span>Originals stay inspectable</span>
          <span>You control every connection</span>
        </div>
      </div>
      <article className="entry-card">
        <p className="entry-step">01 · OPEN YOUR SPACE</p>
        <h2>Open your local brain</h2>
        <p>
          Use the private installation code stored on this computer. No account
          is needed. Optional AI preparation stays off until you choose it in
          Settings.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onPair(code);
          }}
        >
          <label className="field">
            Installation code
            <input
              type="password"
              name="installation-code"
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-label="Installation code"
            />
          </label>
          <button className="primary" disabled={busy}>
            Open my brain
          </button>
          <button type="button" onClick={onDemo}>
            Explore a safe example
          </button>
        </form>
        <p className="entry-help">
          Use the <code>owner-secret</code> file stored beside this
          installation’s brain database. Pairing protects your private space
          from other browsers.
        </p>
        <details className="entry-details">
          <summary>Where is my code?</summary>
          <p>
            In the standard local setup it is <code>data/owner-secret</code>. A
            separate preview or custom data folder has its own code in that
            folder—use the one belonging to the server open in this browser.
          </p>
        </details>
      </article>
    </section>
  );
}
