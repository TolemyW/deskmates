import { Tabs } from "@heroui/react";
import { type ReactNode, useEffect, useState } from "react";
import { ButtonLink } from "./button.js";

export interface SectionTab<K extends string = string> {
  key: K;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}
export interface SectionTabsProps<K extends string> {
  label: string;
  items: readonly SectionTab<K>[];
  value: K;
  onChange: (key: K) => void;
  children?: ReactNode;
  renderPanel?: (key: K) => ReactNode;
  /** Lazy mount on first visit, then preserve editors while their panel is hidden. */
  keepMounted?: boolean;
}

/** Content-sized tabs scroll inside their own strip; labels never shrink into equal cells. */
export function SectionTabs<K extends string>({
  label,
  items,
  value,
  onChange,
  children,
  renderPanel,
  keepMounted = false,
}: SectionTabsProps<K>) {
  const [visited, setVisited] = useState<ReadonlySet<K>>(() => new Set([value]));
  useEffect(() => {
    if (keepMounted)
      setVisited((current) => (current.has(value) ? current : new Set([...current, value])));
  }, [value, keepMounted]);
  return (
    <Tabs
      className="gb-section-tabs"
      selectedKey={value}
      onSelectionChange={(key) => {
        const item = items.find((item) => item.key === key);
        if (item && !item.disabled) onChange(item.key);
      }}
    >
      <div className="gb-tab-scroll" data-tab-layout="scroll">
        <Tabs.List aria-label={label} className="gb-tab-list">
          {items.map((item) => (
            <Tabs.Tab
              key={item.key}
              id={item.key}
              isDisabled={item.disabled ?? false}
              className="gb-tab-item"
            >
              {item.icon ? (
                <span aria-hidden="true" className="gb-tab-icon">
                  {item.icon}
                </span>
              ) : null}
              <span data-tab-label>{item.label}</span>
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </div>
      {items
        .filter((item) => item.key === value || (keepMounted && visited.has(item.key)))
        .map((item) => (
          <Tabs.Panel
            key={item.key}
            id={item.key}
            shouldForceMount={keepMounted}
            hidden={item.key !== value}
          >
            {renderPanel ? renderPanel(item.key) : children}
          </Tabs.Panel>
        ))}
    </Tabs>
  );
}

export interface TabNavigationItem extends Omit<SectionTab, "disabled"> {
  href: string;
  suffix?: ReactNode;
}
/** Addressable destinations remain real links (open in new tab, copy address, Back). */
export function TabNavigation({
  label,
  items,
  value,
  sidebar = false,
}: {
  sidebar?: boolean;
  label: string;
  items: readonly TabNavigationItem[];
  value: string;
}) {
  return (
    <nav
      aria-label={label}
      className={`gb-tab-scroll${sidebar ? " gb-tab-navigation--sidebar" : ""}`}
      data-tab-layout="scroll"
    >
      <div className="gb-tab-list">
        {items.map((item) => (
          <ButtonLink
            key={item.key}
            href={item.href}
            aria-current={item.key === value ? "page" : undefined}
            variant={item.key === value ? "secondary" : "tertiary"}
            className="gb-tab-item"
          >
            {item.icon ? (
              <span aria-hidden="true" className="gb-tab-icon">
                {item.icon}
              </span>
            ) : null}
            <span data-tab-label>{item.label}</span>
            {item.suffix}
          </ButtonLink>
        ))}
      </div>
    </nav>
  );
}
