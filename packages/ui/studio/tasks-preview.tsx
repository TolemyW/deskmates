import { useState } from "react";
import {
  Avatar,
  Button,
  Card,
  Icon,
  Input,
  MetricCard,
  Pill,
  WorkspaceLayout,
} from "../src/index.js";

const initialTasks = [
  {
    id: "TSK-024",
    title: "Prepare the weekly research brief",
    owner: "Atlas Research",
    status: "Review",
    due: "Today",
    description:
      "Review three findings and their supporting sources before sharing the brief with the team.",
  },
  {
    id: "TSK-023",
    title: "Collect the morning market signals",
    owner: "Market watch",
    status: "In progress",
    due: "Today",
    description: "Gather the latest updates and summarize the changes worth following.",
  },
  {
    id: "TSK-022",
    title: "Check the shared workspace",
    owner: "Operations",
    status: "Done",
    due: "Today",
    description: "Confirm that the shared environment is ready for the team’s next task.",
  },
  {
    id: "TSK-021",
    title: "Organize the research library",
    owner: "Atlas Research",
    status: "Planned",
    due: "Tomorrow",
    description: "Group the sample documents by topic and prepare a short index.",
  },
];
const filters = ["All tasks", "In progress", "Review", "Done"];
export function TasksPreview() {
  const [tasks, setTasks] = useState(initialTasks);
  const [filter, setFilter] = useState("All tasks");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const visible = tasks.filter(
    (task) =>
      (filter === "All tasks" || task.status === filter) &&
      `${task.title} ${task.owner}`.toLowerCase().includes(query.toLowerCase()),
  );
  const detail = tasks.find((task) => task.id === selected);
  return (
    <>
      <WorkspaceLayout
        title="Team tasks"
        subtitle="A clear view of what’s moving and what needs you."
        navigationLabel="Task views"
        className="task-workspace"
        actions={<Pill>Studio workspace</Pill>}
        sidebar={(close) => (
          <>
            <div className="rail-profile">
              <Avatar name="Jordan Ellis" />
              <div>
                <strong>Jordan Ellis</strong>
                <small>Studio workspace</small>
              </div>
            </div>
            <p className="nav-group-label">Workspace</p>
            <nav className="task-navigation" aria-label="Task filters">
              {filters.map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-current={filter === item ? "page" : undefined}
                  onClick={() => {
                    setFilter(item);
                    close();
                  }}
                >
                  <Icon
                    name={
                      item === "All tasks"
                        ? "tasks"
                        : item === "Done"
                          ? "check"
                          : item === "Review"
                            ? "alert"
                            : "clock"
                    }
                  />
                  <span>{item}</span>
                  <Pill>
                    {tasks.filter((task) => item === "All tasks" || task.status === item).length}
                  </Pill>
                </button>
              ))}
            </nav>
            <div className="rail-bottom">
              <Icon name="shield" size={18} /> Private workspace
            </div>
          </>
        )}
      >
        <div className="task-content">
          <div className="metrics-grid">
            <MetricCard
              label="Open tasks"
              value={tasks.filter((task) => task.status !== "Done").length}
              detail={<Pill>Across the team</Pill>}
            />
            <MetricCard
              label="Needs review"
              value={tasks.filter((task) => task.status === "Review").length}
              detail={<Pill tone="warning">Your attention</Pill>}
            />
            <MetricCard
              label="Completed"
              value={tasks.filter((task) => task.status === "Done").length}
              detail={<Pill tone="success">Ready</Pill>}
            />
          </div>
          <div className="task-list-heading">
            <h3>
              {filter} <Pill>{visible.length}</Pill>
            </h3>
            <div className="task-search">
              <Icon name="search" size={18} />
              <Input
                aria-label="Search tasks"
                placeholder="Search tasks…"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
          </div>
          <div className="task-table-scroll">
            <table className="task-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Due</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((task) => (
                  <tr key={task.id} data-selected={selected === task.id || undefined}>
                    <td>
                      <button
                        type="button"
                        className="task-title"
                        onClick={() => setSelected(task.id)}
                      >
                        <Icon name="file" />
                        <span>
                          <strong>{task.title}</strong>
                          <small>{task.id}</small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <span className="task-owner">
                        <Avatar name={task.owner} size="sm" />
                        {task.owner}
                      </span>
                    </td>
                    <td>
                      <Pill
                        tone={
                          task.status === "Done"
                            ? "success"
                            : task.status === "Review"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {task.status}
                      </Pill>
                    </td>
                    <td>{task.due}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visible.length === 0 && <p className="task-empty">No tasks match this view.</p>}
          {detail && (
            <Card className="task-detail">
              <div className="task-detail-heading">
                <span className="muted">{detail.id} · Task details</span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Close task details"
                  onClick={() => setSelected(null)}
                >
                  <Icon name="close" />
                </Button>
              </div>
              <h3>{detail.title}</h3>
              <p>{detail.description}</p>
              <div className="task-detail-footer">
                <span className="task-owner">
                  <Avatar name={detail.owner} />
                  {detail.owner}
                </span>
                <Button
                  variant={detail.status === "Done" ? "tertiary" : "primary"}
                  onClick={() =>
                    setTasks((previous) =>
                      previous.map((task) =>
                        task.id === detail.id
                          ? { ...task, status: task.status === "Done" ? "Planned" : "Done" }
                          : task,
                      ),
                    )
                  }
                >
                  <Icon name={detail.status === "Done" ? "clock" : "check"} />
                  {detail.status === "Done" ? "Reopen task" : "Mark complete"}
                </Button>
              </div>
            </Card>
          )}
          <p className="task-preview-note">Sample tasks · Changes stay in this preview.</p>
        </div>
      </WorkspaceLayout>
      <div className="studio-caption">
        <span>02 / TASK COMPOSITION</span>
        <p>Shared navigation. Readable lists. Details when you need them.</p>
      </div>
    </>
  );
}
