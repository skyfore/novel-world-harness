import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export type UserQuestionOption<T extends string> = {
  value: T;
  label: string;
  description: string;
  recommended?: boolean;
};

export type UserQuestionCustomInput<T extends string> = {
  label: string;
  description: string;
  prompt: string;
  placeholder?: string;
  invalidMessage?: string;
  resolve: (input: string) => T | undefined | Promise<T | undefined>;
};

export type UserQuestion<T extends string> = {
  header: string;
  question: string;
  options: readonly UserQuestionOption<T>[];
  customInput?: UserQuestionCustomInput<T>;
  nonInteractiveHint?: string;
};

export type AskUserQuestion = <T extends string>(question: UserQuestion<T>) => Promise<T>;

export const askUserQuestion: AskUserQuestion = async <T extends string>(question: UserQuestion<T>): Promise<T> => {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(question.nonInteractiveHint
      ?? "Interactive decisions require a terminal. Re-run with --yes to accept every recommended choice.");
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\n${question.header}\n${question.question}\n`);
    question.options.forEach((option, index) => {
      stdout.write(`  ${index + 1}. ${option.label}${option.recommended ? " (recommended)" : ""}\n`);
      if (option.description) stdout.write(`     ${option.description}\n`);
    });
    if (question.customInput) {
      stdout.write(`  ${question.options.length + 1}. ${question.customInput.label}\n`);
      if (question.customInput.description) stdout.write(`     ${question.customInput.description}\n`);
    }
    while (true) {
      const answer = (await terminal.question("Choose an option: ")).trim();
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && question.options[index]) return question.options[index].value;
      if (question.customInput && index === question.options.length) {
        while (true) {
          const input = (await terminal.question(`${question.customInput.prompt}: `)).trim();
          const resolved = input ? await question.customInput.resolve(input) : undefined;
          if (resolved !== undefined) return resolved;
          stdout.write(`${question.customInput.invalidMessage ?? "That value does not match an available choice."}\n`);
        }
      }
      const maximum = question.options.length + Number(Boolean(question.customInput));
      stdout.write(`Enter a number from 1 to ${maximum}.\n`);
    }
  } finally {
    terminal.close();
  }
};

export function recommendedAnswer(): AskUserQuestion {
  return async <T extends string>(question: UserQuestion<T>): Promise<T> => {
    const recommended = question.options.find((option) => option.recommended) ?? question.options[0];
    if (!recommended) throw new Error(`Question '${question.header}' has no options.`);
    return recommended.value;
  };
}
