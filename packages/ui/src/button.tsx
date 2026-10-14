import { Button as HeroButton, Spinner, buttonVariants } from "@heroui/react";
import type { ComponentProps, ReactNode } from "react";
import { definedProps } from "./defined-props.js";

export type ButtonVariant =
  | "default"
  | "primary"
  | "outline"
  | "secondary"
  | "tertiary"
  | "ghost"
  | "destructive"
  | "danger-soft";
export type ButtonSize = "default" | "sm" | "icon";
const variants = {
  default: "primary",
  primary: "primary",
  tertiary: "tertiary",
  "danger-soft": "danger-soft",
  outline: "outline",
  secondary: "secondary",
  ghost: "ghost",
  destructive: "danger",
} as const;

export interface ButtonProps extends Omit<ComponentProps<"button">, "children"> {
  children?: ReactNode;
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  loading?: boolean;
}

/** Native form/click API; HeroUI owns keyboard, focus and press interaction. */
export function Button({
  variant = "tertiary",
  size = "default",
  type = "button",
  disabled = false,
  loading = false,
  className,
  children,
  value,
  ...props
}: ButtonProps) {
  // Legacy consumers supply their own tab/menu semantics. React Aria Button
  // intentionally replaces those roles; preserve them on a native button while
  // sharing HeroUI's visual variants. New composite widgets should own keyboard routing.
  if (props.role && props.role !== "button") {
    return (
      <button
        {...props}
        type={type}
        value={value}
        disabled={disabled || loading}
        data-pending={loading || undefined}
        data-gb-ui="button"
        className={`${buttonVariants({ variant: variants[variant], size: size === "sm" ? "sm" : "md", isIconOnly: size === "icon" })} gb-button ${className ?? ""}`}
      >
        {loading ? <Spinner size="sm" aria-hidden="true" /> : null}
        {children}
      </button>
    );
  }
  // HeroUI always renders a native button here; its focus/key event types widen the
  // element to Element, while this API deliberately retains HTMLButtonElement refs/events.
  const nativeProps = definedProps(props) as Omit<ComponentProps<typeof HeroButton>, "children">;
  return (
    <HeroButton
      {...nativeProps}
      type={type}
      {...(value !== undefined ? { value: String(value) } : {})}
      variant={variants[variant]}
      size={size === "sm" ? "sm" : "md"}
      isIconOnly={size === "icon"}
      isDisabled={disabled || loading}
      isPending={loading}
      data-gb-ui="button"
      className={`gb-button ${className ?? ""}`}
    >
      {loading ? <Spinner size="sm" aria-hidden="true" /> : null}
      {children}
    </HeroButton>
  );
}

export interface ButtonLinkProps extends ComponentProps<"a"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Navigation remains a real link (including opening in a new tab), never a button. */
export function ButtonLink({
  variant = "tertiary",
  size = "default",
  className,
  ...props
}: ButtonLinkProps) {
  return (
    <a
      {...props}
      data-gb-ui="button-link"
      className={`${buttonVariants({ variant: variants[variant], size: size === "sm" ? "sm" : "md", isIconOnly: size === "icon" })} gb-button ${className ?? ""}`}
    />
  );
}
