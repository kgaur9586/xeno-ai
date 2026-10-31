/** Inline icons (24×24, stroke-based). Decorative: hidden from assistive technology. */
import type { ReactNode } from "react";

function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const LogoMark = () => (
  <svg className="logo-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="logo-gradient" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#7c5cff" />
        <stop offset="1" stopColor="#22d3ee" />
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#logo-gradient)" />
    <path d="M10 10l12 12M22 10L10 22" stroke="#0b0d14" strokeWidth="3" strokeLinecap="round" />
    <circle cx="16" cy="16" r="2.4" fill="#0b0d14" />
  </svg>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const PlayIcon = () => (
  <Icon>
    <path d="M7 5v14l11-7z" />
  </Icon>
);
export const StepIcon = () => (
  <Icon>
    <path d="M6 5v14l9-7zM18 5v14" />
  </Icon>
);
export const PauseIcon = () => (
  <Icon>
    <path d="M8 5v14M16 5v14" />
  </Icon>
);
export const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </Icon>
);
export const LockIcon = () => (
  <Icon>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
);
export const UnlockIcon = () => (
  <Icon>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 7.5-2" />
  </Icon>
);
export const FlaskIcon = () => (
  <Icon>
    <path d="M9 3h6M10 3v6L4.5 18.5A1.6 1.6 0 0 0 6 21h12a1.6 1.6 0 0 0 1.5-2.5L14 9V3" />
    <path d="M7.5 15h9" />
  </Icon>
);
export const SparkIcon = () => (
  <Icon>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z" />
  </Icon>
);
export const RulerIcon = () => (
  <Icon>
    <path d="M3 17L17 3l4 4L7 21z" />
    <path d="M7 13l2 2M10 10l2 2M13 7l2 2" />
  </Icon>
);
export const ChatIcon = () => (
  <Icon>
    <path d="M4 5h16v11H9l-5 4z" />
  </Icon>
);
export const ScaleIcon = () => (
  <Icon>
    <path d="M12 4v16M5 20h14M5 8h14M7 8l-3 6a3 3 0 0 0 6 0zM17 8l-3 6a3 3 0 0 0 6 0z" />
  </Icon>
);
export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const AlertIcon = () => (
  <Icon>
    <path d="M12 3l9.5 17h-19z" />
    <path d="M12 10v4M12 17.5v.01" />
  </Icon>
);
export const CheckIcon = () => (
  <Icon>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);
export const OrbitIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="2.5" />
    <ellipse cx="12" cy="12" rx="9" ry="4" />
    <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(120 12 12)" />
  </Icon>
);
