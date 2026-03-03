import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionLogger } from '../src/session-logger.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('createSessionLogger', () => {
  it('writes session metadata and ordered JSONL events', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-session-logger-test-'));
    tempDirs.push(tempRoot);
    const homeDir = path.join(tempRoot, 'home');
    await mkdir(homeDir, { recursive: true });

    const logger = await createSessionLogger({
      cwd: '/tmp/workspace',
      argv: ['cook', 'summarize this repo'],
      agent_name: 'default',
      provider: 'gateway',
      model: 'openai/gpt-4.1-mini',
      homeDir,
      sessionId: 'session-test-1',
    });

    expect(logger.enabled).toBe(true);
    expect(logger.session_dir).toBe(path.join(homeDir, '.cook', 'sessions', 'session-test-1'));

    logger.logEvent('agent.run.start', {
      run_id: 'run-1',
      mode: 'execute',
      prompt: 'Task: summarize',
    });
    logger.logEvent('agent.call.start', {
      run_id: 'run-1',
      call_id: 'call-1',
      mode: 'execute',
      provider: 'gateway',
      model: 'openai/gpt-4.1-mini',
      prompt: 'Task: summarize',
      system_prompt: '[SYSTEM:path]\nstrict',
      full_instructions: 'base\n\n[SYSTEM:path]\nstrict',
      input_message_count: 1,
      continuation_message_count: 0,
      is_continuation: false,
    });
    logger.logEvent('tool.call.start', {
      run_id: 'run-1',
      mode: 'execute',
      prompt: 'Task: summarize',
      tool_name: 'Read',
      tool_call_id: 'tool-1',
      input: { path: 'README.md' },
    });
    logger.logEvent('tool.call.finish', {
      run_id: 'run-1',
      mode: 'execute',
      prompt: 'Task: summarize',
      tool_name: 'Read',
      tool_call_id: 'tool-1',
      input: { path: 'README.md' },
      success: true,
      output: { ok: true },
      duration_ms: 5,
    });
    logger.logEvent('agent.call.finish', {
      run_id: 'run-1',
      call_id: 'call-1',
      mode: 'execute',
      success: true,
      duration_ms: 25,
      response_message_count: 1,
      pending_approval_count: 0,
      text: 'summary',
    });

    await logger.finish('success', { exit_code: 0 });

    const eventsPath = path.join(logger.session_dir ?? '', 'events.jsonl');
    const summaryPath = path.join(logger.session_dir ?? '', 'session.json');
    const rawEvents = (await Bun.file(eventsPath).text()).trim();
    const events = rawEvents.split('\n').map(line => JSON.parse(line) as Record<string, unknown>);

    expect(events[0]?.type).toBe('session.start');
    expect(events[1]?.type).toBe('agent.run.start');
    expect(events[2]?.type).toBe('agent.call.start');
    expect(events[3]?.type).toBe('tool.call.start');
    expect(events[4]?.type).toBe('tool.call.finish');
    expect(events[5]?.type).toBe('agent.call.finish');
    expect(events[6]?.type).toBe('session.finish');
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const summary = JSON.parse(await Bun.file(summaryPath).text()) as Record<string, unknown>;
    expect(summary.status).toBe('success');
    expect(summary.exit_code).toBe(0);
    expect(summary.event_count).toBe(7);
    expect(summary.logging_enabled).toBe(true);
  });

  it('fails open when session directory initialization fails', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-session-logger-test-'));
    tempDirs.push(tempRoot);
    const homeDir = path.join(tempRoot, 'home');
    await mkdir(homeDir, { recursive: true });
    await Bun.write(path.join(homeDir, '.cook'), 'not-a-directory');

    const warnings: string[] = [];
    const logger = await createSessionLogger({
      cwd: '/tmp/workspace',
      argv: ['cook', 'summarize this repo'],
      agent_name: 'default',
      provider: 'gateway',
      model: 'openai/gpt-4.1-mini',
      homeDir,
      onWarning: message => warnings.push(message),
    });

    expect(logger.enabled).toBe(false);
    expect(warnings.some(message => message.includes('Failed to initialize session logger')))
      .toBe(true);

    logger.logEvent('session.error', { error: 'ignored' });
    await logger.finish('failure', { exit_code: 1 });
  });

  it('disables logging when event writes fail after initialization', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cook-session-logger-test-'));
    tempDirs.push(tempRoot);
    const homeDir = path.join(tempRoot, 'home');
    await mkdir(homeDir, { recursive: true });

    const warnings: string[] = [];
    const logger = await createSessionLogger({
      cwd: '/tmp/workspace',
      argv: ['cook', 'summarize this repo'],
      agent_name: 'default',
      provider: 'gateway',
      model: 'openai/gpt-4.1-mini',
      homeDir,
      sessionId: 'session-test-write-failure',
      onWarning: message => warnings.push(message),
    });

    expect(logger.enabled).toBe(true);

    const eventsPath = path.join(logger.session_dir ?? '', 'events.jsonl');
    await rm(eventsPath, { force: true });
    await mkdir(eventsPath, { recursive: true });

    logger.logEvent('agent.run.start', {
      run_id: 'run-2',
      mode: 'execute',
      prompt: 'Task: mutate',
    });

    await new Promise(resolve => setTimeout(resolve, 25));

    expect(logger.enabled).toBe(false);
    expect(warnings.some(message => message.includes('Failed to write session logs'))).toBe(true);

    await logger.finish('failure', { exit_code: 1 });
  });
});
