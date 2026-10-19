export function BrandLockup({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-lockup ${className}`.trim()}>
      <img
        src="/brand/bibrain-lockup.png"
        width="1672"
        height="941"
        alt="BiBrain"
      />
    </span>
  );
}

export function BrainEmblem({ className = "" }: { className?: string }) {
  return (
    <span className={`brain-emblem ${className}`.trim()} aria-hidden="true">
      <img
        src="/brand/bibrain-emblem.png"
        width="1254"
        height="1254"
        alt=""
      />
    </span>
  );
}
