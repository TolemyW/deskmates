const logo = new URL("./assets/deskmates-logo.png", import.meta.url).href;

/**
 * The Deskmates icon: a 256 px square, transparent PNG cropped to the artwork's edges and
 * shown at its own colors, `size` px a side. Not draggable, so a press-and-drag on a brand
 * button around it keeps acting on the button.
 */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src={logo}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
      className={className}
      style={{ display: "block", flexShrink: 0 }}
    />
  );
}
