import { useId } from "react";

const logo = new URL("./assets/deskmates-logo.png", import.meta.url).href;

/** The supplied transparent artwork, displayed without its empty canvas margins. */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  const mask = useId();
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="222 308 784 628"
      width={(size * 784) / 628}
      height={size}
      className={className}
      style={{ display: "block", flexShrink: 0 }}
    >
      <defs>
        <mask
          id={mask}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="1254"
          height="1254"
          style={{ maskType: "alpha" }}
        >
          <image href={logo} width="1254" height="1254" />
        </mask>
      </defs>
      <rect x="222" y="308" width="784" height="628" fill="currentColor" mask={`url(#${mask})`} />
    </svg>
  );
}
