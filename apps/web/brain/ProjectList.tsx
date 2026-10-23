type Props = {
  projects: { id: string; title: string }[];
  current: string;
  onSelect: (id: string) => void;
  onNew: () => void;
};

export function ProjectList({ projects, current, onSelect, onNew }: Props) {
  return (
    <nav className="yb-plist" aria-label="Projects">
      <ul>
        {projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              aria-current={p.id === current ? "page" : undefined}
              onClick={() => onSelect(p.id)}
            >
              {p.title}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="tv-link" onClick={onNew}>
        New project
      </button>
    </nav>
  );
}
