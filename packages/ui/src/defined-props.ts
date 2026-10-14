/** React DOM permits explicit undefined; React Aria's exact optional props do not. */
export function definedProps<T extends object>(
  props: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
