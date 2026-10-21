import {
  CURSOR_MARKER,
  Input,
  SelectList,
  fuzzyFilter,
  getKeybindings,
  truncateToWidth,
  type Component,
  type Focusable,
  type SelectItem,
} from '@mariozechner/pi-tui';
import type { ModelOption } from '../model-catalog.ts';
import type { AgentProvider } from '../types.ts';
import { c, selectListTheme } from './theme.ts';

const MAX_VISIBLE = 10;

/**
 * Fuzzy search that ranks items containing every search term verbatim first,
 * so "opus 4.6" finds claude-opus-4.6 before claude-sonnet-4.6.
 */
export function searchItems<T>(items: T[], query: string, getText: (item: T) => string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = fuzzyFilter(items, query, getText);
  const verbatim = (item: T) => {
    const text = getText(item).toLowerCase();
    return terms.every(term => text.includes(term));
  };
  return [...matches.filter(verbatim), ...matches.filter(item => !verbatim(item))];
}

export interface PickerOptions {
  title: string;
  items?: SelectItem[];
  selected?: string;
  status?: string;
  /** When set, the typed query can be chosen as a value of its own. */
  customDescription?: (query: string) => string;
}

/** Fuzzy-searchable list: type to filter, arrows to move, enter to pick. */
export class Picker implements Component, Focusable {
  onSelect?: (value: string) => void;
  onCancel?: () => void;

  private readonly input = new Input();
  private items: SelectItem[] = [];
  private visibleItems: SelectItem[] = [];
  private list = new SelectList([], MAX_VISIBLE, selectListTheme);
  private status: string | undefined;
  private isFocused = false;

  constructor(private readonly options: PickerOptions) {
    this.status = options.status;
    this.setItems(options.items ?? [], options.selected);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  setItems(items: SelectItem[], selected?: string): void {
    this.items = items;
    this.refresh(selected ?? this.list.getSelectedItem()?.value);
  }

  setStatus(status: string | undefined): void {
    this.status = status;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.select.down')) {
      this.list.handleInput(data);
      return;
    }
    if (kb.matches(data, 'tui.select.confirm')) {
      const item = this.list.getSelectedItem();
      if (item) {
        this.onSelect?.(item.value);
      }
      return;
    }
    if (kb.matches(data, 'tui.select.cancel')) {
      this.onCancel?.();
      return;
    }

    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) {
      this.refresh();
    }
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }

  render(width: number): string[] {
    const lines = [truncateToWidth(c.bold(this.options.title), width), ...this.input.render(width)];
    if (this.status) {
      lines.push(truncateToWidth(c.dim(`  ${this.status}`), width));
    }
    if (this.visibleItems.length > 0) {
      lines.push(...this.list.render(width));
    } else if (!this.status) {
      lines.push(c.dim('  No matches'));
    }

    const hint = this.options.customDescription
      ? 'type to filter or enter any id · ↑↓ move · enter select · esc back'
      : 'type to filter · ↑↓ move · enter select · esc back';
    lines.push(truncateToWidth(c.dim(hint), width));
    return lines;
  }

  private refresh(selected?: string): void {
    const query = this.input.getValue().trim();
    const visible = searchItems(this.items, query, item => `${item.value} ${item.label}`);
    // Spaces separate search terms, so only a single token can be a custom value.
    const isCustom = query && !/\s/.test(query) && !this.items.some(item => item.value === query);
    if (isCustom && this.options.customDescription) {
      visible.push({ value: query, label: query, description: this.options.customDescription(query) });
    }

    this.visibleItems = visible;
    this.list = new SelectList(visible, MAX_VISIBLE, selectListTheme, {
      minPrimaryColumnWidth: 12,
      maxPrimaryColumnWidth: 48,
    });
    const index = selected ? visible.findIndex(item => item.value === selected) : -1;
    if (index >= 0) {
      this.list.setSelectedIndex(index);
    }
  }
}

export interface TextPromptOptions {
  title: string;
  initial?: string;
  hint?: string;
  secret?: boolean;
}

/** Single-line prompt; secret prompts render bullets instead of the value. */
export class TextPrompt implements Component, Focusable {
  onSubmit?: (value: string) => void;
  onCancel?: () => void;

  private readonly input = new Input();
  private isFocused = false;

  constructor(private readonly options: TextPromptOptions) {
    if (options.initial) {
      this.input.setValue(options.initial);
      this.input.handleInput('\x05'); // ctrl+e: start with the cursor at the end
    }
    this.input.onSubmit = value => this.onSubmit?.(value.trim());
    this.input.onEscape = () => this.onCancel?.();
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const lines = [truncateToWidth(c.bold(this.options.title), width)];
    if (this.options.secret) {
      const length = this.input.getValue().length;
      const mask = '•'.repeat(Math.min(length, Math.max(0, width - 3)));
      lines.push(`> ${mask}${this.isFocused ? CURSOR_MARKER : ''}\x1b[7m \x1b[27m`);
    } else {
      lines.push(...this.input.render(width));
    }
    lines.push(truncateToWidth(c.dim(this.options.hint ?? 'enter to save · esc to cancel'), width));
    return lines;
  }
}

export type ModelSelection = { provider: AgentProvider; model: string } | 'auto';

export interface ModelSelectorOptions {
  providers: SelectItem[];
  currentProvider: AgentProvider;
  currentModel: string;
  providerLabel: (provider: AgentProvider) => string;
  defaultModel: (provider: AgentProvider) => string;
  loadModels: (provider: AgentProvider) => Promise<ModelOption[]>;
  requestRender: () => void;
}

/** Two steps: pick a provider, then one of its models (fetched live). */
export class ModelSelector implements Component, Focusable {
  onSelect?: (selection: ModelSelection) => void;
  onCancel?: () => void;

  private readonly providerPicker: Picker;
  private stage: Picker;
  private isFocused = false;

  constructor(private readonly options: ModelSelectorOptions) {
    this.providerPicker = new Picker({
      title: 'Select provider',
      items: options.providers,
      selected: options.currentProvider,
    });
    this.providerPicker.onSelect = value => {
      if (value === 'auto') {
        this.onSelect?.('auto');
      } else {
        this.openModels(value as AgentProvider);
      }
    };
    this.providerPicker.onCancel = () => this.onCancel?.();
    this.stage = this.providerPicker;
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.stage.focused = value;
  }

  handleInput(data: string): void {
    this.stage.handleInput(data);
  }

  invalidate(): void {
    this.stage.invalidate();
  }

  render(width: number): string[] {
    return this.stage.render(width);
  }

  /** Jumps to the model step; esc from there returns to the provider list. */
  openModels(provider: AgentProvider): void {
    const { options } = this;
    const current = provider === options.currentProvider ? options.currentModel : undefined;
    const defaultModel = options.defaultModel(provider);
    const preferred = current ?? defaultModel;
    const picker = new Picker({
      title: `Select model · ${options.providerLabel(provider)}`,
      items: toModelItems([], current, defaultModel),
      selected: preferred,
      status: 'Loading models…',
      customDescription: () => 'use this model id',
    });
    picker.onSelect = model => this.onSelect?.({ provider, model });
    picker.onCancel = () => this.show(this.providerPicker);
    this.show(picker);

    options.loadModels(provider).then(
      models => {
        picker.setStatus(undefined);
        picker.setItems(toModelItems(models, current, defaultModel), preferred);
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        picker.setStatus(`${message.replace(/\.$/, '')}. Type any model id.`);
      },
    ).finally(options.requestRender);
  }

  private show(picker: Picker): void {
    this.stage.focused = false;
    this.stage = picker;
    picker.focused = this.isFocused;
    this.options.requestRender();
  }
}

export function toModelItems(
  models: ModelOption[],
  current: string | undefined,
  defaultModel: string,
): SelectItem[] {
  const listed = new Set(models.map(model => model.id));
  const pinned: SelectItem[] = [];
  const pin = (id: string | undefined, note: string) => {
    if (id && !listed.has(id)) {
      listed.add(id);
      pinned.push({ value: id, label: id, description: note });
    }
  };
  const unlisted = models.length > 0 ? ' · not in provider list' : '';
  pin(current, `current${unlisted}`);
  pin(defaultModel, `cook default${unlisted}`);

  return [
    ...pinned,
    ...models.map(model => ({
      value: model.id,
      label: model.id,
      description: model.id === current
        ? ['current', model.description].filter(Boolean).join(' · ')
        : model.description,
    })),
  ];
}
