type BrandGraphicProps = {
  className?: string;
};

function EmblemGeometry() {
  return (
    <>
      <path
        className="brand-ink"
        fill="#111111"
        d="M48 8H27C14.6 8 7 15.9 7 28.1c0 9.8 6.2 16.8 18.2 19.9C13.2 51.1 7 58.2 7 68.1 7 80.4 15.4 88 28.4 88H48V8Z"
      />
      <path
        className="brand-gold"
        fill="#FABC08"
        d="M48 8h21c12.4 0 20 7.9 20 20.1 0 9.8-6.2 16.8-18.2 19.9C82.8 51.1 89 58.2 89 68.1 89 80.4 80.6 88 67.6 88H48V8Z"
      />
      <path
        className="brand-cutout"
        fill="#FAF8F2"
        d="M45.9 44.6c-5.4-8.3-10.2-13.8-18-15.1-6.3-1.1-10.4 1.2-10.4 6.4 0 5.6 4.5 8.4 11.8 9.5 6.6.9 11.8 3.4 16.7 7.7l-.1-8.5Z"
      />
      <path
        className="brand-cutout"
        fill="#FAF8F2"
        d="M45.9 51.4c-5.4 8.3-10.2 13.8-18 15.1-6.3 1.1-10.4-1.2-10.4-6.4 0-5.6 4.5-8.4 11.8-9.5 6.6-.9 11.8-3.4 16.7-7.7l-.1 8.5Z"
      />
      <path
        className="brand-cutout"
        fill="#FAF8F2"
        d="M50.1 44.6c5.4-8.3 10.2-13.8 18-15.1 6.3-1.1 10.4 1.2 10.4 6.4 0 5.6-4.5 8.4-11.8 9.5-6.6.9-11.8 3.4-16.7 7.7l.1-8.5Z"
      />
      <path
        className="brand-cutout"
        fill="#FAF8F2"
        d="M50.1 51.4c5.4 8.3 10.2 13.8 18 15.1 6.3 1.1 10.4-1.2 10.4-6.4 0-5.6-4.5-8.4-11.8-9.5-6.6-.9-11.8-3.4-16.7-7.7l.1 8.5Z"
      />
    </>
  );
}

export function BrandLockup({ className = "" }: BrandGraphicProps) {
  return (
    <span className={`brand-lockup ${className}`.trim()}>
      <svg
        viewBox="0 0 350 96"
        role="img"
        aria-label="BiBrain"
        focusable="false"
      >
        <g transform="translate(2)">
          <EmblemGeometry />
        </g>
        <text
          className="brand-wordmark"
          x="105"
          y="66"
          fill="#111111"
          fontFamily="Manrope Variable, Manrope, sans-serif"
          fontSize="52"
          fontWeight="800"
          letterSpacing="-3"
        >
          Bi
          <tspan className="brand-wordmark-accent" fill="#FABC08">
            Brain
          </tspan>
        </text>
      </svg>
    </span>
  );
}

export function BrainEmblem({ className = "" }: BrandGraphicProps) {
  return (
    <span className={`brain-emblem ${className}`.trim()} aria-hidden="true">
      <svg viewBox="0 0 96 96" focusable="false">
        <EmblemGeometry />
      </svg>
    </span>
  );
}
