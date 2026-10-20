export type FirstSessionMemoryState = "pending" | "accepted" | "searchable";

export function FirstSessionJourney({
  memoryState,
  connected,
  shareable,
  onOpenMemory,
  onFind,
  onConnect,
}: {
  memoryState: FirstSessionMemoryState;
  connected: boolean;
  shareable: boolean;
  onOpenMemory: () => void;
  onFind: () => void;
  onConnect: () => void;
}) {
  const memoryCopy =
    memoryState === "accepted"
      ? "You approved the current meaning. Agents can receive it within the project you choose."
      : memoryState === "pending"
        ? "BiBrain found one clear memory. It stays a suggestion until you review it."
        : "The original is searchable now. If BiBrain finds a clear memory, it will wait for your review.";

  return (
    <section
      className="first-session-journey"
      data-ui="first-session-journey"
      aria-labelledby="first-session-title"
    >
      <header>
        <p className="section-kicker">YOUR FIRST USEFUL LOOP</p>
        <h2 id="first-session-title">Make this useful beyond today.</h2>
        <p>
          Your first item is safe. These are the next two ways to make it easy
          to trust and reuse.
        </p>
      </header>
      <ol>
        <li data-complete="true">
          <span className="journey-marker" aria-hidden="true">
            ✓
          </span>
          <div>
            <strong>Saved as an original</strong>
            <p>BiBrain kept what you wrote before doing anything else.</p>
          </div>
          <span className="journey-state">Done</span>
        </li>
        <li data-complete={memoryState === "accepted" ? "true" : "false"}>
          <span className="journey-marker" aria-hidden="true">
            {memoryState === "accepted" ? "✓" : "2"}
          </span>
          <div>
            <strong>
              {memoryState === "accepted"
                ? "Meaning confirmed by you"
                : memoryState === "pending"
                  ? "Confirm what it means"
                  : "Find it when you need it"}
            </strong>
            <p>{memoryCopy}</p>
          </div>
          <button
            type="button"
            className="link"
            onClick={memoryState === "searchable" ? onFind : onOpenMemory}
          >
            {memoryState === "pending"
              ? "Review memory"
              : memoryState === "accepted"
                ? "View memory"
                : "Find this item"}
          </button>
        </li>
        <li data-complete={connected ? "true" : "false"}>
          <span className="journey-marker" aria-hidden="true">
            {connected ? "✓" : "3"}
          </span>
          <div>
            <strong>
              {connected ? "Available where you work" : "Continue anywhere"}
            </strong>
            <p>
              {connected
                ? "A verified agent can use this project within the access you chose."
                : shareable
                  ? "Carry this project into Codex or Claude Code without opening the rest of your brain."
                  : "This item stays private. You can still find it here whenever you need it."}
            </p>
          </div>
          {shareable ? (
            <button type="button" className="link" onClick={onConnect}>
              {connected ? "View connection" : "Use with an agent"}
            </button>
          ) : (
            <span className="journey-state">Private</span>
          )}
        </li>
      </ol>
    </section>
  );
}
