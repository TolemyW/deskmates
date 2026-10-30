import type { TaskJson, TaskOutputSchema } from "@deskmates/contracts";
import { useT } from "../../i18n/i18n-provider.js";

function Value({ value }: { value: TaskJson }) {
  if (Array.isArray(value))
    return (
      <ul>
        {value.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: immutable JSON array, no item identity or component state
          <li key={index}>
            <Value value={item} />
          </li>
        ))}
      </ul>
    );
  if (value !== null && typeof value === "object")
    return (
      <dl>
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{key.replaceAll("_", " ")}</dt>
            <dd>
              <Value value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return <span>{value === null ? "—" : String(value)}</span>;
}

/** Delivered data is readable before acceptance, rendered as inert text rather than HTML. */
export function TaskOutput({
  output,
  schema,
}: { output: TaskJson; schema: TaskOutputSchema | null }) {
  const t = useT();
  const properties = schema?.properties;
  const isCaveat = (key: string) =>
    ["open_issues", "outstanding", "limitations", "risks", "warnings"].includes(key);
  return (
    <section className="task-result" aria-label={t("tasks.output.label")}>
      <h3>{t("tasks.output.label")}</h3>
      <p className="muted small">{t("tasks.output.note")}</p>
      {output && !Array.isArray(output) && typeof output === "object" ? (
        <dl className="task-result-fields">
          {Object.entries(output)
            .sort(([a], [b]) => Number(isCaveat(b)) - Number(isCaveat(a)))
            .map(([key, value]) => {
              const field =
                properties && !Array.isArray(properties) && typeof properties === "object"
                  ? properties[key]
                  : undefined;
              const title =
                field && !Array.isArray(field) && typeof field === "object"
                  ? field.title
                  : undefined;
              const description =
                field && !Array.isArray(field) && typeof field === "object"
                  ? field.description
                  : undefined;
              const scalar = value === null || typeof value !== "object";
              return (
                <div
                  key={key}
                  className={`task-result-field${isCaveat(key) ? " task-warning" : ""}`}
                  data-kind={
                    typeof value === "number"
                      ? "number"
                      : scalar && String(value).length < 80 && !String(value).includes("\n")
                        ? "scalar"
                        : "detail"
                  }
                >
                  <dt>{typeof title === "string" ? title : key.replaceAll("_", " ")}</dt>
                  <dd>
                    <Value value={value} />
                  </dd>
                  {typeof description === "string" && description.trim() ? (
                    <dd className="task-result-description muted small">{description}</dd>
                  ) : null}
                </div>
              );
            })}
        </dl>
      ) : (
        <Value value={output} />
      )}
    </section>
  );
}
