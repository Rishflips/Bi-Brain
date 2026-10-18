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
    <section className="welcome entry-experience">
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
      <section className="welcome entry-experience">
        <div className="entry-story">
          <p className="eyebrow">YOUR PRIVATE SPACE</p>
          <h1>Your work, <em>remembered.</em></h1>
          <p className="entry-lede">
            One calm place that carries your context between every agent you
            choose to use.
          </p>
          <BrainChamber />
        </div>
        <article className="entry-card">
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
    <section className="welcome entry-experience">
      <div className="entry-story">
        <p className="eyebrow">YOUR PRIVATE SPACE</p>
        <h1>
          Your thinking,<br />
          <em>still alive.</em>
        </h1>
        <p className="entry-lede">
          Save a thought once. Pick it up with any agent, with the context
          intact and the source always in reach.
        </p>
        <BrainChamber />
        <div className="entry-promises" aria-label="What BiBrain does">
          <span>Remembers what you save</span>
          <span>Carries context forward</span>
          <span>Stays quiet until useful</span>
        </div>
      </div>
      <article className="entry-card">
        <p className="entry-step">01 · OPEN YOUR SPACE</p>
        <h2>Open your local brain</h2>
        <p>
          Use the private installation code stored on this computer. No account
          is needed and nothing leaves this machine.
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
          Find the code in <code>data/owner-secret</code>. Pairing protects this
          private installation from other browsers.
        </p>
      </article>
    </section>
  );
}

function BrainChamber() {
  return (
    <div className="entry-brain" aria-hidden="true">
      <span className="entry-orbit orbit-one" />
      <span className="entry-orbit orbit-two" />
      <span className="entry-orbit orbit-three" />
      <svg viewBox="0 0 360 260">
        <path d="M75 134c0-48 41-88 91-88 21 0 40 7 55 20 12-8 27-12 42-9 28 5 48 29 47 57 17 12 27 31 24 51-4 31-31 53-62 50-17 19-43 30-70 27-27-2-50-17-63-38-35 0-64-28-64-63v-7Z" />
        <path d="M129 68c-10 25-5 49 15 70 20 20 21 48 5 70M218 68c17 16 21 37 12 62-9 26-3 50 18 73M84 126c30-8 56 0 79 24 20 21 47 28 79 19M171 48c-8 25-2 47 19 65 22 19 32 43 29 73M105 184c24-21 50-27 78-17 29 10 54 5 76-16" />
        <circle cx="129" cy="68" r="5" />
        <circle cx="163" cy="150" r="6" />
        <circle cx="230" cy="130" r="5" />
        <circle cx="105" cy="184" r="5" />
        <circle cx="259" cy="151" r="6" />
      </svg>
      <span className="entry-brain-core">b.</span>
      <span className="orbit-dot dot-one" />
      <span className="orbit-dot dot-two" />
      <span className="orbit-dot dot-three" />
    </div>
  );
}
