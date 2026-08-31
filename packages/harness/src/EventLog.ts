import type { ConfuciusEvent } from "@confucius/protocol";

export class MemoryEventLog {
  readonly events: ConfuciusEvent[] = [];

  append(event: ConfuciusEvent): void {
    this.events.push(event);
  }

  types(): ConfuciusEvent["type"][] {
    return this.events.map((event) => event.type);
  }
}
