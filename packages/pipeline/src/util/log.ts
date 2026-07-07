function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  info(message: string): void {
    console.log(`[${stamp()}] ${message}`);
  },
  warn(message: string): void {
    console.warn(`[${stamp()}] warn: ${message}`);
  },
  step(message: string): void {
    console.log(`\n[${stamp()}] == ${message} ==`);
  },
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
