import { useState } from "react";

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
    <section className="welcome">
      <p className="eyebrow">NOT CONNECTED</p>
      <h1>We can’t reach this Bi Brain.</h1>
      <p>
        The server did not return the information needed to open your brain.
        Nothing has been changed, and this is not a local installation.
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
      <section className="welcome">
        <p className="eyebrow">YOUR PRIVATE SPACE</p>
        <h1>Your work, remembered.</h1>
        <p>
          This is a managed Bi Brain. Sign in with your account to reach your
          own brain. Your work is kept separate from every other account.
        </p>
        <article>
          {signInAvailable && signInUrl ? (
            <>
              <h2>Sign in to BiBrain</h2>
              <p>
                You will return here after your identity provider confirms who
                you are. No password is stored by Bi Brain.
              </p>
              <a
                href={signInUrl}
                style={{
                  display: "inline-block",
                  padding: "11px 16px",
                  borderRadius: 8,
                  background: "var(--green)",
                  color: "var(--on-green)",
                  textDecoration: "none",
                  fontWeight: 600,
                }}
              >
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
    <section className="welcome">
      <p className="eyebrow">YOUR PRIVATE SPACE</p>
      <h1>A place for what’s worth keeping.</h1>
      <p>
        Save a conversation, a note, or a half-finished idea. Pick it up later
        with the context intact.
      </p>
      <article>
        <h2>Open your local brain</h2>
        <p>
          Enter the installation code from <code>data/owner-secret</code> on
          this computer. This pairs your browser; no account is needed.
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
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              aria-label="Installation code"
            />
          </label>
          <button className="primary" disabled={busy}>
            Open my brain
          </button>
          <button type="button" onClick={onDemo}>
            Try an example
          </button>
        </form>
      </article>
    </section>
  );
}
