import {
  Box,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  ProcessTerminal,
  SettingsList,
  Spacer,
  TUI,
  Text,
  TruncatedText,
  matchesKey,
  type AutocompleteItem,
  type Component,
  type SelectItem,
  type SettingItem,
  type SlashCommand,
} from '@mariozechner/pi-tui';
import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConfigFile } from '../config.ts';
import {
  getConfiguredApiKey,
  maskSecret,
  withAgentModel,
  withAgentOption,
  withApiKey,
  withDefaultAgent,
  withOption,
  withoutAgent,
} from '../config-edit.ts';
import {
  PROVIDERS,
  fetchProviderModels,
  getProviderInfo,
  type ModelOption,
  type ProviderInfo,
} from '../model-catalog.ts';
import { isBuiltInDefaultAgent } from '../portable-default.ts';
import type { AgentProvider, CookConfig, LoadedConfig, RuntimeConfig } from '../types.ts';
import { COOK_VERSION } from '../version.ts';
import {
  ModelSelector,
  Picker,
  TextPrompt,
  searchItems,
  type ModelSelection,
} from './components.ts';
import type { TuiHost } from './host.ts';
import {
  OPTION_SPECS,
  agentSource,
  optionSource,
  parseIntegerInput,
  parseListInput,
} from './settings.ts';
import { c, editorTheme, settingsListTheme } from './theme.ts';

type Scope = 'global' | 'local';

interface ConfigState {
  loaded: LoadedConfig;
  runtime: RuntimeConfig;
  files: Record<Scope, ConfigFile>;
  openaiOAuth: boolean;
}

export interface RunTuiOptions {
  cwd: string;
  host: TuiHost;
  homeDir?: string;
}

const BUILT_IN_COMMANDS: Array<{ name: string; usage: string; description: string }> = [
  { name: 'model', usage: '/model [provider] [id]', description: 'choose provider and model, or set them directly' },
  { name: 'agent', usage: '/agent [name]', description: 'switch the default agent, or create one' },
  { name: 'settings', usage: '/settings', description: 'steps, timeouts, confirmations, prompt files…' },
  { name: 'keys', usage: '/keys', description: 'save provider API keys to config' },
  { name: 'scope', usage: '/scope [global|local]', description: 'choose which config file changes go to' },
  { name: 'config', usage: '/config', description: 'show the effective config' },
  { name: 'login', usage: '/login [device]', description: 'sign in with ChatGPT' },
  { name: 'logout', usage: '/logout', description: 'remove the saved ChatGPT login' },
  { name: 'help', usage: '/help', description: 'show commands and keys' },
  { name: 'quit', usage: '/quit', description: 'exit cook' },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function completeFrom(values: string[], prefix: string): AutocompleteItem[] | null {
  const matches = values
    .filter(value => value.startsWith(prefix))
    .map(value => ({ value, label: value }));
  return matches.length > 0 ? matches : null;
}

export async function runTui(options: RunTuiOptions): Promise<string | undefined> {
  return new CookTui(options).run();
}

class CookTui {
  private readonly tui = new TUI(new ProcessTerminal());
  private readonly log = new Container();
  private readonly panel = new Container();
  private readonly footer = new Container();
  private readonly editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
  private readonly modelCache = new Map<AgentProvider, Promise<ModelOption[]>>();
  private readonly homeDir: string;
  private readonly host: TuiHost;
  private state!: ConfigState;
  private scope: Scope = 'global';
  private aliases: string[] = [];
  private activeList?: { items: SettingItem[]; build: () => SettingItem[] };
  private pendingWrite: Promise<void> = Promise.resolve();
  private loginInProgress = false;
  private finish: (instruction: string | undefined) => void = () => undefined;

  constructor(private readonly options: RunTuiOptions) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.host = options.host;
    this.editor.onSubmit = text => this.handleSubmit(text);
  }

  async run(): Promise<string | undefined> {
    [this.state, this.aliases] = await Promise.all([
      this.loadState(),
      this.host.listCommandAliases(this.options.cwd, this.homeDir),
    ]);
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(this.slashCommands(), this.options.cwd),
    );

    this.tui.addChild(new Text(
      `${c.bold('cook')} ${c.dim(`v${COOK_VERSION}`)}\n${c.dim('Set up cook with / commands, or type a task and press enter to run it.')}`,
      1,
      1,
    ));
    this.tui.addChild(this.log);
    this.tui.addChild(this.panel);
    this.tui.addChild(this.footer);
    this.tui.addInputListener(data => this.handleGlobalKey(data));
    this.addMessage(this.summary());
    this.showEditor();

    const done = new Promise<string | undefined>(resolve => {
      this.finish = resolve;
    });
    this.tui.start();
    const instruction = await done;

    // Collapse the editor so the task output starts right below the log.
    this.panel.clear();
    this.footer.clear();
    if (instruction) {
      this.addMessage(c.dim(`› ${instruction}`));
    }
    this.tui.requestRender();
    await Bun.sleep(32); // pi-tui throttles renders to 16ms; let the last frame flush
    this.tui.stop();
    return instruction;
  }

  // ── state ────────────────────────────────────────────────────────────

  private async loadState(): Promise<ConfigState> {
    const { cwd } = this.options;
    const paths = this.host.getConfigPaths(cwd, this.homeDir);
    const [loaded, openaiOAuth, global, local] = await Promise.all([
      this.host.loadConfig({ cwd, homeDir: this.homeDir }, {}),
      this.host.hasOpenAICodexCredentials(this.homeDir),
      this.host.readConfigFile(paths.global_path),
      this.host.readConfigFile(paths.local_path),
    ]);
    return {
      loaded,
      runtime: this.host.createRuntimeConfig(loaded.config, {}, { openaiOAuth }),
      files: { global, local },
      openaiOAuth,
    };
  }

  private scopePath(scope: Scope = this.scope): string {
    return scope === 'global' ? this.state.loaded.global_path : this.state.loaded.local_path;
  }

  private displayPath(filePath: string): string {
    const { cwd } = this.options;
    if (filePath.startsWith(cwd + path.sep)) {
      return `.${path.sep}${path.relative(cwd, filePath)}`;
    }
    if (filePath.startsWith(this.homeDir + path.sep)) {
      return `~${path.sep}${path.relative(this.homeDir, filePath)}`;
    }
    return filePath;
  }

  private isAutoAgent(state: ConfigState = this.state): boolean {
    const name = state.runtime.agent_name;
    const agent = state.loaded.config.agents[name];
    return Boolean(agent && isBuiltInDefaultAgent(name, agent));
  }

  private apiKeyFor(envName: string): string | undefined {
    return getConfiguredApiKey(this.state.loaded.config, envName) ?? process.env[envName];
  }

  private credentialStatus(info: ProviderInfo): string {
    if (info.provider === 'openai-codex') {
      return this.state.openaiOAuth ? 'signed in' : 'run /login';
    }
    const envName = info.credential_env;
    if (!envName) {
      return '';
    }
    if (getConfiguredApiKey(this.state.loaded.config, envName)) {
      return 'key in config';
    }
    return process.env[envName] ? `${envName} set` : `needs ${envName}`;
  }

  private loadModels(provider: AgentProvider): Promise<ModelOption[]> {
    let pending = this.modelCache.get(provider);
    if (!pending) {
      const envName = getProviderInfo(provider).credential_env;
      pending = fetchProviderModels(provider, {
        apiKey: envName ? this.apiKeyFor(envName) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      pending.catch(() => this.modelCache.delete(provider));
      this.modelCache.set(provider, pending);
    }
    return pending;
  }

  /**
   * Writes one edit to the config file for the current scope, then reloads.
   * If cook can no longer load its config afterwards, the file is restored.
   */
  private persist(
    summary: string,
    update: (file: ConfigFile) => ConfigFile,
    verify?: (state: ConfigState) => boolean,
  ): Promise<void> {
    const write = this.pendingWrite.then(() => this.persistNow(summary, update, verify));
    this.pendingWrite = write.catch(() => undefined);
    return write;
  }

  private async persistNow(
    summary: string,
    update: (file: ConfigFile) => ConfigFile,
    verify?: (state: ConfigState) => boolean,
  ): Promise<void> {
    const target = this.scopePath();
    const file = Bun.file(target);
    const previous = (await file.exists()) ? await file.text() : undefined;

    try {
      await this.host.updateConfigFile(target, update);
      this.state = await this.loadState();
    } catch (error) {
      if (previous === undefined) {
        await unlink(target).catch(() => undefined);
      } else {
        await Bun.write(target, previous);
      }
      this.addMessage(c.red(`✗ ${errorMessage(error).replace(`Invalid config at ${target}: `, '')}`));
      this.refreshViews();
      return;
    }

    this.addMessage(`${c.green('✓')} ${summary} ${c.dim(`→ ${this.displayPath(target)}`)}`);
    if (verify && !verify(this.state)) {
      const other = this.scopePath(this.scope === 'global' ? 'local' : 'global');
      const { runtime } = this.state;
      this.addMessage(c.yellow(
        `! cook still resolves to ${runtime.agent_name} · ${runtime.agent.provider} · ${runtime.agent.model} here` +
          (this.scope === 'global' ? `; ${this.displayPath(other)} takes precedence (/scope local)` : ''),
      ));
    }
    this.refreshViews();
  }

  // ── layout ───────────────────────────────────────────────────────────

  private addMessage(text: string): void {
    if (this.log.children.length > 0) {
      this.log.addChild(new Spacer(1));
    }
    this.log.addChild(new Text(text, 1, 0));
    this.tui.requestRender();
  }

  private showEditor(): void {
    this.activeList = undefined;
    this.panel.clear();
    this.panel.addChild(new Spacer(1));
    this.panel.addChild(this.editor);
    this.tui.setFocus(this.editor);
    this.refreshViews();
  }

  private showPanel(content: Component, focus: Component = content): void {
    const box = new Box(1, 0);
    box.addChild(content);
    this.panel.clear();
    this.panel.addChild(new Spacer(1));
    this.panel.addChild(box);
    this.tui.setFocus(focus);
    this.tui.requestRender();
  }

  private refreshViews(): void {
    const { runtime } = this.state;
    const model = `${runtime.agent.provider} · ${runtime.agent.model}${this.isAutoAgent() ? ' (auto)' : ''}`;
    this.footer.clear();
    this.footer.addChild(new TruncatedText(
      c.dim(`${runtime.agent_name}: ${model}  ·  saving to ${this.displayPath(this.scopePath())}  ·  ${this.displayPath(this.options.cwd)}`),
      1,
      0,
    ));

    if (this.activeList) {
      const fresh = this.activeList.build();
      for (const item of this.activeList.items) {
        const next = fresh.find(candidate => candidate.id === item.id);
        if (next) {
          item.currentValue = next.currentValue;
          item.description = next.description;
        }
      }
    }
    this.tui.requestRender();
  }

  private openList(
    title: string,
    build: () => SettingItem[],
    onChange: (id: string, value: string) => void,
  ): void {
    const items = build();
    const list = new SettingsList(items, 12, settingsListTheme, onChange, () => this.showEditor());
    const content = new Container();
    content.addChild(new Text(c.bold(title), 0, 0));
    content.addChild(list);
    this.showPanel(content, list);
    this.activeList = { items, build };
  }

  private summary(): string {
    const { runtime } = this.state;
    const auto = this.isAutoAgent();
    const label = (text: string) => c.dim(text.padEnd(9));
    return [
      `${label('agent')}${runtime.agent_name}${auto ? c.dim(' (auto: first provider with credentials)') : ''}`,
      `${label('model')}${runtime.agent.provider} · ${runtime.agent.model}`,
      `${label('config')}${this.displayPath(this.state.loaded.global_path)} ${c.dim('(global)')}  ${this.displayPath(this.state.loaded.local_path)} ${c.dim('(local)')}`,
    ].join('\n');
  }

  // ── input ────────────────────────────────────────────────────────────

  private handleGlobalKey(data: string): { consume: boolean } | undefined {
    if (this.panel.children.at(-1) !== this.editor) {
      return undefined;
    }
    if (matchesKey(data, 'ctrl+c')) {
      if (this.editor.getText()) {
        this.editor.setText('');
      } else {
        this.finish(undefined);
      }
      return { consume: true };
    }
    if (matchesKey(data, 'ctrl+d') && !this.editor.getText()) {
      this.finish(undefined);
      return { consume: true };
    }
    return undefined;
  }

  private slashCommands(): SlashCommand[] {
    const builtIns = new Set(BUILT_IN_COMMANDS.map(command => command.name));
    const completions: Record<string, (prefix: string) => Promise<AutocompleteItem[] | null> | AutocompleteItem[] | null> = {
      model: prefix => this.completeModel(prefix),
      agent: prefix => completeFrom(Object.keys(this.state.loaded.config.agents), prefix),
      scope: prefix => completeFrom(['global', 'local'], prefix),
      login: prefix => completeFrom(['device'], prefix),
    };

    return [
      ...BUILT_IN_COMMANDS.map(command => ({
        name: command.name,
        description: command.description,
        getArgumentCompletions: completions[command.name],
      })),
      ...this.aliases
        .filter(alias => !builtIns.has(alias))
        .map(alias => ({ name: alias, description: 'run your command' })),
    ];
  }

  /** Completes `/model [provider] [id]`; `prefix` is everything after `/model `. */
  private async completeModel(prefix: string): Promise<AutocompleteItem[] | null> {
    const spaceIndex = prefix.indexOf(' ');
    const providerName = spaceIndex === -1 ? undefined : prefix.slice(0, spaceIndex);
    const provider = providerName
      ? PROVIDERS.find(info => info.provider === providerName)?.provider
      : this.state.runtime.agent.provider;
    if (!provider) {
      return null;
    }

    const query = providerName ? prefix.slice(spaceIndex + 1) : prefix;
    const valuePrefix = providerName ? `${providerName} ` : '';
    const providers = providerName
      ? []
      : PROVIDERS
          .filter(info => info.provider.startsWith(query))
          .map(info => ({ value: info.provider, label: info.provider, description: info.label }));
    const models = await this.loadModels(provider).catch(() => []);
    const matches = searchItems(models, query, model => model.id).slice(0, 50);
    const items: AutocompleteItem[] = [
      ...providers,
      ...matches.map(model => ({
        value: `${valuePrefix}${model.id}`,
        label: model.id,
        description: model.description,
      })),
    ];
    // Enter accepts the highlighted completion, so keep an unlisted id reachable as typed.
    if (query && !models.some(model => model.id === query) && !providers.some(item => item.value === query)) {
      items.unshift({ value: prefix, label: query, description: 'as typed' });
    }
    return items.length > 0 ? items : null;
  }

  private handleSubmit(text: string): void {
    const input = text.trim();
    if (!input) {
      return;
    }
    this.editor.addToHistory(input);

    if (!input.startsWith('/')) {
      this.finish(input);
      return;
    }

    const [name = '', ...rest] = input.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch (name) {
      case 'model':
        this.handleModelCommand(arg);
        return;
      case 'agent':
        if (arg) {
          void this.switchAgent(arg);
        } else {
          this.openAgentPicker();
        }
        return;
      case 'settings':
        this.openSettings();
        return;
      case 'keys':
        this.openKeys();
        return;
      case 'scope':
        this.setScope(arg);
        return;
      case 'config':
        this.showConfig();
        return;
      case 'login':
        void this.login(arg === 'device');
        return;
      case 'logout':
        void this.logout();
        return;
      case 'help':
        this.showHelp();
        return;
      case 'quit':
      case 'exit':
        this.finish(undefined);
        return;
    }

    if (this.aliases.includes(name)) {
      this.finish(input);
      return;
    }
    this.addMessage(c.yellow(`Unknown command /${name}. Type /help to see commands.`));
  }

  // ── commands ─────────────────────────────────────────────────────────

  private createModelSelector(): ModelSelector {
    const { runtime } = this.state;
    const providers: SelectItem[] = PROVIDERS.map(info => ({
      value: info.provider,
      label: info.provider,
      description: [info.label, this.credentialStatus(info)].filter(Boolean).join(' · '),
    }));
    if (runtime.agent_name === 'default') {
      providers.unshift({
        value: 'auto',
        label: 'auto',
        description: 'built-in default: first provider with credentials',
      });
    }

    const selector = new ModelSelector({
      providers,
      currentProvider: runtime.agent.provider,
      currentModel: runtime.agent.model,
      providerLabel: provider => getProviderInfo(provider).label,
      defaultModel: provider => getProviderInfo(provider).default_model,
      loadModels: provider => this.loadModels(provider),
      requestRender: () => this.tui.requestRender(),
    });
    selector.focused = true;
    return selector;
  }

  private handleModelCommand(arg: string): void {
    const [first, ...rest] = arg.split(/\s+/).filter(Boolean);
    const provider = PROVIDERS.find(info => info.provider === first)?.provider;
    if (!first) {
      this.openModelSelector();
    } else if (provider && rest.length === 0) {
      this.openModelSelector(provider);
    } else if (provider) {
      void this.setModel(provider, rest.join(' '));
    } else {
      void this.setModel(this.state.runtime.agent.provider, arg);
    }
  }

  private openModelSelector(provider?: AgentProvider): void {
    const selector = this.createModelSelector();
    selector.onSelect = selection => {
      this.showEditor();
      void this.applyModel(selection);
    };
    selector.onCancel = () => this.showEditor();
    if (provider) {
      selector.openModels(provider);
    }
    this.showPanel(selector);
  }

  private applyModel(selection: ModelSelection): Promise<void> {
    if (selection !== 'auto') {
      return this.setModel(selection.provider, selection.model);
    }

    const name = this.state.runtime.agent_name;
    return this.persist(
      `${name} → auto (first provider with credentials)`,
      file => withoutAgent(file, name),
      state => this.isAutoAgent(state),
    );
  }

  private setModel(provider: AgentProvider, model: string): Promise<void> {
    if (/\s/.test(model)) {
      this.addMessage(c.yellow(`Model ids cannot contain spaces: "${model}". Usage: /model [provider] [id]`));
      return Promise.resolve();
    }

    const { runtime } = this.state;
    const name = runtime.agent_name;
    return this.persist(
      `${name} → ${provider} · ${model}`,
      file => withAgentModel(file, name, runtime.agent, provider, model),
      state =>
        state.runtime.agent_name === name &&
        state.runtime.agent.provider === provider &&
        state.runtime.agent.model === model,
    );
  }

  private createAgentPicker(): Picker {
    const { loaded, runtime } = this.state;
    const items = Object.entries(loaded.config.agents).map(([name, agent]) => ({
      value: name,
      label: name,
      description: isBuiltInDefaultAgent(name, agent) ? 'auto' : `${agent.provider} · ${agent.model}`,
    }));
    const picker = new Picker({
      title: 'Select default agent',
      items,
      selected: runtime.agent_name,
      customDescription: name => `create "${name}" as a copy of ${runtime.agent_name}`,
    });
    picker.focused = true;
    return picker;
  }

  private openAgentPicker(): void {
    const picker = this.createAgentPicker();
    picker.onSelect = name => {
      this.showEditor();
      void this.switchAgent(name);
    };
    picker.onCancel = () => this.showEditor();
    this.showPanel(picker);
  }

  private switchAgent(name: string): Promise<void> {
    const { loaded, runtime, files } = this.state;
    const existing = loaded.config.agents[name];
    const definedInFile = Boolean(files.global.agents?.[name] || files.local.agents?.[name]);
    // New agents start as a copy of the agent in use; the built-in one needs no copy.
    const copy = existing ? (definedInFile ? existing : undefined) : runtime.agent;
    return this.persist(
      existing
        ? `default agent → ${name}`
        : `created ${name} (${runtime.agent.provider} · ${runtime.agent.model}) as the default agent`,
      file => withDefaultAgent(file, name, copy),
      state => state.runtime.agent_name === name,
    );
  }

  private settingItems(): SettingItem[] {
    const { loaded, runtime, files } = this.state;
    const { config } = loaded;
    const agent = runtime.agent;
    const where = (source: string) => c.dim(`(set in: ${source})`);
    const agentWhere = where(agentSource(files, runtime.agent_name));
    const booleanValues = ['true', 'false'];

    return [
      {
        id: 'model',
        label: 'Model',
        currentValue: `${agent.provider} · ${agent.model}${this.isAutoAgent() ? ' (auto)' : ''}`,
        description: `Provider and model for agent "${runtime.agent_name}". ${agentWhere}`,
        submenu: (_value, done) => {
          const selector = this.createModelSelector();
          selector.onSelect = selection => {
            done();
            void this.applyModel(selection);
          };
          selector.onCancel = () => done();
          return selector;
        },
      },
      {
        id: 'default_agent',
        label: 'Default agent',
        currentValue: runtime.agent_name,
        description: `Agent used when --agent is not passed. ${where(optionSource(files, 'default_agent'))}`,
        submenu: (_value, done) => {
          const picker = this.createAgentPicker();
          picker.onSelect = name => {
            done();
            void this.switchAgent(name);
          };
          picker.onCancel = () => done();
          return picker;
        },
      },
      ...OPTION_SPECS.map(spec => ({
        id: spec.key,
        label: spec.label,
        currentValue: String(config[spec.key]),
        description: `${spec.description} ${where(optionSource(files, spec.key))}`,
        ...(spec.kind === 'boolean'
          ? { values: booleanValues }
          : { submenu: (value: string, done: (value?: string) => void) => this.textSubmenu(spec.label, value, done, 'empty resets to default') }),
      })),
      {
        id: 'raw_bash_output',
        label: 'Raw bash output',
        currentValue: String(agent.raw_bash_output),
        description: `Let the agent hand terminal output straight to you (agent "${runtime.agent_name}"). ${agentWhere}`,
        values: booleanValues,
      },
      {
        id: 'ignore_agents_md',
        label: 'Ignore AGENTS.md',
        currentValue: String(Boolean(agent.ignore_agents_md)),
        description: `Skip AGENTS.md and CLAUDE.md context files (agent "${runtime.agent_name}"). ${agentWhere}`,
        values: booleanValues,
      },
      {
        id: 'prompt_files.system',
        label: 'System prompt file',
        currentValue: agent.prompt_files?.system ?? '',
        description: `Custom system prompt file (agent "${runtime.agent_name}"). ${agentWhere}`,
        submenu: (value, done) => this.textSubmenu('System prompt file', value, done, 'path to a file · empty clears'),
      },
      {
        id: 'prompt_files.system_append',
        label: 'Append prompt files',
        currentValue: (agent.prompt_files?.system_append ?? []).join(', '),
        description: `Extra prompt files appended in order (agent "${runtime.agent_name}"). ${agentWhere}`,
        submenu: (value, done) => this.textSubmenu('Append prompt files', value, done, 'comma-separated paths · empty clears'),
      },
    ];
  }

  private textSubmenu(
    title: string,
    value: string,
    done: (value?: string) => void,
    hint: string,
  ): TextPrompt {
    const prompt = new TextPrompt({ title, initial: value, hint: `${hint} · enter to save · esc to cancel` });
    prompt.focused = true;
    prompt.onSubmit = next => done(next);
    prompt.onCancel = () => done();
    return prompt;
  }

  private openSettings(): void {
    this.openList('Settings', () => this.settingItems(), (id, value) => {
      void this.applySetting(id, value);
    });
  }

  private applySetting(id: string, value: string): Promise<void> {
    const spec = OPTION_SPECS.find(candidate => candidate.key === id);
    if (spec) {
      let parsed: CookConfig[typeof spec.key] | undefined;
      try {
        parsed = spec.kind === 'boolean' ? value === 'true' : parseIntegerInput(value);
      } catch (error) {
        this.addMessage(c.red(`✗ ${errorMessage(error)}`));
        this.refreshViews();
        return Promise.resolve();
      }
      return this.persist(
        `${spec.key} → ${parsed ?? 'default'}`,
        file => withOption(file, spec.key, parsed),
        state => parsed === undefined || state.loaded.config[spec.key] === parsed,
      );
    }

    const { runtime } = this.state;
    const name = runtime.agent_name;
    const agentEdit = (summary: string, update: (file: ConfigFile) => ConfigFile) =>
      this.persist(`${name}: ${summary}`, update);

    switch (id) {
      case 'raw_bash_output':
      case 'ignore_agents_md':
        return agentEdit(`${id} → ${value}`, file =>
          withAgentOption(file, name, runtime.agent, id, value === 'true'));
      case 'prompt_files.system':
        return agentEdit(`prompt_files.system → ${value || 'none'}`, file =>
          withAgentOption(file, name, runtime.agent, 'prompt_files', {
            ...runtime.agent.prompt_files,
            system: value || undefined,
          }));
      case 'prompt_files.system_append':
        return agentEdit(`prompt_files.system_append → ${value || 'none'}`, file =>
          withAgentOption(file, name, runtime.agent, 'prompt_files', {
            ...runtime.agent.prompt_files,
            system_append: parseListInput(value),
          }));
    }
    return Promise.resolve();
  }

  private keyItems(): SettingItem[] {
    return PROVIDERS.flatMap(info => {
      const envName = info.credential_env;
      if (!envName) {
        return [];
      }

      const configured = getConfiguredApiKey(this.state.loaded.config, envName);
      const fromEnv = process.env[envName];
      const currentValue = configured
        ? `config ${maskSecret(configured)}`
        : fromEnv
          ? `env ${maskSecret(fromEnv)}`
          : 'not set';

      return [{
        id: envName,
        label: envName,
        currentValue,
        description: `${info.label}. Saved keys override the environment variable; submit empty to remove.`,
        submenu: (_value: string, done: (value?: string) => void) => {
          const prompt = new TextPrompt({
            title: `${envName} → ${this.displayPath(this.scopePath())}`,
            secret: true,
            hint: 'paste the key · empty removes it · enter to save · esc to cancel',
          });
          prompt.focused = true;
          // done() without a value keeps the raw key out of the list's display.
          prompt.onSubmit = value => {
            done();
            void this.applyKey(envName, value);
          };
          prompt.onCancel = () => done();
          return prompt;
        },
      }];
    });
  }

  private openKeys(): void {
    this.openList('API keys', () => this.keyItems(), () => undefined);
  }

  private async applyKey(envName: string, value: string): Promise<void> {
    this.modelCache.clear();
    await this.persist(
      value ? `saved ${envName}` : `removed ${envName}`,
      file => withApiKey(file, envName, value || undefined),
    );
    if (value && this.scope === 'local') {
      this.addMessage(c.yellow(`! ${this.displayPath(this.scopePath())} is inside this project; keep it out of version control.`));
    }
  }

  private setScope(arg: string): void {
    if (arg === 'global' || arg === 'local') {
      this.scope = arg;
    } else if (!arg) {
      this.scope = this.scope === 'global' ? 'local' : 'global';
    } else {
      this.addMessage(c.yellow('Usage: /scope [global|local]'));
      return;
    }
    this.addMessage(`Saving changes to ${this.displayPath(this.scopePath())} (${this.scope})`);
    this.refreshViews();
  }

  private showConfig(): void {
    const { config, global_path, local_path } = this.state.loaded;
    const masked = structuredClone(config);
    if (masked.ai_gateway_api_key) {
      masked.ai_gateway_api_key = maskSecret(masked.ai_gateway_api_key);
    }
    for (const [envName, value] of Object.entries(masked.provider_api_keys ?? {})) {
      masked.provider_api_keys![envName] = maskSecret(value);
    }
    this.addMessage([
      c.dim(`defaults ← ${this.displayPath(global_path)} ← ${this.displayPath(local_path)}`),
      JSON.stringify(masked, null, 2),
    ].join('\n'));
  }

  private showHelp(): void {
    const width = Math.max(...BUILT_IN_COMMANDS.map(command => command.usage.length)) + 2;
    const lines = BUILT_IN_COMMANDS.map(command =>
      `${c.cyan(command.usage.padEnd(width))}${c.dim(command.description)}`);
    const custom = this.aliases.map(alias => `/${alias}`);
    if (custom.length > 0) {
      lines.push('', `${c.dim('your commands:')} ${custom.join(' ')}`);
    }
    lines.push(
      '',
      c.dim('Anything else runs as a cook task. Tab completes, ↑↓ browse history, ctrl+c clears or quits.'),
    );
    this.addMessage(lines.join('\n'));
  }

  private async login(deviceCode: boolean): Promise<void> {
    if (this.loginInProgress) {
      this.addMessage(c.yellow('A ChatGPT sign-in is already in progress.'));
      return;
    }

    this.loginInProgress = true;
    try {
      await this.host.loginOpenAICodex({
        deviceCode,
        browser: true,
        homeDir: this.homeDir,
        emit: message => this.addMessage(message),
      });
      this.state = await this.loadState();
      this.addMessage(`${c.green('✓')} Signed in to OpenAI with ChatGPT.`);
    } catch (error) {
      this.addMessage(c.red(`✗ ${errorMessage(error)}`));
    } finally {
      this.loginInProgress = false;
      this.refreshViews();
    }
  }

  private async logout(): Promise<void> {
    try {
      const removed = await this.host.logoutOpenAICodex(this.homeDir);
      this.state = await this.loadState();
      this.addMessage(removed ? `${c.green('✓')} Signed out of OpenAI.` : 'cook has no saved ChatGPT login.');
    } catch (error) {
      this.addMessage(c.red(`✗ ${errorMessage(error)}`));
    }
    this.refreshViews();
  }
}
