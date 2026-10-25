// =============================================================================
// lib/reportChartSpec.js: the chart fence contract FleetView renders on the
// Custom Reports page. One text, shared by the fleetview_report tool
// description and the system prompt addendum so they cannot drift.
// =============================================================================

/**
 * Chart fence instructions for report markdown.
 * @type {string}
 */
export const CHART_FENCE_GUIDE = [
  "Charts: when the data is a comparison or a trend (aged receivables by bucket, revenue by month, top clients), embed ONE or TWO charts, never more.",
  "A chart is a fenced code block whose language is chart and whose body is JSON:",
  "{\"type\": \"bar\" | \"line\" | \"pie\" | \"doughnut\", \"title\": string, \"labels\": [..], \"series\": [{\"name\": string, \"values\": [numbers]}], \"format\": \"money\" | \"number\" | \"percent\" (optional, default number), \"stacked\": boolean (optional)}.",
  "Use bar for category comparisons, line for time series, pie only when there are few labels.",
  "Values are plain numbers copied straight from tool data (1234.56, not \"$1,234.56\"), one value per label per series.",
  "Always keep a table alongside the chart so the exact numbers stay readable.",
].join(" ");
