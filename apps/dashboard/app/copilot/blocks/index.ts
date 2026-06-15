/* Domain blocks for the copilot's generative UI — one rich inline view per
   major capability, each deep-linking to its full page (the callback pattern).
   Rendered by app/copilot/UIBlock.tsx; payloads validated in lib/agent/ui-spec. */
export { CalendarWeekView } from "./CalendarWeekView";
export { StoryboardView } from "./StoryboardView";
export { RenderProgressView } from "./RenderProgressView";
export { InsightsChartView } from "./InsightsChartView";
export { BoostPreviewView } from "./BoostPreviewView";
export { GenomeView } from "./GenomeView";
export { InboxSummaryView } from "./InboxSummaryView";
export { CalendarMonthView } from "./CalendarMonthView";
export { PostCardView } from "./PostCardView";
export { ScorecardView } from "./ScorecardView";
export { TimelineView } from "./TimelineView";
export { AnnotateView } from "./AnnotateView";
export { BoardView } from "./BoardView";
export { JsonTreeView } from "./JsonTreeView";
/* widget blocks (v3) — small single-purpose ink-animated views, grouped by family */
export { SparklineView, DonutView, GaugeView, HeatmapView, FunnelView } from "./ChartBlocks";
export { MetricView, VerdictView, ChecklistView, QuoteView, BadgeRowView, RatingView } from "./StatBlocks";
export { CountdownView, SlotsView, MissionCardView, BudgetMeterView, GateView, DeviceCardView } from "./OpsBlocks";
export { HookLabView, ScriptLinesView, AbTestView, TrendTagsView, VoiceTrackView, PaletteView, PipelineView, DiffView } from "./ContentBlocks";
