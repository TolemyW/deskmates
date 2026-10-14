import { Input as HeroInput, TextArea as HeroTextArea } from "@heroui/react";
import type { ComponentProps } from "react";
import { definedProps } from "./defined-props.js";

export type InputProps = ComponentProps<"input">;
export function Input({ className, ...props }: InputProps) {
  return (
    <HeroInput
      {...definedProps(props)}
      data-gb-ui="input"
      className={`gb-input ${className ?? ""}`}
    />
  );
}
export type TextAreaProps = ComponentProps<"textarea">;
export function TextArea({ className, ...props }: TextAreaProps) {
  return (
    <HeroTextArea
      {...definedProps(props)}
      data-gb-ui="textarea"
      className={`gb-input gb-textarea ${className ?? ""}`}
    />
  );
}
