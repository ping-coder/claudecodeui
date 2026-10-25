type AntigravityLogoProps = {
  className?: string;
};

/**
 * Rendered by the shared LLMProviderLogo when the provider is Antigravity.
 * An original geometric mark (an arch with a body floating beneath its apex),
 * not Google's artwork; drawn in `currentColor` so it follows the theme like
 * the Codex and Cursor marks.
 */
export default function AntigravityLogo({ className = 'w-5 h-5' }: AntigravityLogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="Antigravity"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4.5 19.5 12 4.5l7.5 15"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13.75" r="2.25" fill="currentColor" />
      <path d="M9 21.25h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".45" />
    </svg>
  );
}
