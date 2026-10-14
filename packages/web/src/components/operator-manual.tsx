// The operator manual behind the one Help entry (issue #28): docs/guide/ as bundled into this web
// build, with a topic list, local search, "This screen" and an About section. It is a non-modal
// surface laid over the work area; the shell keeps the screen underneath mounted (inert), so a
// conversation, its unsent draft and its scroll position are where they were on Back to work.
// There is no focus trap, so owned HeroUI selects elsewhere keep working while it is open.

import { ArrowLeft, CircleQuestionMark, ExternalLink, Info, Search } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useT } from "../i18n/i18n-provider.js";
import { WEB_BUILD, type WebBuild } from "../lib/build-info.js";
import {
  SOURCE_REPOSITORY,
  createSlugger,
  resolveGuideImage,
  resolveGuideLink,
} from "../lib/guide-links.js";
import {
  GUIDE_ASSETS,
  GUIDE_ENTRIES,
  type GuidePageId,
  guideEntry,
  guideFingerprint,
} from "../lib/guide-manifest.js";
import { searchGuide } from "../lib/guide-search.js";
import { GUIDE_INDEX, type GuidePage } from "../lib/guide.js";
import { Markdown, type MarkdownOptions } from "../lib/markdown.js";
import { OPEN_SOURCE_NOTICES } from "../lib/open-source-notices.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

const ISSUES_URL = `${SOURCE_REPOSITORY}/issues/new`;

/** The release or commit a source link names, or the default branch for a development build. */
function sourceRef(build: WebBuild): string {
  return build.release ?? build.revision ?? "main";
}

type View = { page: GuidePageId; anchor?: string } | { page: "about" };

const HEADING_PREFIX = "manual-";

/** One guide page as safe Markdown: links and images resolve through the manifest only. */
export function GuideMarkdown({
  source,
  page,
  sourceRef: ref,
  onNavigate,
}: {
  source: string;
  page: GuidePageId;
  sourceRef: string;
  onNavigate: (page: GuidePageId, anchor?: string) => void;
}) {
  const t = useT();
  // A fresh slugger per render numbers repeated headings in document order, as GitHub does.
  const slug = createSlugger();
  const options: MarkdownOptions = {
    mentions: false,
    softBreaks: true,
    tableLabel: t("manual.table"),
    headingId: (text) => `${HEADING_PREFIX}${slug(text)}`,
    renderLink: (href, children, key) => {
      const link = resolveGuideLink(href, page, { sourceRef: ref });
      switch (link.kind) {
        case "topic":
          return (
            <button
              key={key}
              type="button"
              className="manual-link"
              onClick={() => onNavigate(link.page, link.anchor)}
            >
              {children}
            </button>
          );
        case "external":
        case "repository":
          return (
            <a
              key={key}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              title={
                link.kind === "repository" ? t("manual.link.github") : t("manual.link.external")
              }
            >
              {children}
              <ExternalLink className="manual-external-icon" size={12} aria-hidden="true" />
            </a>
          );
        default:
          return <span key={key}>{children}</span>;
      }
    },
    renderImage: (src, alt, key) => {
      const url = resolveGuideImage(src, GUIDE_ASSETS);
      return url ? (
        <img key={key} src={url} alt={alt} loading="lazy" />
      ) : (
        <span key={key} className="manual-image-missing">
          {t("manual.imageUnavailable", { alt })}
        </span>
      );
    },
  };
  return <Markdown text={source} options={options} />;
}

export function OperatorManual({
  screenPage,
  runningRelease,
  build = WEB_BUILD,
  onClose,
  id,
}: {
  /** The page for the screen the shell showed when Help was opened. */
  screenPage: GuidePage;
  /** The release the Gateway reports, or null when it reports none. */
  runningRelease: string | null;
  build?: WebBuild;
  onClose: () => void;
  id?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const [view, setView] = useState<View>({ page: GUIDE_INDEX });
  // Narrow screens show one pane at a time: the topic list or the selected page.
  const [pane, setPane] = useState<"topics" | "content">("topics");
  const [query, setQuery] = useState("");
  const title = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLElement>(null);
  const hits = useMemo(() => searchGuide(query, GUIDE_ENTRIES), [query]);
  const searching = query.trim() !== "";
  const thisScreen = guideEntry(screenPage);

  useEffect(() => {
    title.current?.focus();
  }, []);

  // A new page starts at its top; an anchor scrolls to its heading.
  useEffect(() => {
    const anchor = "anchor" in view ? view.anchor : undefined;
    const target = anchor ? document.getElementById(`${HEADING_PREFIX}${anchor}`) : null;
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "start" });
    } else if (content.current) {
      content.current.scrollTop = 0;
    }
  }, [view]);

  const open = (page: GuidePageId | "about", anchor?: string): void => {
    setView(page === "about" ? { page } : anchor ? { page, anchor } : { page });
    setPane("content");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      onClose();
    }
  };

  const topic = (page: GuidePageId | "about", label: ReactNode, name?: string) => {
    const current = view.page === page;
    return (
      <li key={page}>
        <button
          type="button"
          className={`manual-topic${current ? " active" : ""}`}
          aria-current={current ? "page" : undefined}
          aria-label={name}
          onClick={() => open(page)}
        >
          {label}
        </button>
      </li>
    );
  };

  return (
    <section
      id={id}
      className="operator-manual"
      aria-labelledby="operator-manual-title"
      onKeyDown={onKeyDown}
    >
      <header className="manual-header">
        <h1 id="operator-manual-title" ref={title} tabIndex={-1}>
          <CircleQuestionMark size={20} aria-hidden="true" />
          {t("manual.title")}
        </h1>
        <Button variant="outline" className="manual-back-to-work" onClick={onClose}>
          <ArrowLeft size={16} aria-hidden="true" />
          {t("manual.backToWork")}
        </Button>
      </header>
      <div className="manual-body" data-pane={pane}>
        <div className="manual-sidebar">
          <div className="manual-search">
            <Search size={16} aria-hidden="true" />
            <Input
              type="search"
              aria-label={t("manual.search.label")}
              placeholder={t("manual.search.placeholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {searching ? (
            <div className="manual-results">
              <p className="manual-results-count" aria-live="polite">
                {hits.length > 0
                  ? t("manual.search.count", { count: hits.length })
                  : t("manual.search.noResults", { query: query.trim() })}
              </p>
              {hits.length > 0 ? (
                <ul aria-label={t("manual.search.results")}>
                  {hits.map((hit) => (
                    <li key={hit.entry.id}>
                      <button
                        type="button"
                        className="manual-result"
                        onClick={() => open(hit.entry.id)}
                      >
                        <strong>{hit.entry.title}</strong>
                        <span>{hit.snippet}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <nav aria-label={t("manual.topics")}>
              <ul>
                <li>
                  <button
                    type="button"
                    className="manual-topic manual-this-screen"
                    aria-label={`${t("manual.thisScreen")}: ${thisScreen.title}`}
                    onClick={() => open(thisScreen.id)}
                  >
                    <span className="manual-topic-kicker">{t("manual.thisScreen")}</span>
                    <span>{thisScreen.title}</span>
                  </button>
                </li>
              </ul>
              <ul className="manual-topic-list">
                {GUIDE_ENTRIES.map((entry) => topic(entry.id, entry.title))}
              </ul>
              <ul className="manual-topic-list manual-topic-about">
                {topic(
                  "about",
                  <>
                    <Info size={16} aria-hidden="true" />
                    {t("manual.about")}
                  </>,
                  t("manual.about"),
                )}
              </ul>
            </nav>
          )}
        </div>
        <article className="manual-content" ref={content}>
          <button type="button" className="manual-all-topics" onClick={() => setPane("topics")}>
            <ArrowLeft size={16} aria-hidden="true" />
            {t("manual.allTopics")}
          </button>
          {view.page === "about" ? (
            <ManualAbout runningRelease={runningRelease} build={build} />
          ) : (
            <>
              {locale !== "en" ? (
                <p className="manual-fallback" role="note">
                  {t("manual.englishOnly")}
                </p>
              ) : null}
              <div className="md manual-page" lang="en">
                <GuideMarkdown
                  key={view.page}
                  source={guideEntry(view.page).source}
                  page={view.page}
                  sourceRef={sourceRef(build)}
                  onNavigate={(page, anchor) => open(page, anchor)}
                />
              </div>
            </>
          )}
        </article>
      </div>
    </section>
  );
}

function ManualAbout({
  runningRelease,
  build,
}: { runningRelease: string | null; build: WebBuild }) {
  const t = useT();
  const base = import.meta.env.BASE_URL;
  const source =
    build.release || build.revision
      ? `${SOURCE_REPOSITORY}/tree/${encodeURIComponent(sourceRef(build))}`
      : SOURCE_REPOSITORY;
  const status = !build.release
    ? t("manual.about.devBuild")
    : runningRelease === null
      ? t("manual.about.runningUnknown", { built: build.release })
      : runningRelease === build.release
        ? t("manual.about.match", { release: build.release })
        : t("manual.about.mismatch", { built: build.release, running: runningRelease });
  const state = !build.release
    ? "development"
    : runningRelease === build.release
      ? "match"
      : runningRelease === null
        ? "unknown"
        : "mismatch";
  return (
    <div className="manual-about">
      <h1>{t("manual.about.title")}</h1>
      <dl className="manual-facts">
        <div>
          <dt>{t("manual.about.runningRelease")}</dt>
          <dd>{runningRelease ?? t("manual.about.notReported")}</dd>
        </div>
        <div>
          <dt>{t("manual.about.manualBuild")}</dt>
          <dd>{build.release ?? t("manual.about.devBuildValue")}</dd>
        </div>
        {build.revision ? (
          <div>
            <dt>{t("manual.about.revision")}</dt>
            <dd>
              <code>{build.revision.slice(0, 12)}</code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t("manual.about.guideContent")}</dt>
          <dd>
            <code>{guideFingerprint()}</code>
          </dd>
        </div>
      </dl>
      <p className="manual-release-state" data-state={state}>
        {status}
      </p>
      <ul className="manual-external-links">
        <li>
          <a href={source} target="_blank" rel="noopener noreferrer">
            {t("manual.about.sourceCode")}
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </li>
        <li>
          <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
            {t("manual.about.reportIssue")}
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </li>
      </ul>
      <p className="manual-note">{t("manual.about.githubNote")}</p>
      <h2>{t("manual.about.notices")}</h2>
      <p>{t("manual.about.noticesLead")}</p>
      <ul className="manual-notices" aria-label={t("manual.about.notices")}>
        {OPEN_SOURCE_NOTICES.map((name) => (
          <li key={name}>
            <a href={`${base}third-party/${name}`} target="_blank" rel="noopener noreferrer">
              {name}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
