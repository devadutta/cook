import type {
  EditorTheme,
  SelectListTheme,
  SettingsListTheme,
} from '@mariozechner/pi-tui';
import { createColors } from 'picocolors';

// The TUI only runs on a TTY, so colors are always on.
export const c = createColors(true);

export const selectListTheme: SelectListTheme = {
  selectedPrefix: text => c.cyan(text),
  selectedText: text => c.cyan(text),
  description: text => c.dim(text),
  scrollInfo: text => c.dim(text),
  noMatch: text => c.dim(text),
};

export const editorTheme: EditorTheme = {
  borderColor: text => c.dim(text),
  selectList: selectListTheme,
};

export const settingsListTheme: SettingsListTheme = {
  label: (text, selected) => (selected ? c.cyan(text) : text),
  value: (text, selected) => (selected ? c.cyan(text) : c.dim(text)),
  description: text => c.dim(text),
  cursor: c.cyan('→ '),
  hint: text => c.dim(text),
};
