// Phase 10 (10d.11): tables and charts in answers, for apps whose screen can
// show them. The asking app says so in POST /api/ask ("display": { "tables":
// true, "charts": true }); the rule is then added to every prompt that writes
// the reply (single agent, specialists, synthesizer, rework). Apps that do not
// ask, the web chat and the evals get exactly the prompts they had before.
//
// Tables are Markdown (any Markdown renderer shows them). A chart is a fenced
// ```chart block with JSON the app draws itself - one series ("value") or
// several ("series": ["Income", "Expense"]); the numbers stay in a table
// next to it, so a screen that cannot draw the chart still shows them.
//
// The model copies the figures from the data: eval:masjid compares every
// figure in a table or chart with what the app's API returned.
import { currentAccess } from "./appAccess.js";

export const CHART_TYPES = ["bar", "pie", "line"];

// From the request body: { tables?, charts? } -> { tables, charts }, or null
// when it is not that shape. Charts are only offered with tables.
export function parseDisplay(value) {
  if (value === undefined) return { tables: false, charts: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const k of Object.keys(value)) if (!["tables", "charts"].includes(k) || typeof value[k] !== "boolean") return null;
  return { tables: Boolean(value.tables || value.charts), charts: Boolean(value.charts) };
}

const TABLE_RULE =
  "\n\nThis reply is shown on a screen that displays Markdown tables. When the user asks for a table, or when " +
  "the reply lists 4 or more records that each have 2 or more values (for example a name, months and an " +
  "amount), put those records in a Markdown table: a header row, a | between columns, one record per row, " +
  "amounts as plain numbers with the unit in the header (\"Due (₹)\"). Write one short sentence before the " +
  "table; if amounts are added up, give the total in that sentence or as a last \"Total\" row. Copy every name " +
  "and number exactly as it is in the data - never round, estimate or add a record. For one or two facts, " +
  "answer in a sentence instead.";

const CHART_RULE =
  "\n\nThe screen can also draw a chart. Only when the user asks for a chart, graph, plot or diagram, add " +
  "after the table one block exactly like this, with the same figures as the table:\n" +
  "```chart\n" +
  '{"type": "bar", "title": "Pending dues by member", "unit": "₹", "data": [{"label": "Name", "value": 1200}]}\n' +
  "```\n" +
  `"type" is one of ${CHART_TYPES.join(", ")} (pie for parts of a whole, line for values over time, bar for ` +
  "anything else); \"value\" is a plain number; at most 24 items; labels in the reply's language. To compare " +
  "two to four values per label (income vs expense by month), replace \"value\" with \"series\": [\"Income\", " +
  "\"Expense\"] next to \"data\" and one number per name in each item: {\"label\": \"Jan 2026\", \"Income\": 52000, " +
  "\"Expense\": 38500} - 0 for a month with none. Without a request for a chart, write no chart block.";

// The rule for this request ("" for callers that did not ask).
export function displayRule(access = currentAccess()) {
  const d = access.display;
  if (!d?.tables) return "";
  return TABLE_RULE + (d.charts ? CHART_RULE : "");
}
