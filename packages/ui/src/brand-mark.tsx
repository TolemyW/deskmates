const logo = new URL("./assets/deskmates-logo.png", import.meta.url).href;

/** The Deskmates icon: a square, transparent PNG shown at its own colors, `size` px a side. */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src={logo}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={className}
      style={{ display: "block", flexShrink: 0 }}
    />
  );
}
