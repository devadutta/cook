import { Command } from 'commander';
import { EXIT_CODES } from './defaults.ts';
import { CliError } from './errors.ts';
import {
  getOpenAICodexLoginStatus,
  loginOpenAICodex,
  logoutOpenAICodex,
  OPENAI_CODEX_DEFAULT_MODEL,
} from './openai-oauth.ts';
import { printStderr } from './output.ts';

interface LoginFlags {
  deviceCode?: boolean;
  browser?: boolean;
}

function validateProvider(provider: string | undefined): void {
  if (provider && provider !== 'openai' && provider !== 'openai-codex') {
    throw new CliError(
      `Unsupported login provider "${provider}". Cook login currently supports: openai.`,
    );
  }
}

export async function runLoginCommand(argv: string[]): Promise<number> {
  if (argv[0] === 'status') {
    const provider = argv[1];
    validateProvider(provider);
    const status = await getOpenAICodexLoginStatus();
    printStderr(
      status.signedIn
        ? 'Signed in to OpenAI with ChatGPT.'
        : 'Not signed in to OpenAI. Run `cook login`.',
    );
    return status.signedIn ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
  }

  const program = new Command();
  program
    .name('cook login')
    .description('Sign in to OpenAI with your ChatGPT account')
    .argument('[provider]', 'Login provider (openai)', 'openai')
    .option(
      '--device-code',
      'Use the device-code flow for remote or headless environments',
    )
    .option('--no-browser', 'Print the login URL without opening a browser')
    .showHelpAfterError();

  program.parse(['bun', 'cook login', ...argv]);
  const provider = program.args[0];
  const flags = program.opts<LoginFlags>();
  validateProvider(provider);

  await loginOpenAICodex({
    deviceCode: Boolean(flags.deviceCode),
    browser: flags.browser !== false,
    emit: printStderr,
  });
  printStderr('Signed in to OpenAI with ChatGPT.');
  printStderr(
    `Cook will use ${OPENAI_CODEX_DEFAULT_MODEL} for its built-in default agent when no higher-priority API key is configured.`,
  );
  return EXIT_CODES.SUCCESS;
}

export async function runLogoutCommand(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name('cook logout')
    .description('Remove Cook\'s saved OpenAI login')
    .argument('[provider]', 'Login provider (openai)', 'openai')
    .showHelpAfterError();

  program.parse(['bun', 'cook logout', ...argv]);
  const provider = program.args[0];
  validateProvider(provider);

  const removed = await logoutOpenAICodex();
  printStderr(
    removed
      ? 'Signed out of OpenAI. Removed ~/.cook/auth.json.'
      : 'Cook has no saved OpenAI login.',
  );
  return EXIT_CODES.SUCCESS;
}
