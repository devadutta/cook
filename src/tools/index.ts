import { createBashTool } from './bash.ts';
import { createEditTool } from './edit.ts';
import { createReadTool } from './read.ts';
import { createWriteTool } from './write.ts';
import type { ToolRuntime } from '../types.ts';

export function createToolSet(runtime: ToolRuntime) {
  return {
    Read: createReadTool(runtime),
    Write: createWriteTool(runtime),
    Edit: createEditTool(runtime),
    Bash: createBashTool(runtime),
  };
}
