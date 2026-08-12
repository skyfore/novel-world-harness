import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export type UserQuestionOption<T extends string> = {
  value: T;
  label: string;
  description: string;
  recommended?: boolean;
};

export type UserQuestion<T extends string> = {
  header: string;
  question: string;
  options: readonly UserQuestionOption<T>[];
};

export type AskUserQuestion = <T extends string>(question: UserQuestion<T>) => Promise<T>;

export const askUserQuestion: AskUserQuestion = async <T extends string>(question: UserQuestion<T>): Promise<T> => {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Interactive decisions require a terminal. Re-run with --yes to accept every recommended choice.");
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`\n${question.header}\n${question.question}\n`);
    question.options.forEach((option, index) => {
      stdout.write(`  ${index + 1}. ${option.label}${option.recommended ? " (recommended)" : ""}\n`);
      stdout.write(`     ${option.description}\n`);
    });
    while (true) {
      const answer = (await terminal.question("Choose an option: ")).trim();
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && question.options[index]) return question.options[index].value;
      stdout.write(`Enter a number from 1 to ${question.options.length}.\n`);
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
