#!/usr/bin/env bun

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type JsonRecord = Record<string, unknown>;

interface SessionCandidate {
  sessionId: string;
  sessionDir: string;
  summaryPath: string;
  sortMs: number;
}

interface EventItem {
  index: number;
  seq: number | null;
  timestamp: string | null;
  timestampMs: number | null;
  type: string;
  raw: JsonRecord;
  offsetMs: number | null;
}

interface RunSummary {
  runId: string;
  mode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  success: boolean | null;
  mutationPlanLength: number | null;
  planContractValid: boolean | null;
}

interface ToolRow {
  seq: number | null;
  timestamp: string | null;
  tool: string;
  step: number | null;
  success: boolean | null;
  durationMs: number | null;
  planned: boolean | null;
  mutating: boolean | null;
  preview: string;
}

interface ViewModel {
  session: {
    sessionId: string;
    sessionDir: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    updatedAt: string | null;
    durationMs: number | null;
    eventCount: number | null;
    loggingEnabled: boolean | null;
    disabledReason: string | null;
    error: string | null;
    exitCode: number | null;
    cwd: string | null;
    argv: string[];
    agentName: string | null;
    provider: string | null;
    model: string | null;
  };
  metrics: {
    totalEvents: number;
    toolCalls: number;
    agentCalls: number;
    toolFailures: number;
    agentCallFailures: number;
    runFailures: number;
    replayFailures: number;
    sessionErrors: number;
    parseErrors: number;
    totalFailures: number;
    avgAgentCallDurationMs: number | null;
    maxAgentCallDurationMs: number | null;
  };
  toolStats: {
    successCount: number;
    failureCount: number;
    plannedCount: number;
    mutatingCount: number;
    avgDurationMs: number | null;
    maxDurationMs: number | null;
  };
  eventTypeCounts: Array<{ type: string; count: number }>;
  runs: RunSummary[];
  tools: ToolRow[];
  timeline: Array<{
    seq: number | null;
    timestamp: string | null;
    type: string;
    offsetMs: number | null;
    summary: string;
  }>;
  events: JsonRecord[];
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }

  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(item => typeof item === 'string');
}

function parseTimeMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function maybeDuration(startMs: number | null, endMs: number | null): number | null {
  if (startMs === null || endMs === null) {
    return null;
  }

  return Math.max(0, endMs - startMs);
}

function truncate(value: string, max = 140): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)}...`;
}

function summarizeEvent(type: string, raw: JsonRecord): string {
  if (type === 'tool.call.finish') {
    const tool = asString(raw.tool_name) ?? 'tool';
    const success = asBoolean(raw.success);
    const durationMs = asNumber(raw.duration_ms);
    const input = asRecord(raw.input);
    const output = asRecord(raw.output);
    const command = asString(input?.command) ?? asString(output?.command) ?? '';
    const result = success === undefined ? 'unknown' : success ? 'success' : 'failure';
    const duration = durationMs === undefined ? 'n/a' : `${Math.round(durationMs)}ms`;
    return `${tool} ${result} (${duration})${command ? ` ${truncate(command, 90)}` : ''}`;
  }

  if (type === 'tool.call.start') {
    const tool = asString(raw.tool_name) ?? 'tool';
    const input = asRecord(raw.input);
    const command = asString(input?.command);
    return command ? `${tool} ${truncate(command, 90)}` : tool;
  }

  if (type === 'agent.call.start') {
    const provider = asString(raw.provider) ?? 'unknown';
    const model = asString(raw.model) ?? 'unknown';
    const inputMessageCount = asNumber(raw.input_message_count);
    const continuation = asBoolean(raw.is_continuation);
    const details: string[] = [];
    if (inputMessageCount !== undefined) {
      details.push(`${inputMessageCount} input msg${inputMessageCount === 1 ? '' : 's'}`);
    }
    if (continuation === true) {
      details.push('continuation');
    }

    return `call started (${provider}/${model})${details.length > 0 ? ` - ${details.join(', ')}` : ''}`;
  }

  if (type === 'agent.call.finish') {
    const success = asBoolean(raw.success);
    const durationMs = asNumber(raw.duration_ms);
    const status = success === undefined ? 'completed' : success ? 'succeeded' : 'failed';
    const duration = durationMs === undefined ? 'n/a' : `${Math.round(durationMs)}ms`;
    const responseMessageCount = asNumber(raw.response_message_count);
    return `call ${status} (${duration})${responseMessageCount === undefined ? '' : ` ${responseMessageCount} response msg${responseMessageCount === 1 ? '' : 's'}`}`;
  }

  if (type === 'agent.run.finish') {
    const success = asBoolean(raw.success);
    const mode = asString(raw.mode) ?? 'unknown';
    const status = success === undefined ? 'completed' : success ? 'succeeded' : 'failed';
    return `run ${status} (${mode})`;
  }

  if (type === 'agent.run.start') {
    const mode = asString(raw.mode) ?? 'unknown';
    return `run started (${mode})`;
  }

  if (type === 'confirmation.decision') {
    return `confirmation: ${asString(raw.decision) ?? 'unknown'}`;
  }

  if (type === 'replay.finish') {
    const ok = asBoolean(raw.ok);
    return `replay finished: ${ok === undefined ? 'unknown' : ok ? 'ok' : 'failed'}`;
  }

  if (type === 'session.finish') {
    return `session finished: ${asString(raw.status) ?? 'unknown'}`;
  }

  return '';
}

function compareEvents(a: EventItem, b: EventItem): number {
  if (a.seq !== null && b.seq !== null && a.seq !== b.seq) {
    return a.seq - b.seq;
  }

  if (a.timestampMs !== null && b.timestampMs !== null && a.timestampMs !== b.timestampMs) {
    return a.timestampMs - b.timestampMs;
  }

  return a.index - b.index;
}

function buildModel(
  sessionId: string,
  sessionDir: string,
  summary: JsonRecord,
  rawEvents: JsonRecord[],
  parseErrors: number,
): ViewModel {
  const startedAt = asString(summary.started_at) ?? null;
  const endedAt = asString(summary.ended_at) ?? null;
  const updatedAt = asString(summary.updated_at) ?? null;
  const startedMs = parseTimeMs(startedAt ?? undefined);
  const endedMs = parseTimeMs(endedAt ?? undefined);

  const events: EventItem[] = rawEvents
    .map((raw, index) => {
      const timestamp = asString(raw.timestamp) ?? null;
      return {
        index,
        seq: asNumber(raw.seq) ?? null,
        timestamp,
        timestampMs: parseTimeMs(timestamp ?? undefined),
        type: asString(raw.type) ?? 'unknown',
        raw,
        offsetMs: null,
      };
    })
    .sort(compareEvents);

  const firstEventMs = events.find(event => event.timestampMs !== null)?.timestampMs ?? null;
  const baselineMs = startedMs ?? firstEventMs;

  for (const event of events) {
    event.offsetMs =
      event.timestampMs !== null && baselineMs !== null
        ? event.timestampMs - baselineMs
        : null;
  }

  const eventTypeCountMap = new Map<string, number>();
  const runMap = new Map<string, RunSummary>();
  const tools: ToolRow[] = [];
  const toolDurations: number[] = [];
  const agentCallDurations: number[] = [];
  let runFallback = 0;
  let toolFailures = 0;
  let agentCallStarts = 0;
  let agentCallFinishes = 0;
  let agentCallFailures = 0;
  let runFailures = 0;
  let replayFailures = 0;
  let sessionErrors = 0;

  for (const event of events) {
    eventTypeCountMap.set(event.type, (eventTypeCountMap.get(event.type) ?? 0) + 1);

    if (event.type === 'session.error') {
      sessionErrors += 1;
    }

    if (event.type === 'replay.finish' && asBoolean(event.raw.ok) === false) {
      replayFailures += 1;
    }

    if (event.type === 'agent.run.start' || event.type === 'agent.run.finish') {
      const runId = asString(event.raw.run_id) ?? `unknown-run-${runFallback++}`;
      const current = runMap.get(runId) ?? {
        runId,
        mode: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        success: null,
        mutationPlanLength: null,
        planContractValid: null,
      };

      if (event.type === 'agent.run.start') {
        current.mode = asString(event.raw.mode) ?? current.mode;
        current.startedAt = event.timestamp ?? current.startedAt;
      } else {
        current.mode = asString(event.raw.mode) ?? current.mode;
        current.finishedAt = event.timestamp ?? current.finishedAt;
        current.durationMs = asNumber(event.raw.duration_ms) ?? current.durationMs;
        current.success = asBoolean(event.raw.success) ?? current.success;
        current.mutationPlanLength =
          asNumber(event.raw.mutation_plan_length) ?? current.mutationPlanLength;
        current.planContractValid =
          asBoolean(event.raw.plan_contract_valid) ?? current.planContractValid;

        if (current.success === false) {
          runFailures += 1;
        }
      }

      runMap.set(runId, current);
    }

    if (event.type === 'tool.call.finish') {
      const tool = asString(event.raw.tool_name) ?? 'unknown';
      const success = asBoolean(event.raw.success) ?? null;
      const durationMs = asNumber(event.raw.duration_ms) ?? null;
      const step = asNumber(event.raw.step_number) ?? null;
      const input = asRecord(event.raw.input);
      const output = asRecord(event.raw.output);
      const command = asString(input?.command) ?? asString(output?.command) ?? asString(event.raw.summary) ?? '';
      const planned = asBoolean(output?.planned) ?? null;
      const mutating = asBoolean(output?.mutating) ?? null;

      tools.push({
        seq: event.seq,
        timestamp: event.timestamp,
        tool,
        step,
        success,
        durationMs,
        planned,
        mutating,
        preview: command ? truncate(command, 120) : '(no command/summary)',
      });

      if (success === false) {
        toolFailures += 1;
      }

      if (durationMs !== null) {
        toolDurations.push(durationMs);
      }
    }

    if (event.type === 'agent.call.start') {
      agentCallStarts += 1;
    }

    if (event.type === 'agent.call.finish') {
      agentCallFinishes += 1;
      const success = asBoolean(event.raw.success);
      const durationMs = asNumber(event.raw.duration_ms);

      if (success === false) {
        agentCallFailures += 1;
      }

      if (durationMs !== undefined) {
        agentCallDurations.push(durationMs);
      }
    }
  }

  const runs = Array.from(runMap.values()).sort((a, b) => {
    const aMs = parseTimeMs(a.startedAt ?? undefined) ?? Number.POSITIVE_INFINITY;
    const bMs = parseTimeMs(b.startedAt ?? undefined) ?? Number.POSITIVE_INFINITY;
    if (aMs !== bMs) {
      return aMs - bMs;
    }
    return a.runId.localeCompare(b.runId);
  });

  const eventTypeCounts = Array.from(eventTypeCountMap.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const durationSum = toolDurations.reduce((acc, value) => acc + value, 0);
  const avgDurationMs = toolDurations.length > 0 ? durationSum / toolDurations.length : null;
  const maxDurationMs = toolDurations.length > 0 ? Math.max(...toolDurations) : null;
  const agentCalls = agentCallStarts > 0 ? agentCallStarts : agentCallFinishes;
  const agentCallDurationSum = agentCallDurations.reduce((acc, value) => acc + value, 0);
  const avgAgentCallDurationMs =
    agentCallDurations.length > 0 ? agentCallDurationSum / agentCallDurations.length : null;
  const maxAgentCallDurationMs =
    agentCallDurations.length > 0 ? Math.max(...agentCallDurations) : null;

  const timeline = events.map(event => ({
    seq: event.seq,
    timestamp: event.timestamp,
    type: event.type,
    offsetMs: event.offsetMs,
    summary: summarizeEvent(event.type, event.raw),
  }));

  const totalFailures =
    toolFailures + agentCallFailures + runFailures + replayFailures + sessionErrors;

  return {
    session: {
      sessionId,
      sessionDir,
      status: asString(summary.status) ?? 'unknown',
      startedAt,
      endedAt,
      updatedAt,
      durationMs: maybeDuration(startedMs, endedMs),
      eventCount: asNumber(summary.event_count) ?? null,
      loggingEnabled: asBoolean(summary.logging_enabled) ?? null,
      disabledReason: asString(summary.disabled_reason) ?? null,
      error: asString(summary.error) ?? null,
      exitCode: asNumber(summary.exit_code) ?? null,
      cwd: asString(summary.cwd) ?? null,
      argv: asStringArray(summary.argv),
      agentName: asString(summary.agent_name) ?? null,
      provider: asString(summary.provider) ?? null,
      model: asString(summary.model) ?? null,
    },
    metrics: {
      totalEvents: events.length,
      toolCalls: tools.length,
      agentCalls,
      toolFailures,
      agentCallFailures,
      runFailures,
      replayFailures,
      sessionErrors,
      parseErrors,
      totalFailures,
      avgAgentCallDurationMs,
      maxAgentCallDurationMs,
    },
    toolStats: {
      successCount: tools.filter(tool => tool.success === true).length,
      failureCount: tools.filter(tool => tool.success === false).length,
      plannedCount: tools.filter(tool => tool.planned === true).length,
      mutatingCount: tools.filter(tool => tool.mutating === true).length,
      avgDurationMs,
      maxDurationMs,
    },
    eventTypeCounts,
    runs,
    tools,
    timeline,
    events: events.map(event => event.raw),
  };
}

function renderHtml(model: ViewModel): string {
  const dataJson = serializeForScript(model);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>cook session ${model.session.sessionId}</title>
  <style>
    :root {
      --bg: #f4f5f7;
      --surface: #ffffff;
      --text: #13161a;
      --muted: #5f6674;
      --border: #d7dde7;
      --accent: #135dd8;
      --good: #0f9d58;
      --bad: #d93025;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      color: var(--text);
      background:
        radial-gradient(circle at 0 0, #ebf1ff 0%, transparent 40%),
        radial-gradient(circle at 100% 0, #fff3e4 0%, transparent 40%),
        var(--bg);
    }

    .wrap {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      gap: 14px;
    }

    .panel {
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: 12px;
      padding: 14px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
    }

    .panel h2 {
      margin: 0 0 10px;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .status {
      display: inline-block;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px 9px;
      font-size: 12px;
      background: #f7f9fc;
    }

    .status.ok { color: var(--good); border-color: #b4e0c9; background: #eaf7f1; }
    .status.bad { color: var(--bad); border-color: #f0c1be; background: #fdeeed; }

    .muted { color: var(--muted); }

    .meta-grid,
    .cards {
      display: grid;
      gap: 8px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }

    .meta-item,
    .card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #fafbfd;
      padding: 8px;
    }

    .meta-key,
    .card-key {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 3px;
    }

    .card-value {
      font-size: 20px;
      font-weight: 700;
    }

    .chart-row { margin-bottom: 8px; }

    .chart-label {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin-bottom: 2px;
    }

    .bar {
      height: 8px;
      background: #e7edf6;
      border-radius: 999px;
      overflow: hidden;
    }

    .bar > span {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, #94b8ff, var(--accent));
    }

    .table-wrap {
      max-height: 360px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    th, td {
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--border);
      padding: 8px;
    }

    th {
      position: sticky;
      top: 0;
      background: #f0f4fb;
      z-index: 1;
    }

    .ok { color: var(--good); }
    .bad { color: var(--bad); }

    .timeline {
      max-height: 360px;
      overflow: auto;
      display: grid;
      gap: 6px;
    }

    .timeline-item {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #fafbfd;
      padding: 8px;
    }

    .timeline-head {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin-bottom: 4px;
      font-size: 12px;
    }

    .badge {
      display: inline-block;
      border: 1px solid #cad5ea;
      background: #edf3ff;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
    }

    details.raw {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #fafbfd;
      margin-bottom: 8px;
      overflow: hidden;
    }

    details.raw summary {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      padding: 8px;
    }

    .summary-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .toggle {
      border: 1px solid var(--border);
      background: white;
      border-radius: 6px;
      padding: 2px 6px;
      font-size: 11px;
      cursor: pointer;
    }

    pre {
      margin: 0;
      border-top: 1px solid var(--border);
      padding: 8px;
      background: #f8fbff;
      max-height: 280px;
      overflow: auto;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="panel" id="header"></section>
    <section class="panel" id="metrics"></section>
    <section class="panel" id="distribution"></section>
    <section class="panel" id="runs"></section>
    <section class="panel" id="tools"></section>
    <section class="panel" id="timeline"></section>
    <section class="panel" id="raw"></section>
  </main>

  <script id="payload" type="application/json">${dataJson}</script>
  <script>
    (function () {
      const payloadEl = document.getElementById('payload');
      if (!payloadEl || !payloadEl.textContent) {
        return;
      }

      const data = JSON.parse(payloadEl.textContent);
      const LARGE_KEYS = {
        prompt: true,
        system_prompt: true,
        full_instructions: true,
        stdout: true,
        stderr: true,
        body: true,
      };

      function esc(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function fmtDate(value) {
        if (!value) {
          return 'n/a';
        }
        const ms = Date.parse(value);
        if (!Number.isFinite(ms)) {
          return value;
        }
        return new Date(ms).toLocaleString();
      }

      function fmtDuration(ms) {
        if (ms === null || ms === undefined || !Number.isFinite(ms)) {
          return 'n/a';
        }
        if (ms < 1000) {
          return Math.round(ms) + 'ms';
        }
        const sec = ms / 1000;
        if (sec < 60) {
          return sec.toFixed(2) + 's';
        }
        const mins = Math.floor(sec / 60);
        const rem = sec % 60;
        return mins + 'm ' + rem.toFixed(1) + 's';
      }

      function fmtOffset(ms) {
        if (ms === null || ms === undefined || !Number.isFinite(ms)) {
          return '+n/a';
        }
        return (ms >= 0 ? '+' : '-') + fmtDuration(Math.abs(ms));
      }

      function yesNo(value) {
        if (value === true) {
          return '<span class="ok">yes</span>';
        }
        if (value === false) {
          return '<span class="bad">no</span>';
        }
        return '<span class="muted">n/a</span>';
      }

      function renderHeader() {
        const el = document.getElementById('header');
        if (!el) {
          return;
        }

        const status = data.session.status || 'unknown';
        const statusClass = status === 'success' ? 'ok' : status === 'failure' ? 'bad' : '';

        el.innerHTML =
          '<h2>Session</h2>' +
          '<div><strong>' + esc(data.session.sessionId) + '</strong> <span class="status ' + statusClass + '">' + esc(status) + '</span></div>' +
          '<div class="muted">' + esc(data.session.sessionDir) + '</div>' +
          '<div class="meta-grid" style="margin-top:8px">' +
            '<div class="meta-item"><div class="meta-key">Started</div><div>' + esc(fmtDate(data.session.startedAt)) + '</div></div>' +
            '<div class="meta-item"><div class="meta-key">Ended</div><div>' + esc(fmtDate(data.session.endedAt)) + '</div></div>' +
            '<div class="meta-item"><div class="meta-key">Duration</div><div>' + esc(fmtDuration(data.session.durationMs)) + '</div></div>' +
            '<div class="meta-item"><div class="meta-key">Agent</div><div>' + esc(data.session.agentName || 'n/a') + '</div></div>' +
            '<div class="meta-item"><div class="meta-key">Provider / Model</div><div>' + esc((data.session.provider || 'n/a') + ' / ' + (data.session.model || 'n/a')) + '</div></div>' +
            '<div class="meta-item"><div class="meta-key">Exit code</div><div>' + esc(data.session.exitCode === null ? 'n/a' : String(data.session.exitCode)) + '</div></div>' +
            '<div class="meta-item"><div class="meta-key">CWD</div><div>' + esc(data.session.cwd || 'n/a') + '</div></div>' +
            '<div class="meta-item"><div class="meta-key">ARGV</div><div>' + esc((data.session.argv || []).join(' ') || 'n/a') + '</div></div>' +
          '</div>';
      }

      function renderMetrics() {
        const el = document.getElementById('metrics');
        if (!el) {
          return;
        }

        el.innerHTML =
          '<h2>Metrics</h2>' +
          '<div class="cards">' +
            '<div class="card"><div class="card-key">Total events</div><div class="card-value">' + data.metrics.totalEvents + '</div></div>' +
            '<div class="card"><div class="card-key">Tool calls</div><div class="card-value">' + data.metrics.toolCalls + '</div></div>' +
            '<div class="card"><div class="card-key">Agent calls</div><div class="card-value">' + data.metrics.agentCalls + '</div></div>' +
            '<div class="card"><div class="card-key">Failures</div><div class="card-value">' + data.metrics.totalFailures + '</div></div>' +
            '<div class="card"><div class="card-key">Agent call failures</div><div class="card-value">' + data.metrics.agentCallFailures + '</div></div>' +
            '<div class="card"><div class="card-key">JSONL parse errors</div><div class="card-value">' + data.metrics.parseErrors + '</div></div>' +
            '<div class="card"><div class="card-key">Avg tool duration</div><div class="card-value">' + esc(fmtDuration(data.toolStats.avgDurationMs)) + '</div></div>' +
            '<div class="card"><div class="card-key">Max tool duration</div><div class="card-value">' + esc(fmtDuration(data.toolStats.maxDurationMs)) + '</div></div>' +
            '<div class="card"><div class="card-key">Avg agent call duration</div><div class="card-value">' + esc(fmtDuration(data.metrics.avgAgentCallDurationMs)) + '</div></div>' +
            '<div class="card"><div class="card-key">Max agent call duration</div><div class="card-value">' + esc(fmtDuration(data.metrics.maxAgentCallDurationMs)) + '</div></div>' +
            '<div class="card"><div class="card-key">Mutating tool calls</div><div class="card-value">' + data.toolStats.mutatingCount + '</div></div>' +
            '<div class="card"><div class="card-key">Planned tool calls</div><div class="card-value">' + data.toolStats.plannedCount + '</div></div>' +
          '</div>';
      }

      function renderDistribution() {
        const el = document.getElementById('distribution');
        if (!el) {
          return;
        }

        const rows = data.eventTypeCounts || [];
        if (rows.length === 0) {
          el.innerHTML = '<h2>Event Type Distribution</h2><div class="muted">No events found.</div>';
          return;
        }

        const max = rows[0].count || 0;
        const items = rows.map(row => {
          const width = max === 0 ? 0 : (row.count / max) * 100;
          return (
            '<div class="chart-row">' +
              '<div class="chart-label"><span>' + esc(row.type) + '</span><span>' + row.count + '</span></div>' +
              '<div class="bar"><span style="width:' + width.toFixed(2) + '%"></span></div>' +
            '</div>'
          );
        }).join('');

        el.innerHTML = '<h2>Event Type Distribution</h2>' + items;
      }

      function renderRuns() {
        const el = document.getElementById('runs');
        if (!el) {
          return;
        }

        const runs = data.runs || [];
        if (runs.length === 0) {
          el.innerHTML = '<h2>Runs</h2><div class="muted">No run events found.</div>';
          return;
        }

        const body = runs.map(run => (
          '<tr>' +
            '<td>' + esc(run.runId) + '</td>' +
            '<td>' + esc(run.mode || 'n/a') + '</td>' +
            '<td>' + esc(fmtDate(run.startedAt)) + '</td>' +
            '<td>' + esc(fmtDate(run.finishedAt)) + '</td>' +
            '<td>' + esc(fmtDuration(run.durationMs)) + '</td>' +
            '<td>' + yesNo(run.success) + '</td>' +
            '<td>' + esc(run.mutationPlanLength === null ? 'n/a' : String(run.mutationPlanLength)) + '</td>' +
            '<td>' + yesNo(run.planContractValid) + '</td>' +
          '</tr>'
        )).join('');

        el.innerHTML =
          '<h2>Runs</h2>' +
          '<div class="table-wrap"><table>' +
          '<thead><tr><th>Run ID</th><th>Mode</th><th>Start</th><th>Finish</th><th>Duration</th><th>Success</th><th>Mutation Plan Len</th><th>Plan Contract Valid</th></tr></thead>' +
          '<tbody>' + body + '</tbody></table></div>';
      }

      function renderTools() {
        const el = document.getElementById('tools');
        if (!el) {
          return;
        }

        const tools = data.tools || [];
        if (tools.length === 0) {
          el.innerHTML = '<h2>Tool Calls</h2><div class="muted">No tool.call.finish events found.</div>';
          return;
        }

        const body = tools.map(tool => {
          const success = tool.success === true
            ? '<span class="ok">success</span>'
            : tool.success === false
              ? '<span class="bad">failure</span>'
              : '<span class="muted">n/a</span>';

          return (
            '<tr>' +
              '<td>' + esc(tool.seq === null ? 'n/a' : String(tool.seq)) + '</td>' +
              '<td>' + esc(fmtDate(tool.timestamp)) + '</td>' +
              '<td>' + esc(tool.tool) + '</td>' +
              '<td>' + esc(tool.step === null ? 'n/a' : String(tool.step)) + '</td>' +
              '<td>' + success + '</td>' +
              '<td>' + esc(fmtDuration(tool.durationMs)) + '</td>' +
              '<td>' + yesNo(tool.planned) + '</td>' +
              '<td>' + yesNo(tool.mutating) + '</td>' +
              '<td>' + esc(tool.preview) + '</td>' +
            '</tr>'
          );
        }).join('');

        el.innerHTML =
          '<h2>Tool Calls</h2>' +
          '<div class="table-wrap"><table>' +
          '<thead><tr><th>Seq</th><th>Timestamp</th><th>Tool</th><th>Step</th><th>Success</th><th>Duration</th><th>Planned</th><th>Mutating</th><th>Command / Summary</th></tr></thead>' +
          '<tbody>' + body + '</tbody></table></div>';
      }

      function renderTimeline() {
        const el = document.getElementById('timeline');
        if (!el) {
          return;
        }

        const timeline = data.timeline || [];
        if (timeline.length === 0) {
          el.innerHTML = '<h2>Timeline</h2><div class="muted">No events found.</div>';
          return;
        }

        const rows = timeline.map(item => (
          '<div class="timeline-item">' +
            '<div class="timeline-head">' +
              '<span class="badge">' + esc(item.type) + '</span>' +
              '<span>seq: ' + esc(item.seq === null ? 'n/a' : String(item.seq)) + '</span>' +
              '<span>' + esc(fmtDate(item.timestamp)) + '</span>' +
              '<span class="muted">' + esc(fmtOffset(item.offsetMs)) + '</span>' +
            '</div>' +
            (item.summary ? '<div>' + esc(item.summary) + '</div>' : '') +
          '</div>'
        )).join('');

        el.innerHTML = '<h2>Timeline</h2><div class="timeline">' + rows + '</div>';
      }

      function cloneForDisplay(value, key, expanded, depth) {
        if (depth > 10) {
          return '[max depth reached]';
        }

        if (typeof value === 'string') {
          if (!expanded && LARGE_KEYS[key] && value.length > 500) {
            return value.slice(0, 500) + ' ... [truncated ' + (value.length - 500) + ' chars]';
          }

          if (!expanded && value.length > 2200) {
            return value.slice(0, 2200) + ' ... [truncated ' + (value.length - 2200) + ' chars]';
          }

          return value;
        }

        if (Array.isArray(value)) {
          return value.map(item => cloneForDisplay(item, '', expanded, depth + 1));
        }

        if (value && typeof value === 'object') {
          const out = {};
          Object.keys(value).forEach(childKey => {
            out[childKey] = cloneForDisplay(value[childKey], childKey, expanded, depth + 1);
          });
          return out;
        }

        return value;
      }

      function renderEscapedWhitespace(jsonText) {
        let output = '';
        let inString = false;
        let escaped = false;

        for (let i = 0; i < jsonText.length; i += 1) {
          const ch = jsonText[i];

          if (!inString) {
            output += ch;
            if (ch === '"') {
              inString = true;
            }
            continue;
          }

          if (escaped) {
            if (ch === 'n') {
              output += '\\n';
            } else if (ch === 't') {
              output += '\\t';
            } else if (ch === 'r') {
              output += '\\r';
            } else {
              output += '\\\\' + ch;
            }
            escaped = false;
            continue;
          }

          if (ch === '\\\\') {
            escaped = true;
            continue;
          }

          output += ch;
          if (ch === '"') {
            inString = false;
          }
        }

        if (escaped) {
          output += '\\\\';
        }

        return output;
      }

      function renderRaw() {
        const el = document.getElementById('raw');
        if (!el) {
          return;
        }

        el.innerHTML = '<h2>Raw Event Inspector</h2>';
        const events = data.events || [];

        if (events.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'muted';
          empty.textContent = 'No events found.';
          el.appendChild(empty);
          return;
        }

        events.forEach(event => {
          const details = document.createElement('details');
          details.className = 'raw';

          const summary = document.createElement('summary');
          const left = document.createElement('div');
          left.className = 'summary-left';

          const type = document.createElement('span');
          type.className = 'badge';
          type.textContent = String(event.type || 'unknown');
          left.appendChild(type);

          const seq = document.createElement('span');
          seq.textContent = 'seq: ' + String(event.seq === undefined ? 'n/a' : event.seq);
          left.appendChild(seq);

          const ts = document.createElement('span');
          ts.className = 'muted';
          ts.textContent = fmtDate(event.timestamp || null);
          left.appendChild(ts);

          summary.appendChild(left);

          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'toggle';
          toggle.textContent = 'Show more';
          summary.appendChild(toggle);

          const pre = document.createElement('pre');
          let expanded = false;

          function redraw() {
            const displayValue = cloneForDisplay(event, '', expanded, 0);
            const serialized = JSON.stringify(displayValue, null, 2);
            pre.textContent = renderEscapedWhitespace(serialized);
            toggle.textContent = expanded ? 'Show less' : 'Show more';
          }

          toggle.addEventListener('click', clickEvent => {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            expanded = !expanded;
            redraw();
          });

          redraw();
          details.appendChild(summary);
          details.appendChild(pre);
          el.appendChild(details);
        });
      }

      renderHeader();
      renderMetrics();
      renderDistribution();
      renderRuns();
      renderTools();
      renderTimeline();
      renderRaw();
    })();
  </script>
</body>
</html>`;
}

async function readJsonObject(filePath: string): Promise<JsonRecord> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const record = asRecord(parsed);
  if (!record) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }

  return record;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

async function readEvents(eventsPath: string): Promise<{ events: JsonRecord[]; parseErrors: number }> {
  try {
    const raw = await readFile(eventsPath, 'utf8');
    const lines = raw.split('\n');
    const events: JsonRecord[] = [];
    let parseErrors = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const record = asRecord(parsed);
        if (!record) {
          parseErrors += 1;
          continue;
        }

        events.push(record);
      } catch {
        parseErrors += 1;
      }
    }

    return { events, parseErrors };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { events: [], parseErrors: 0 };
    }

    throw error;
  }
}

async function listSessionCandidates(sessionsRoot: string): Promise<SessionCandidate[]> {
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new Error(`Sessions root not found: ${sessionsRoot}`);
    }

    throw error;
  }

  const result: SessionCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sessionId = entry.name;
    const sessionDir = path.join(sessionsRoot, sessionId);
    const summaryPath = path.join(sessionDir, 'session.json');

    let summaryStat;
    try {
      summaryStat = await stat(summaryPath);
    } catch {
      continue;
    }

    if (!summaryStat.isFile()) {
      continue;
    }

    let sortMs = summaryStat.mtimeMs;

    try {
      const summary = await readJsonObject(summaryPath);
      const startedMs = parseTimeMs(asString(summary.started_at));
      const updatedMs = parseTimeMs(asString(summary.updated_at));
      sortMs = startedMs ?? updatedMs ?? summaryStat.mtimeMs;
    } catch {
      // Keep mtime fallback if session.json is malformed.
    }

    result.push({
      sessionId,
      sessionDir,
      summaryPath,
      sortMs,
    });
  }

  result.sort((a, b) => {
    if (a.sortMs !== b.sortMs) {
      return b.sortMs - a.sortMs;
    }

    return b.sessionId.localeCompare(a.sessionId);
  });

  return result;
}

async function resolveTargets(sessionsRoot: string, target: string): Promise<SessionCandidate[]> {
  const candidates = await listSessionCandidates(sessionsRoot);

  if (candidates.length === 0) {
    throw new Error(`No valid sessions found in ${sessionsRoot}`);
  }

  if (target === 'all') {
    return candidates;
  }

  if (target === 'latest') {
    const latest = candidates[0];
    if (!latest) {
      throw new Error(`No valid sessions found in ${sessionsRoot}`);
    }

    return [latest];
  }

  const sessionDir = path.join(sessionsRoot, target);
  const summaryPath = path.join(sessionDir, 'session.json');

  try {
    const summaryStat = await stat(summaryPath);
    if (!summaryStat.isFile()) {
      throw new Error('not-file');
    }
  } catch {
    throw new Error(`Session "${target}" not found or missing session.json in ${sessionDir}`);
  }

  const existing = candidates.find(candidate => candidate.sessionId === target);
  if (existing) {
    return [existing];
  }

  return [{
    sessionId: target,
    sessionDir,
    summaryPath,
    sortMs: 0,
  }];
}

async function buildSessionHtml(target: SessionCandidate): Promise<string> {
  const summary = await readJsonObject(target.summaryPath);
  const eventsPath = path.join(target.sessionDir, 'events.jsonl');
  const { events, parseErrors } = await readEvents(eventsPath);
  const model = buildModel(target.sessionId, target.sessionDir, summary, events, parseErrors);
  const outputPath = path.join(target.sessionDir, 'session.html');
  await writeFile(outputPath, renderHtml(model), 'utf8');
  return outputPath;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter(arg => arg !== '--');

  if (args.length > 1) {
    console.error('Usage: bun run share -- [latest|all|<session_id>] (or bun run share:all)');
    return 1;
  }

  const target = args[0] ?? 'latest';
  const sessionsRoot = path.join(os.homedir(), '.cook', 'sessions');

  let resolved: SessionCandidate[];
  try {
    resolved = await resolveTargets(sessionsRoot, target);
  } catch (error) {
    console.error(`[share] ${formatError(error)}`);
    return 1;
  }

  let failures = 0;

  for (const candidate of resolved) {
    try {
      const outputPath = await buildSessionHtml(candidate);
      console.log(`${candidate.sessionId}: ${outputPath}`);
    } catch (error) {
      failures += 1;
      console.error(`[share] Failed for ${candidate.sessionId}: ${formatError(error)}`);
      if (target !== 'all') {
        return 1;
      }
    }
  }

  if (failures > 0) {
    console.error(`[share] Completed with ${failures} failure(s).`);
    return 1;
  }

  return 0;
}

const exitCode = await main();
process.exit(exitCode);
