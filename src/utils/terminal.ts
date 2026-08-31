import { performance } from "node:perf_hooks";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import pc from "picocolors";

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string | undefined;
}

const SPINNER_FRAMES = ["-", "\\", "|", "/"];
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";

interface KeypressKey {
  name?: string | undefined;
  ctrl?: boolean | undefined;
}

interface RenderState {
  hasRendered: boolean;
  lineCount: number;
}

export const canPrompt = (): boolean =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.CI !== "true");

export const formatElapsed = (milliseconds: number): string =>
  milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${Math.round(milliseconds)}ms`;

export const printBrandHeader = (
  version: string,
  details: Array<[string, string | number | undefined | null]>,
): void => {
  const width = 64;
  const border = "=".repeat(width);
  console.log(pc.green(border));
  console.log(`${pc.bold("Vue Doctor")} ${pc.dim(`v${version}`)}`);
  console.log(pc.dim("Vue-native diagnostics for agents, reviews, and CI."));
  for (const [label, value] of details) {
    if (value === undefined || value === null || value === "") continue;
    console.log(`${pc.dim(`${label}:`)} ${value}`);
  }
  console.log(pc.green(border));
  console.log("");
};

const canUseRawPrompt = (): boolean => canPrompt() && typeof input.setRawMode === "function";

const clearRenderedPrompt = (state: RenderState): void => {
  if (!state.hasRendered) {
    output.write("\n");
    return;
  }
  output.write(`\x1b[${state.lineCount}A\x1b[J`);
};

const renderChoicePrompt = <T extends string>(
  question: string,
  choices: Array<Choice<T>>,
  selectedIndex: number,
  state: RenderState,
): void => {
  clearRenderedPrompt(state);
  output.write(`${pc.bold(question)}\n`);
  choices.forEach((choice, index) => {
    const selected = index === selectedIndex;
    const marker = selected ? pc.green(">") : " ";
    const label = selected ? pc.bold(choice.label) : choice.label;
    const hint = choice.hint ? pc.dim(` - ${choice.hint}`) : "";
    output.write(`  ${marker} ${label}${hint}\n`);
  });
  output.write(`${pc.dim("Use arrow keys or j/k, Enter to select, Esc to cancel.")}\n`);
  state.hasRendered = true;
  state.lineCount = choices.length + 2;
};

const renderMultiChoicePrompt = <T extends string>(
  question: string,
  choices: Array<Choice<T>>,
  currentIndex: number,
  selectedValues: Set<T>,
  state: RenderState,
): void => {
  clearRenderedPrompt(state);
  output.write(`${pc.bold(question)}\n`);
  choices.forEach((choice, index) => {
    const selected = index === currentIndex;
    const marker = selected ? pc.green(">") : " ";
    const checkbox = selectedValues.has(choice.value) ? "[x]" : "[ ]";
    const label = selected ? pc.bold(choice.label) : choice.label;
    const hint = choice.hint ? pc.dim(` - ${choice.hint}`) : "";
    output.write(`  ${marker} ${checkbox} ${label}${hint}\n`);
  });
  output.write(
    `${pc.dim("Use arrow keys or j/k, Space to toggle, a to toggle all, Enter to confirm.")}\n`,
  );
  state.hasRendered = true;
  state.lineCount = choices.length + 2;
};

export const promptChoice = async <T extends string>(
  question: string,
  choices: Array<Choice<T>>,
  defaultValue: T,
): Promise<T> => {
  if (!canUseRawPrompt() || choices.length === 0) return defaultValue;

  let selectedIndex = Math.max(0, choices.findIndex((choice) => choice.value === defaultValue));
  const state: RenderState = { hasRendered: false, lineCount: 0 };
  const wasRaw = input.isRaw === true;

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write(CURSOR_HIDE);

  return new Promise<T>((resolve) => {
    const finish = (value: T): void => {
      input.off("keypress", onKeypress);
      if (!wasRaw) input.setRawMode(false);
      input.pause();
      output.write(CURSOR_SHOW);
      clearRenderedPrompt(state);
      const selected = choices.find((choice) => choice.value === value);
      output.write(`${pc.bold(question)} ${selected?.label ?? value}\n`);
      resolve(value);
    };

    const onKeypress = (_sequence: string, key: KeypressKey = {}): void => {
      if (key.ctrl && key.name === "c") {
        input.off("keypress", onKeypress);
        if (!wasRaw) input.setRawMode(false);
        input.pause();
        output.write(CURSOR_SHOW);
        clearRenderedPrompt(state);
        output.write("\n");
        process.exit(130);
      }

      if (key.name === "up" || key.name === "k") {
        selectedIndex = (selectedIndex - 1 + choices.length) % choices.length;
        renderChoicePrompt(question, choices, selectedIndex, state);
        return;
      }

      if (key.name === "down" || key.name === "j") {
        selectedIndex = (selectedIndex + 1) % choices.length;
        renderChoicePrompt(question, choices, selectedIndex, state);
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        finish(choices[selectedIndex]?.value ?? defaultValue);
        return;
      }

      if (key.name === "escape") {
        finish(defaultValue);
      }
    };

    input.on("keypress", onKeypress);
    renderChoicePrompt(question, choices, selectedIndex, state);
  });
};

export const promptConfirm = async (
  question: string,
  defaultValue: boolean,
): Promise<boolean> => {
  const selected = await promptChoice(
    question,
    [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
    defaultValue ? "yes" : "no",
  );
  return selected === "yes";
};

export const promptMultiChoice = async <T extends string>(
  question: string,
  choices: Array<Choice<T>>,
  defaultValues: T[],
): Promise<T[]> => {
  if (!canUseRawPrompt() || choices.length === 0) return defaultValues;

  let currentIndex = 0;
  const allowedDefaults = new Set(defaultValues);
  const selectedValues = new Set(
    choices.filter((choice) => allowedDefaults.has(choice.value)).map((choice) => choice.value),
  );
  const state: RenderState = { hasRendered: false, lineCount: 0 };
  const wasRaw = input.isRaw === true;

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write(CURSOR_HIDE);

  return new Promise<T[]>((resolve) => {
    const finish = (): void => {
      input.off("keypress", onKeypress);
      if (!wasRaw) input.setRawMode(false);
      input.pause();
      output.write(CURSOR_SHOW);
      clearRenderedPrompt(state);
      const selected = choices
        .filter((choice) => selectedValues.has(choice.value))
        .map((choice) => choice.label);
      output.write(`${pc.bold(question)} ${selected.length > 0 ? selected.join(", ") : "None"}\n`);
      resolve(choices.filter((choice) => selectedValues.has(choice.value)).map((choice) => choice.value));
    };

    const toggleCurrent = (): void => {
      const value = choices[currentIndex]?.value;
      if (!value) return;
      if (selectedValues.has(value)) {
        selectedValues.delete(value);
      } else {
        selectedValues.add(value);
      }
    };

    const toggleAll = (): void => {
      if (selectedValues.size === choices.length) {
        selectedValues.clear();
      } else {
        choices.forEach((choice) => selectedValues.add(choice.value));
      }
    };

    const onKeypress = (_sequence: string, key: KeypressKey = {}): void => {
      if (key.ctrl && key.name === "c") {
        input.off("keypress", onKeypress);
        if (!wasRaw) input.setRawMode(false);
        input.pause();
        output.write(CURSOR_SHOW);
        clearRenderedPrompt(state);
        output.write("\n");
        process.exit(130);
      }

      if (key.name === "up" || key.name === "k") {
        currentIndex = (currentIndex - 1 + choices.length) % choices.length;
        renderMultiChoicePrompt(question, choices, currentIndex, selectedValues, state);
        return;
      }

      if (key.name === "down" || key.name === "j") {
        currentIndex = (currentIndex + 1) % choices.length;
        renderMultiChoicePrompt(question, choices, currentIndex, selectedValues, state);
        return;
      }

      if (key.name === "space") {
        toggleCurrent();
        renderMultiChoicePrompt(question, choices, currentIndex, selectedValues, state);
        return;
      }

      if (key.name === "a") {
        toggleAll();
        renderMultiChoicePrompt(question, choices, currentIndex, selectedValues, state);
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        finish();
        return;
      }

      if (key.name === "escape") {
        selectedValues.clear();
        defaultValues.forEach((value) => selectedValues.add(value));
        finish();
      }
    };

    input.on("keypress", onKeypress);
    renderMultiChoicePrompt(question, choices, currentIndex, selectedValues, state);
  });
};

export const runProductStep = async <T>(
  label: string,
  task: () => Promise<T>,
  detail?: (result: T) => string | undefined,
): Promise<T> => {
  const start = performance.now();
  let frameIndex = 0;
  let timer: NodeJS.Timeout | null = null;

  if (process.stdout.isTTY) {
    process.stdout.write(`${SPINNER_FRAMES[0]} ${label}`);
    timer = setInterval(() => {
      frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
      process.stdout.write(`\r${SPINNER_FRAMES[frameIndex]} ${label}`);
    }, 80);
  } else {
    console.log(`- ${label}`);
  }

  try {
    const result = await task();
    if (timer) clearInterval(timer);
    const suffix = detail?.(result);
    const line = `${pc.green("OK")} ${label}${suffix ? pc.dim(` - ${suffix}`) : ""} ${pc.dim(`(${formatElapsed(performance.now() - start)})`)}`;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${line}\n`);
    } else {
      console.log(line);
    }
    return result;
  } catch (error) {
    if (timer) clearInterval(timer);
    const line = `${pc.red("x")} ${label} ${pc.dim(`(${formatElapsed(performance.now() - start)})`)}`;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${line}\n`);
    } else {
      console.log(line);
    }
    throw error;
  }
};
