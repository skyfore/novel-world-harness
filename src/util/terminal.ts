export function heading(value: string): void {
  console.log(`\n${value}`);
}

export function ok(value: string): void {
  console.log(`✓ ${value}`);
}

export function fail(value: string): void {
  console.error(`✗ ${value}`);
}
