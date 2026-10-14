import { useState } from "react";
import {
  ActionMenu,
  Avatar,
  BrandMark,
  Button,
  ButtonLink,
  Card,
  ChatViewport,
  Checkbox,
  Icon,
  Input,
  Label,
  MessageComposer,
  Pager,
  Pill,
  ResizeHandle,
  Select,
  Slider,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  type Tone,
  WorkspaceLayout,
} from "../src/index.js";
import { TasksPreview } from "./tasks-preview.js";

export function Studio() {
  const [dark, setDark] = useState(false);
  const [panelWidth, setPanelWidth] = useState(260);
  const [pagerPage, setPagerPage] = useState(0);
  return (
    <div className="studio">
      <header className="studio-header">
        <div className="studio-brand">
          <BrandMark size={28} />
          Deskmates <span className="studio-brand-suffix">UI</span>
        </div>
        <Button
          variant="tertiary"
          size="sm"
          aria-pressed={dark}
          onClick={() => {
            const next = !dark;
            setDark(next);
            document.documentElement.dataset.theme = next ? "dark" : "light";
          }}
        >
          <Icon name={dark ? "sun" : "moon"} size={18} />
          {dark ? "Light theme" : "Dark theme"}
        </Button>
      </header>
      <main className="studio-main">
        <section
          style={{
            position: "relative",
            width: panelWidth,
            minHeight: 100,
            border: "1px solid var(--separator)",
            padding: 16,
          }}
        >
          <h2>Resizable panel</h2>
          <p>Drag the edge or use arrow keys, Home and End.</p>
          <ResizeHandle
            label="Resize example"
            value={panelWidth}
            min={180}
            max={460}
            onChange={setPanelWidth}
          />
        </section>
        <section style={{ maxWidth: 520, padding: 16 }}>
          <h2>Pager</h2>
          <Pager
            label="Example pages"
            previousLabel="Previous"
            nextLabel="Next"
            range={`${pagerPage * 25 + 1}–${Math.min(80, pagerPage * 25 + 25)} of 80`}
            hasPrevious={pagerPage > 0}
            hasNext={pagerPage < 3}
            onPrevious={() => setPagerPage((page) => page - 1)}
            onNext={() => setPagerPage((page) => page + 1)}
          />
        </section>
        <section className="studio-intro">
          <Pill tone="primary">Deskmates UI · 0.1.0</Pill>
          <h1>
            The building blocks of Deskmates.
            <br />
            <span>Our components. Our workspace.</span>
          </h1>
          <p>
            A shared language for every interaction.
            <br />
            An independent library for building Deskmates together.
          </p>
          <div className="button-row">
            <ButtonLink variant="primary" href="#component-gallery">
              Explore components
            </ButtonLink>
          </div>
        </section>
        <Tabs defaultSelectedKey="components" id="component-gallery">
          <Tabs.ListContainer>
            <Tabs.List aria-label="Studio sections">
              <Tabs.Tab id="components">
                Components
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="workbench">
                Chat
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="tasks">
                Tasks
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="foundations">
                Foundations
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel id="components">
            <Gallery />
            <section style={{ marginTop: 32 }} aria-label="Table example">
              <h2 style={{ marginBottom: 16 }}>People</h2>
              <Table aria-label="Example members">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {["Alex Chen", "Maya Patel"].map((name) => (
                    <TableRow key={name}>
                      <TableCell>
                        <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <Avatar name={name} />
                          {name}
                        </span>
                      </TableCell>
                      <TableCell>Member</TableCell>
                      <TableCell>
                        <Pill tone="success">Active</Pill>
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" aria-label={`View ${name}`}>
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          </Tabs.Panel>
          <Tabs.Panel id="workbench">
            <Workbench />
          </Tabs.Panel>
          <Tabs.Panel id="tasks">
            <TasksPreview />
          </Tabs.Panel>
          <Tabs.Panel id="foundations">
            <Foundations />
          </Tabs.Panel>
        </Tabs>
        <footer className="studio-footer">
          <span>Deskmates UI · Independently versioned</span>
          <span>Local examples. No live agents or external actions.</span>
        </footer>
      </main>
    </div>
  );
}

function Gallery() {
  const [region, setRegion] = useState("");
  const [notify, setNotify] = useState(true);
  const [reviewed, setReviewed] = useState(true);
  const [value, setValue] = useState(50);
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <div className="gallery">
      <div className="gallery-column">
        <div className="field-examples">
          <label htmlFor="studio-email">
            Your email <span className="required-mark">*</span>
          </label>
          <Input
            id="studio-email"
            type="email"
            placeholder="john@email.com"
            aria-describedby="email-help"
          />
          <p id="email-help" className="muted">
            We’ll use this in the preview only.
          </p>
          <label htmlFor="studio-project">
            Project name <span className="required-mark">*</span>
          </label>
          <Input
            id="studio-project"
            placeholder="My workspace"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Select
            label="Region"
            value={region}
            onValueChange={setRegion}
            options={[
              { value: "", label: "All regions" },
              { value: "asia", label: "Asia Pacific" },
              { value: "europe", label: "Europe" },
              { value: "unavailable", label: "Unavailable region", disabled: true },
            ]}
          />
          <div className="selection-examples">
            <Checkbox label="Reviewed" selected={reviewed} onChange={setReviewed} />
            <Spinner size="sm" />
            <ActionMenu
              label="More actions for this example"
              items={[
                { id: "edit", label: "Edit", onAction: () => setName("Edited") },
                { id: "history", label: "Versions", onAction: () => {} },
                { id: "undo", label: "Undo", onAction: () => {}, disabled: true },
                { id: "forget", label: "Forget", onAction: () => setName(""), tone: "danger" },
              ]}
            />
          </div>
          <Switch label="Allow notifications" selected={notify} onChange={setNotify} />
          <Slider
            value={value}
            onChange={(next) => setValue(Array.isArray(next) ? (next[0] ?? 0) : next)}
            minValue={0}
            maxValue={100}
            aria-label="Daily capacity"
          >
            <div className="slider-heading">
              <Label>Daily capacity</Label>
              <Slider.Output />
            </div>
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
        </div>
        <Tabs defaultSelectedKey="day">
          <Tabs.ListContainer>
            <Tabs.List aria-label="Period">
              <Tabs.Tab id="day">
                1D
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="week">
                7D
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="month">
                1M
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="all">
                All
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel id="day">Today’s activity</Tabs.Panel>
          <Tabs.Panel id="week">This week’s activity</Tabs.Panel>
          <Tabs.Panel id="month">This month’s activity</Tabs.Panel>
          <Tabs.Panel id="all">All activity</Tabs.Panel>
        </Tabs>
        <Card className="action-card">
          <span className="muted">Actions</span>
          <Button variant="ghost" onClick={() => setStatus("New task selected")}>
            <Icon name="plus" />
            <span className="action-copy">
              New task<small>Create work for your team</small>
            </span>
          </Button>
          <Button variant="ghost" onClick={() => setStatus("Edit instructions selected")}>
            <Icon name="edit" />
            <span className="action-copy">
              Edit instructions<small>Keep your team up to date</small>
            </span>
          </Button>
          <div className="gallery-divider" />
          <span className="muted">Danger zone</span>
          <Button
            variant="danger-soft"
            onClick={() => setStatus("Delete example · no data removed")}
          >
            <Icon name="trash" />
            <span className="action-copy">
              Delete example<small>Remove this sample only</small>
            </span>
          </Button>
        </Card>
      </div>
      <div className="gallery-column">
        <div className="team-orbs" aria-label="Five team members">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span>+2</span>
        </div>
        <div className="button-examples">
          <h2>Every action has its place.</h2>
          <p className="muted">A clear hierarchy for every action.</p>
          <div className="button-row">
            <Button variant="primary" onClick={() => setStatus("Primary action clicked")}>
              Primary
            </Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="tertiary">Tertiary</Button>
          </div>
          <div className="button-row">
            <Button variant="destructive">Danger</Button>
            <Button variant="danger-soft">Danger soft</Button>
            <Button variant="ghost">Ghost</Button>
          </div>
          <div className="button-row">
            <Button variant="outline">Outline</Button>
            <Button disabled>Disabled</Button>
            <Button loading>Saving</Button>
          </div>
        </div>
        <Card className="profile-card">
          <div className="profile-heading">
            <span className="profile-icon">
              <BrandMark size={21} />
            </span>
            <div>
              <h2>
                Deskmates team{" "}
                <span className="verified-mark">
                  <Icon name="verified" size={18} />
                </span>
              </h2>
              <p className="muted">@your_workspace</p>
            </div>
          </div>
          <p>
            A shared computer.
            <br />A team that works with you.
          </p>
          <div className="button-row">
            <Pill tone="success" dot>
              Available
            </Pill>
            <Pill tone="info">3 teammates</Pill>
            <Pill tone="warning">1 decision</Pill>
          </div>
        </Card>
        <Card className="inline-card">
          <Icon name="info" />
          <div>
            <strong>Your brief is ready</strong>
            <p className="muted">Three findings, with sources.</p>
          </div>
          <Button variant="tertiary" onClick={() => setStatus("Brief opened in preview")}>
            Review
          </Button>
        </Card>
        <div className="notification-example">
          <Switch label="Notify when work is ready" selected={notify} onChange={setNotify} />
          <p className="muted">Keep up with your team’s progress.</p>
        </div>
      </div>
      <div className="gallery-column">
        <Card className="workspace-card">
          <span className="account-icon" aria-hidden="true">
            <Icon name="user" />
          </span>
          <h2>Your next workspace</h2>
          <p className="muted">
            One shared environment.
            <br />A place for your team to get started.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setStatus(
                name.trim() ? `Created “${name.trim()}” in preview` : "Created a sample workspace",
              );
            }}
          >
            <Button type="submit" variant="primary">
              Create workspace
            </Button>
          </form>
          <div className="or-divider">
            <span />
            OR
            <span />
          </div>
          <Button variant="tertiary" onClick={() => setStatus("Template selected in preview")}>
            Start from a template
          </Button>
          <Button variant="tertiary" onClick={() => setStatus("Existing workspace selected")}>
            Open a workspace
          </Button>
        </Card>
        <div className="mini-card-grid">
          <Card>
            <span className="mini-icon research">
              <Icon name="book" size={26} />
            </span>
            <h3>Research</h3>
            <p className="muted">3 teammates</p>
            <Pill tone="success" dot>
              Ready
            </Pill>
          </Card>
          <Card>
            <span className="mini-icon operations">
              <Icon name="settings" size={26} />
            </span>
            <h3>Operations</h3>
            <p className="muted">2 teammates</p>
            <Pill tone="info" dot>
              Working
            </Pill>
          </Card>
        </div>
        <Card className="changes-card">
          <span className="save-icon" aria-hidden="true">
            <Icon name="file" />
          </span>
          <h2>Unsaved changes</h2>
          <p className="muted">Save your changes to this preview?</p>
          <div className="button-row">
            <Button variant="tertiary" onClick={() => setStatus("Changes discarded in preview")}>
              Discard
            </Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={() => {
                setPending(true);
                window.setTimeout(() => {
                  setPending(false);
                  setStatus("Changes saved in preview");
                }, 900);
              }}
            >
              Save changes
            </Button>
          </div>
        </Card>
      </div>
      <output className="gallery-feedback">
        {status || "Try the controls. All changes stay in this preview."}
      </output>
    </div>
  );
}
function Workbench() {
  const [decision, setDecision] = useState<"pending" | "approved" | "denied">("pending");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("Atlas Research");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<Record<string, string[]>>({});
  const messages = sent[selected] ?? [];
  const conversations = [
    { name: "Atlas Research", detail: "A decision is ready for you", title: "Weekly research" },
    { name: "Market watch", detail: "Morning brief is ready", title: "Morning market brief" },
    { name: "Operations", detail: "All checks complete", title: "Workspace checks" },
  ] as const;
  const current = conversations.find((item) => item.name === selected) ?? conversations[0];
  return (
    <>
      <WorkspaceLayout
        className="workbench"
        title={current.title}
        subtitle={`${selected} · Updated just now`}
        navigationLabel="Conversations"
        actions={
          <Pill
            tone={selected === "Atlas Research" && decision === "pending" ? "warning" : "neutral"}
            dot
          >
            {selected === "Atlas Research" && decision === "pending" ? "Needs you" : "Ready"}
          </Pill>
        }
        sidebar={(close) => (
          <>
            <div className="rail-profile">
              <Avatar name="Jordan Ellis" />
              <div>
                <strong>Jordan Ellis</strong>
                <small>Studio workspace</small>
              </div>
            </div>
            <div className="rail-title">
              Conversations<Pill>3</Pill>
            </div>
            <Input
              aria-label="Find a conversation"
              placeholder="Find a conversation…"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
            <nav className="conversation-list" aria-label="Conversation list">
              {conversations
                .filter((item) => item.name.toLowerCase().includes(search.toLowerCase()))
                .map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    data-conversation
                    className={`conversation ${selected === item.name ? "selected" : ""}`}
                    aria-current={selected === item.name ? "page" : undefined}
                    onClick={() => {
                      setSelected(item.name);
                      close();
                    }}
                  >
                    <Avatar name={item.name} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.detail}</small>
                    </span>
                  </button>
                ))}
              {!conversations.some((item) =>
                item.name.toLowerCase().includes(search.toLowerCase()),
              ) && <p className="muted">No conversations found.</p>}
            </nav>
            <div className="rail-bottom">
              <Icon name="shield" size={18} /> Private workspace
            </div>
          </>
        )}
      >
        <ChatViewport
          conversationKey={selected}
          composer={
            <div className="sample-composer">
              <MessageComposer
                label={`Message ${selected}`}
                value={drafts[selected] ?? ""}
                onChange={(value) => setDrafts((previous) => ({ ...previous, [selected]: value }))}
                onSend={(body) =>
                  setSent((previous) => ({
                    ...previous,
                    [selected]: [...(previous[selected] ?? []), body],
                  }))
                }
                context={
                  <span className="composer-recipient">
                    <Avatar name={selected} size="sm" />
                    {selected}
                  </span>
                }
              />
              <small>Enter to send · Shift+Enter for a new line · Preview only</small>
            </div>
          }
        >
          <div className="chat-message-column">
            <div className="day-divider">
              TODAY <span>09:41</span>
            </div>
            {selected === "Atlas Research" ? (
              <>
                <div className="human-message">
                  Pull together this week’s findings and prepare a short update for the team.
                </div>
                <div className="agent-message">
                  <div className="message-byline">
                    <Avatar name="Atlas Research" size="sm" />
                    <strong>Atlas</strong>
                    <span>09:42</span>
                  </div>
                  <p>
                    The research is ready. I’ve pulled out three changes worth watching and linked
                    each one to its source.
                  </p>
                  <details className="report-preview">
                    <summary>
                      <span className="document-mark" aria-hidden="true">
                        <Icon name="file" />
                      </span>
                      <span>
                        <strong>Weekly research brief</strong>
                        <small>3 sources · 3 key findings</small>
                      </span>
                      <Pill tone="success">Draft ready</Pill>
                    </summary>
                    <p>A concise review of the signals, the evidence, and what to watch next.</p>
                    <ul>
                      <li>Three changes emerged across the reviewed sources.</li>
                      <li>The draft links each finding to its supporting evidence.</li>
                      <li>The team update is ready for your review before sending.</li>
                    </ul>
                  </details>
                  <p>The team update is drafted. Sending it needs your approval.</p>
                  <section className="approval-example" aria-label="Sample approval">
                    <div className="approval-title">
                      <span className="approval-symbol">
                        <Icon name="alert" size={18} />
                      </span>
                      <strong>Send the team update?</strong>
                    </div>
                    <p>Post the brief to the Research team channel.</p>
                    {decision === "pending" ? (
                      <div className="button-row">
                        <Button variant="primary" size="sm" onClick={() => setDecision("approved")}>
                          Allow once
                        </Button>
                        <Button size="sm" onClick={() => setDecision("denied")}>
                          Deny
                        </Button>
                      </div>
                    ) : (
                      <output>
                        <Pill tone={decision === "approved" ? "success" : "neutral"}>
                          {decision === "approved"
                            ? "Allowed · sample only"
                            : "Denied · sample only"}
                        </Pill>{" "}
                        <Button variant="ghost" size="sm" onClick={() => setDecision("pending")}>
                          Reset example
                        </Button>
                      </output>
                    )}
                  </section>
                </div>
                <details className="source-preview">
                  <summary>
                    3 sources <Icon name="chevron" size={16} />
                  </summary>
                  <ul>
                    <li>Weekly activity report · Sample document</li>
                    <li>Team notes · Sample document</li>
                    <li>Research log · Sample document</li>
                  </ul>
                </details>
              </>
            ) : (
              <div className="agent-message">
                <div className="message-byline">
                  <Avatar name={selected} size="sm" />
                  <strong>{selected}</strong>
                  <span>09:42</span>
                </div>
                <p>
                  {selected === "Market watch"
                    ? "Your morning brief is ready. This preview collects market headlines and the signals your team is following."
                    : "All workspace checks are complete. Your team’s shared environment is ready for the next task."}
                </p>
                <Pill tone="success">
                  {selected === "Market watch" ? "Brief ready" : "All checks passed"}
                </Pill>
              </div>
            )}
            {messages.map((body, i) => (
              <div className="human-message" key={`${i}-${body}`}>
                {body}
              </div>
            ))}
          </div>
        </ChatViewport>
      </WorkspaceLayout>
      <div className="studio-caption">
        <span>01 / CHAT COMPOSITION</span>
        <p>Room for the conversation. A quiet canvas. Decisions close to the work.</p>
      </div>
    </>
  );
}

function Foundations() {
  const colors = [
    ["Canvas", "canvas"],
    ["Surface", "surface"],
    ["Subtle", "soft"],
    ["Text", "text"],
    ["Muted", "muted"],
    ["Accent", "accent"],
  ];
  return (
    <div className="foundations">
      <Card>
        <div className="section-number">01 / PALETTE</div>
        <h2>Color palette</h2>
        <div className="swatch-grid">
          {colors.map(([name, token]) => (
            <div key={token}>
              <div className="swatch" style={{ background: `var(--gb-${token})` }} />
              <strong>{name}</strong>
              <code>--gb-{token}</code>
            </div>
          ))}
        </div>
        <div className="button-row">
          {(["success", "warning", "danger", "info"] as Tone[]).map((tone) => (
            <Pill key={tone} tone={tone} dot>
              {tone}
            </Pill>
          ))}
        </div>
      </Card>
      <Card>
        <div className="section-number">02 / TYPE</div>
        <div className="type-example display-type">Work, with a little more clarity.</div>
        <div className="type-example title-type">A useful update from your team</div>
        <div className="type-example body-type">
          Good interfaces make the next step easy to see. Keep the work readable, the state
          explicit, and the controls close to the decision.
        </div>
        <div className="type-example meta-type">UPDATED JUST NOW · RESEARCH WORKSPACE</div>
      </Card>
      <Card>
        <div className="section-number">03 / RHYTHM</div>
        <h2>Space with purpose</h2>
        <div className="spacing-grid">
          {[4, 8, 12, 16, 24, 32, 48].map((space) => (
            <div key={space}>
              <span style={{ width: space, height: space }} />
              <code>{space}px</code>
            </div>
          ))}
        </div>
        <p className="example-description">
          Use tight spacing within a group and larger spacing between ideas. Reserve elevation for
          surfaces that need it.
        </p>
      </Card>
    </div>
  );
}
