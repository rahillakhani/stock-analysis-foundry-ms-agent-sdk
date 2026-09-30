/** Shown with every decision: this is a research tool, not investment advice. */
export function Disclaimer() {
  return (
    <p className="rounded-lg border border-border bg-surface-2 p-3 text-xs text-ink-2">
      <strong className="font-semibold text-ink">Not investment advice.</strong> Signals come from a fixed, documented
      rule set applied to the research data shown and can be wrong or out of date. Do your own research and consult a
      SEBI-registered adviser before investing.
    </p>
  );
}
